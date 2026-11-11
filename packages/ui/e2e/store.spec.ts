import { expect, test } from './fixtures.js'
import { StorePage } from './pages/StorePage.js'
import { shot } from './shot.js'

const FIRST = 'E2E-PC: snapshot of windows, wsl-ubuntu, 2026-11-09 08:30'
const SECOND = 'E2E-PC: snapshot of windows, wsl-ubuntu, 2026-11-10 18:12'
const THIRD = 'E2E-PC: snapshot of windows, wsl-ubuntu, 2026-11-11 09:00'

test('the tab of the store counts its machines and opens its page, and the link back returns to the repositories', async ({ page, repositories }) => {
  await expect(repositories.storeTab).toHaveText('Store2')
  await expect(repositories.storeTab).toHaveAttribute('title', /^2 machines, last snapshot /)
  await repositories.storeTab.click()
  const store = new StorePage(page)
  await store.expectOpen()
  await expect(page).toHaveURL(/#store$/)
  await store.back()
  await expect(repositories.names.first()).toBeVisible()
})

test('the store opens on the machine of the run and its last snapshot, with what it changed under each system @layout', async ({ server, store }, testInfo) => {
  await expect(store.path).toHaveText(server.store)
  await expect(store.machines.locator('.branch-name')).toHaveText(['E2E-PC', 'OLD-LAPTOP'])
  await expect(store.machine('E2E-PC')).toHaveClass(/head/)
  await expect(store.machine('E2E-PC')).toHaveClass(/selected/)
  await expect(store.systems).toHaveText(['windows', 'wsl-ubuntu', 'linux'])
  // The snapshot of the other machine, made between two of this one, is not listed.
  await expect(store.snapshots.locator('.subject')).toHaveText([THIRD, SECOND, FIRST])
  await expect(store.snapshot(THIRD)).toHaveClass(/selected/)
  await expect(store.heading).toHaveText(THIRD)
  await expect(store.facts).toContainText('Compared with the snapshot of')
  await expect(store.view('Changes')).toHaveText('Changes3')
  await expect(store.groups).toHaveText(['wsl-ubuntu (3)'])
  await expect(store.files).toHaveText(['Dfiles/etc/docker/daemon.json−3', 'Mfiles/etc/wsl.conf+3', 'Ainventories/snap.txt+1'])
  await shot(store.page, testInfo, 'store')
})

test('a snapshot lists what it changed since the one before, and a file opens its changes in place of the snapshots @layout', async ({ page, store }, testInfo) => {
  await store.choose(SECOND)
  await expect(store.heading).toHaveText(SECOND)
  await expect(store.groups).toHaveText(['windows (1)', 'wsl-ubuntu (1)'])
  await store.openFile('.wslconfig')
  await expect(page).toHaveURL(/#store\?machine=E2E-PC&commit=[0-9a-f]{40}&file=/)
  await expect(store.history).toBeHidden()
  await expect(store.file.path).toHaveText('windows/files/C/Users/e2e/.wslconfig')
  await expect(store.file.removed).toHaveText(['memory=8GB'])
  await expect(store.file.added).toHaveText(['memory=12GB', 'swap=0'])
  await expect(store.files.filter({ hasText: '.wslconfig' })).toHaveClass(/selected/)
  await shot(store.page, testInfo, 'store-file-changes')
  // The file is part of the address, so it stays open when the page is loaded again.
  await page.reload()
  await expect(store.file.added).toHaveText(['memory=12GB', 'swap=0'])
  await store.openFile('apt-manual.txt')
  await expect(store.file.added).toHaveText(['jq'])
  await page.keyboard.press('Escape')
  await expect(store.history).toBeVisible()
  await expect(store.snapshot(SECOND)).toHaveClass(/selected/)
  // The back button of the browser returns to the file.
  await page.goBack()
  await expect(store.file.added).toHaveText(['jq'])
  await store.file.close()
  await expect(store.file.view).toBeHidden()
})

test('the first snapshot of a machine is compared with nothing, so every file is added', async ({ store }) => {
  await store.choose(FIRST)
  await expect(store.facts).toContainText('First snapshot of E2E-PC')
  await expect(store.view('Changes')).toHaveText('Changes5')
  await expect(store.groups).toHaveText(['windows (2)', 'wsl-ubuntu (3)'])
  await expect(store.files.locator('.status')).toHaveText(['A', 'A', 'A', 'A', 'A'])
})

test('Files lists every file the machine had at a snapshot, and one opens its content @layout', async ({ page, store }, testInfo) => {
  await store.show('Files')
  await expect(store.view('Files')).toHaveText('Files5')
  await expect(store.groups).toHaveText(['windows (2)', 'wsl-ubuntu (3)'])
  await expect(store.files).toHaveText(['files/C/Users/e2e/.wslconfig', 'inventories/winget.json', 'files/etc/wsl.conf', 'inventories/apt-manual.txt', 'inventories/snap.txt'])
  await store.openFile('apt-manual.txt')
  await expect(store.content).toHaveText(['curl', 'git', 'jq', 'vim'])
  await shot(store.page, testInfo, 'store-file-content')
  // Another snapshot keeps the view, and shows the file as it was then.
  await store.file.close()
  await store.choose(FIRST)
  await expect(store.view('Files')).toHaveAttribute('aria-selected', 'true')
  await expect(store.files).toHaveCount(5)
  await store.openFile('daemon.json')
  await expect(store.content).toHaveText(['{', '  "log-driver": "local"', '}'])
  await page.reload()
  await expect(store.content).toHaveText(['{', '  "log-driver": "local"', '}'])
})

test('another machine shows its own snapshots, and a file that is not text says so', async ({ store }) => {
  await store.chooseMachine('OLD-LAPTOP')
  await expect(store.snapshots.locator('.subject')).toHaveText(['OLD-LAPTOP: snapshot of linux, 2026-11-09 19:00'])
  await expect(store.facts).toContainText('First snapshot of OLD-LAPTOP')
  await expect(store.files).toHaveText(['Afiles/etc/hostname+1', 'Afiles/icon.bin'])
  await store.openFile('icon.bin')
  await expect(store.file.note).toHaveText('Binary file, not shown.')
  await store.show('Files')
  await store.openFile('icon.bin')
  await expect(store.file.note).toHaveText('Binary file, not shown.')
})

test('a snapshot the store does not hold is refused, in the panel of the snapshot', async ({ page, server }) => {
  const store = new StorePage(page)
  await page.goto(`${server.url.replace('#', '#store?')}&machine=E2E-PC&view=files&file=${encodeURIComponent('E2E-PC/../../README.md')}`)
  await expect(store.snapshots.first()).toBeHidden()
  await expect(store.file.note).toHaveText('E2E-PC/../../README.md is not a file of that snapshot')
})
