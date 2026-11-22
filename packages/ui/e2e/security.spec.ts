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

test('the scan shows the malicious packages first, then each place by its worst finding, and what nothing uses with its command @layout', async ({ page, server }, testInfo) => {
  const security = new SecurityPage(page)
  await security.signIn(server.url)
  await expect(security.summary).toHaveText('1 malicious, 3 critical, 2 high, 9.5 GB unused')
  await expect(security.parts).toHaveText(['Malicious, removed rather than updated', 'Vulnerabilities, 5 place(s)', 'Unused, 9.5 GB', 'Scanners'])
  // Each malicious package with where it lies, the place to remove it from.
  const malicious = security.part(/^Malicious/).locator('tr')
  await expect(malicious.locator('.package')).toHaveText(['@zalastax/nolb-_extri 1.0.0'])
  await expect(malicious.locator('.place-label')).toHaveText(['~/repos/portal/node_modules'])
  // The most critical findings first, then the most high ones, and so on, a place with only a note last.
  await expect(security.part(/^Vulnerabilities/).locator('summary .place-label')).toHaveText([
    '~/repos/portal/node_modules',
    '~/repos/infra/.terraform',
    String.raw`%USERPROFILE%\AppData\Roaming\npm\node_modules`,
    '~/.nuget/packages',
    'registry:2',
  ])
  const portal = security.place(/^Vulnerabilities/, '~/repos/portal/node_modules')
  await expect(portal.badges).toHaveText(['1 malicious', '1 critical', '1 high', '1 medium'])
  await expect(portal.findings).toHaveCount(0)
  await portal.open()
  // The malicious package first, then by severity, each with its fix and a link to its advisory.
  await expect(portal.findings.locator('.package')).toHaveText(['@zalastax/nolb-_extri 1.0.0', 'next 15.3.2', 'lodash 4.17.15', 'lodash 4.17.15'])
  await expect(portal.findings.locator('.fix')).toHaveText(['no fix yet', 'fixed in 15.3.6', 'fixed in 4.17.21', 'fixed in 4.17.21'])
  // The scanners that found each, a malicious package being known to OSV alone.
  await expect(portal.findings.locator('.tools')).toHaveText(['osv-scanner', 'osv-scanner, trivy, grype', 'osv-scanner, trivy, grype', 'osv-scanner, trivy, grype'])
  await expect(portal.findings.first().getByRole('link', { name: 'MAL-2025-10000' })).toHaveAttribute('href', 'https://osv.dev/vulnerability/MAL-2025-10000')
  await expect(security.place(/^Vulnerabilities/, 'registry:2').notes).toHaveText(['alpine 3.18.12 is past its end of life, so its packages get no more fixes'])
  // The largest first, each with the command that removes it.
  await expect(security.unused.locator('.place-label')).toHaveText(['~/.nuget/packages', '~/repos/infra/.terraform', 'registry:2'])
  await expect(security.unused.locator('.size')).toHaveText(['9.1 GB', '412.0 MB', '25.4 MB'])
  await expect(security.unused.locator('code')).toHaveText(['dotnet nuget locals global-packages --clear', 'rm -rf /home/e2e/repos/infra/.terraform', 'docker image rm registry:2'])
  // Each system says which scanners read it, and which is missing.
  await expect(security.scanners).toHaveText([
    'wsl-ubuntu packagesosv-scanner 2.7.1trivy 0.76.2grype 0.122.1',
    'wsl-ubuntu imagesosv-scanner 2.7.1trivy 0.76.2grype 0.122.1',
    'windows packagesosv-scanner 2.7.0trivy 0.76.2grype: not installed',
  ])
  // The page never scrolls sideways, however long a path or a summary.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await shot(page, testInfo, 'security')
})

test('a tab shows one system, and the filter finds a place by its name, a package or an advisory', async ({ page, server }) => {
  const security = new SecurityPage(page)
  await security.signIn(server.url)
  await expect(security.tabs).toHaveText(['All5', 'wsl-ubuntu4', 'windows1'])
  await security.tab('windows').click()
  await expect(security.tab('windows')).toHaveAttribute('aria-selected', 'true')
  await expect(security.part(/^Vulnerabilities/).locator('summary .place-label')).toHaveText([String.raw`%USERPROFILE%\AppData\Roaming\npm\node_modules`])
  await expect(security.parts).toHaveText(['Vulnerabilities, 1 place(s)', 'Scanners'])
  await security.tab('All').click()
  await security.filter.fill('newtonsoft')
  await expect(security.part(/^Vulnerabilities/).locator('summary .place-label')).toHaveText(['~/.nuget/packages'])
  await security.filter.fill('GO-2026-6859')
  await expect(security.part(/^Vulnerabilities/).locator('summary .place-label')).toHaveText(['~/repos/infra/.terraform'])
  await security.filter.fill('registry')
  await expect(security.unused.locator('.place-label')).toHaveText(['registry:2'])
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
  const copy = security.unused.first().getByRole('button', { name: 'Copy dotnet nuget locals global-packages --clear' })
  await copy.click()
  await expect(copy).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('dotnet nuget locals global-packages --clear')
})
