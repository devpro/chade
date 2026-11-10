import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'
import { shot } from './shot.js'

test('each system is a tab, with its repositories and how many have something to do @layout', async ({ page, repositories }, testInfo) => {
  await expect(repositories.machine).toHaveText('E2E-PC')
  await expect(repositories.tabs).toHaveText(['windows21', 'wsl-ubuntu97'])
  // The first system is shown until another is chosen.
  await expect(repositories.tab('windows')).toHaveAttribute('aria-selected', 'true')
  await expect(repositories.names).toHaveText(['local-only', 'portal'])
  await expect(repositories.summary).toHaveText('2 repositories, 1 without upstream')
  await expect(repositories.warnings).toHaveText([/wsl-ubuntu: the repository folder .*missing does not exist/])
  await shot(page, testInfo, 'windows')
})

test('a repository shows its branch, what there is to push and pull, and the state of its working tree @layout', async ({ page, repositories }, testInfo) => {
  await repositories.showSystem('wsl-ubuntu')
  await expect(repositories.names).toHaveText(['ahead', 'behind', 'clean', 'conflict', 'detached', 'dirty', 'group/feature', 'history', 'interrupted'])
  await expect(repositories.summary).toHaveText('9 repositories, 3 with changes, 3 ahead, 1 behind, 1 without upstream, 1 unreadable')

  const clean = repositories.repository('clean')
  await expect(clean.branch).toHaveText('main')
  await expect(clean.upstream).toHaveText('in sync')
  await expect(clean.workingTree).toHaveText('clean')
  await expect(clean.lastCommit).toHaveText('Start clean')
  await expect(clean.path).toHaveText(/wsl-ubuntu.clean$/)
  await expect(clean.row).toHaveClass('quiet')

  const ahead = repositories.repository('ahead')
  await expect(ahead.upstream).toHaveText('↑ 2')
  await expect(ahead.row).toHaveClass('info')
  // A commit subject is text, whatever it holds.
  await expect(ahead.lastCommit).toHaveText('Change the file, which <b>is not</b> markup')

  await expect(repositories.repository('behind').upstream).toHaveText('↓ 1')
  await expect(repositories.repository('dirty').workingTree).toHaveText('1 changed2 untracked')
  await expect(repositories.repository('dirty').row).toHaveClass('warn')
  await expect(repositories.repository('group/feature').branch).toHaveText('feature/never-pushed')
  await expect(repositories.repository('group/feature').upstream).toHaveText('no upstream')
  await expect(repositories.repository('detached').branch).toHaveText(/^detached at [0-9a-f]{7}$/)
  await expect(repositories.repository('conflict').workingTree).toHaveText('1 in conflict')
  await expect(repositories.repository('conflict').row).toHaveClass('bad')
  await expect(repositories.repository('interrupted').error).toContainText('not a git repository')
  await shot(page, testInfo, 'wsl-ubuntu')
})

test('the system chosen stays chosen when the page is loaded again', async ({ page, repositories }) => {
  await repositories.showSystem('wsl-ubuntu')
  await page.reload()
  await expect(repositories.tab('wsl-ubuntu')).toHaveAttribute('aria-selected', 'true')
  await expect(repositories.names).toHaveCount(9)
})

test('the filter keeps the repositories holding every word, and the checkbox those with something to do @layout', async ({ page, repositories }, testInfo) => {
  await repositories.showSystem('wsl-ubuntu')
  await repositories.onlyThoseWithSomethingToDo()
  await expect(repositories.names).toHaveText(['ahead', 'behind', 'conflict', 'dirty', 'group/feature', 'history', 'interrupted'])
  await shot(page, testInfo, 'something-to-do')
  await repositories.onlyThoseWithSomethingToDo(false)

  await repositories.filter('never GROUP')
  await expect(repositories.names).toHaveText(['group/feature'])
  await repositories.filter('nothing like this')
  await expect(repositories.names).toHaveCount(0)
  await expect(repositories.empty).toHaveText('No repository matches.')
  // The filter narrows the list, and the summary stays the one of the system.
  await expect(repositories.summary).toContainText('9 repositories')
})

test('a change made in a repository shows at the next read', async ({ repositories, server }) => {
  await repositories.showSystem('wsl-ubuntu')
  await expect(repositories.repository('clean').workingTree).toHaveText('clean')
  const file = join(server.root, 'wsl-ubuntu', 'clean', 'draft.txt')
  writeFileSync(file, 'not tracked\n')
  try {
    await repositories.refresh()
    await expect(repositories.repository('clean').workingTree).toHaveText('1 untracked')
    await expect(repositories.tab('wsl-ubuntu')).toHaveText('wsl-ubuntu98')
    await expect(repositories.age).toHaveText('Read just now')
  } finally {
    rmSync(file)
  }
  await repositories.refresh()
  await expect(repositories.repository('clean').workingTree).toHaveText('clean')
})

test('the page reads again by itself when its tab comes back to the front', async ({ page, repositories, server }) => {
  await repositories.showSystem('wsl-ubuntu')
  const file = join(server.root, 'wsl-ubuntu', 'clean', 'draft.txt')
  writeFileSync(file, 'not tracked\n')
  try {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(repositories.repository('clean').workingTree).toHaveText('1 untracked')
  } finally {
    rmSync(file)
  }
})

test('a server that stops answering leaves the repositories on the page, and says the read failed', async ({ page, repositories }) => {
  await page.route('**/api/state', (route) => route.abort())
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(repositories.age).toHaveText(/^No answer, last read /)
  await expect(repositories.names).toHaveCount(2)
  await page.unroute('**/api/state')
  await repositories.refresh()
  await expect(repositories.age).toHaveText('Read just now')
})
