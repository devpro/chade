import { expect, test } from './fixtures.js'
import { SecurityPage } from './pages/SecurityPage.js'
import { shot } from './shot.js'

test('the top of the page opens the security page, on the last scan', async ({ page, repositories }) => {
  await repositories.menu('Security').click()
  const security = new SecurityPage(page)
  await expect(page).toHaveURL(/#security$/)
  await expect(repositories.menu('Security')).toHaveAttribute('aria-current', 'page')
  await expect(security.state).toHaveText(/^Scanned /)
  await expect(page.locator('#scanned')).toHaveText('Read 2 hours ago')
})

test('the malicious packages show above a tab for each kind of place, each place by its worst finding, opened on its packages @layout', async ({ page, server }, testInfo) => {
  const security = new SecurityPage(page)
  await security.signIn(server.url)
  // Each malicious package with where it lies, the place to remove it from, whatever the tab.
  await expect(security.alert).toHaveText(['@zalastax/nolb-_extri 1.0.0MAL-2025-10000in ~/repos/portal/node_modules, wsl-ubuntu'])
  // The first tab with something to show, the scanners counting what is missing.
  await expect(security.tabs).toHaveText(['Repositories2', 'Installed1', 'Caches1', 'Images1', 'Scanners1'])
  await expect(security.tab('Repositories')).toHaveAttribute('aria-selected', 'true')
  await expect(security.levels).toHaveText(['malicious1', 'critical2', 'high1', 'medium1', 'low0', 'unknown1', 'unused1'])
  // The most critical findings first, the kind never repeated, the system said as several are listed.
  await expect(security.places.locator('summary .place-label')).toHaveText(['~/repos/portal/node_modules', '~/repos/infra/.terraform'])
  const portal = security.place('~/repos/portal/node_modules')
  await expect(portal.meta).toHaveText('wsl-ubuntu · 371 packages')
  await expect(portal.badges).toHaveText(['1 malicious', '1 critical', '1 high', '1 medium'])
  await expect(portal.packages).toHaveCount(0)
  await portal.open()
  // One row for each version of a package, the malicious one first, with what fixes it.
  await expect(portal.packages.locator('.package')).toHaveText(['@zalastax/nolb-_extri 1.0.0', 'next 15.3.2', 'lodash 4.17.15'])
  await expect(portal.packages.locator('.fix')).toHaveText(['remove it', 'update to 15.3.6', 'update to 4.17.21'])
  await expect(portal.packages.nth(2).locator('.advisory-line')).toHaveText(['highGHSA-35jh-r3h4-6jhmCommand Injection in lodash', 'mediumGHSA-29mw-wpgm-hmr9Regular Expression Denial of Service (ReDoS) in lodash'])
  // The scanners are named only when some missed the finding, a malicious package being known to OSV alone.
  await expect(portal.packages.locator('.tools')).toHaveText(['only osv-scanner'])
  await expect(portal.packages.first().getByRole('link', { name: 'MAL-2025-10000' })).toHaveAttribute('href', 'https://osv.dev/vulnerability/MAL-2025-10000')
  // A critical package in a place nothing uses is cleaned by removing the place, with its command.
  const infra = security.place('~/repos/infra/.terraform')
  await expect(infra.badges).toHaveText(['1 critical', '1 unknown', 'unused · 412.0 MB'])
  await infra.open()
  await expect(infra.clean).toHaveText('Nothing uses it: no commit, no change and no install for 94 days. Removing it ends its 2 finding(s), 412.0 MB.rm -rf /home/e2e/repos/infra/.terraformCopy')
  // The page never scrolls sideways, however long a path or a summary.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await shot(page, testInfo, 'security')
})

test('the images tab gives the notes of each image, and the scanners tab each scanner of each system', async ({ page, server }, testInfo) => {
  const security = new SecurityPage(page)
  await security.signIn(server.url)
  await security.tab('Images').click()
  const registry = security.place('registry:2')
  await expect(registry.notes).toHaveText(['alpine 3.18.12 is past its end of life, so its packages get no more fixes'])
  await expect(registry.badges).toHaveText(['1 medium', 'unused · 25.4 MB'])
  await registry.open()
  await expect(registry.clean.locator('code')).toHaveText('docker image rm registry:2')
  await shot(page, testInfo, 'security-images')
  await security.tab('Scanners').click()
  await expect(security.levels).toHaveCount(0)
  await expect(security.filter).toBeHidden()
  await expect(security.scanners).toHaveText([
    'wsl-ubuntu packagesosv-scanner 2.7.1trivy 0.76.2grype 0.122.1',
    'wsl-ubuntu imagesosv-scanner 2.7.1trivy 0.76.2grype 0.122.1',
    'windows packagesosv-scanner 2.7.0trivy 0.76.2grype: not installed',
  ])
})

test('the system, the levels, unused and the filter narrow the places', async ({ page, server }, testInfo) => {
  const security = new SecurityPage(page)
  await security.signIn(server.url)
  await security.system('windows').click()
  await expect(security.system('windows')).toHaveAttribute('aria-pressed', 'true')
  await expect(security.tabs).toHaveText(['Repositories0', 'Installed1', 'Caches0', 'Images0', 'Scanners1'])
  await expect(security.alert).toHaveCount(0)
  await security.tab('Installed').click()
  // One system listed, it is not said again on each place.
  await expect(security.place(String.raw`%USERPROFILE%\AppData\Roaming\npm\node_modules`).meta).toHaveText('748 packages')
  await security.system('All systems').click()
  await security.tab('Repositories').click()
  // The first level clicked shows it alone, the next ones add to it, and the last one taken away shows them all again.
  await security.level('critical').click()
  await expect(security.level('critical')).toHaveAttribute('aria-pressed', 'true')
  await expect(security.place('~/repos/portal/node_modules').badges).toHaveText(['1 critical'])
  await expect(security.tabs).toHaveText(['Repositories2', 'Installed1', 'Caches0', 'Images0', 'Scanners1'])
  await security.level('high').click()
  await security.tab('Caches').click()
  await expect(security.places.locator('summary .place-label')).toHaveText(['~/.nuget/packages'])
  await security.tab('Repositories').click()
  // A critical package nothing uses anymore.
  await security.levels.filter({ hasText: /^unused/ }).click()
  await expect(security.places.locator('summary .place-label')).toHaveText(['~/repos/infra/.terraform'])
  await shot(page, testInfo, 'security-filtered')
  await security.level('high').click()
  await security.level('critical').click()
  await expect(security.levels.and(page.locator('[aria-pressed="true"]'))).toHaveText(['unused1'])
  await security.levels.filter({ hasText: /^unused/ }).click()
  // The filter finds a place by its name, a package or an advisory, and keeps only the packages it names.
  await security.filter.fill('lodash')
  await expect(security.places.locator('summary .place-label')).toHaveText(['~/repos/portal/node_modules'])
  await security.place('~/repos/portal/node_modules').open()
  await expect(security.place('~/repos/portal/node_modules').packages.locator('.package')).toHaveText(['lodash 4.17.15'])
  await security.filter.fill('GO-2026-6859')
  await expect(security.places.locator('summary .place-label')).toHaveText(['~/repos/infra/.terraform'])
  await security.filter.fill('nothing like it')
  await expect(security.empty).toHaveText('Nothing here with these filters')
})

test('Scan reads the disk again behind the page, and says it is scanning until it is done', async ({ page, server }) => {
  const security = new SecurityPage(page)
  await security.signIn(server.url)
  await security.scan.click()
  await expect(security.state).toHaveText('Scanning the disk, which takes minutes…')
  await expect(security.scan).toBeDisabled()
  await expect(security.state).toHaveText(/^Scanned /)
  await expect(security.scan).toBeEnabled()
  await expect(page.locator('#scanned')).toHaveText('Read just now')
})

test('a command is copied whole', async ({ page, server, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const security = new SecurityPage(page)
  await security.signIn(server.url)
  const infra = security.place('~/repos/infra/.terraform')
  await infra.open()
  const copy = infra.clean.getByRole('button', { name: 'Copy rm -rf /home/e2e/repos/infra/.terraform' })
  await copy.click()
  await expect(copy).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('rm -rf /home/e2e/repos/infra/.terraform')
})
