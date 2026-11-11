import { expect, test } from './fixtures.js'
import { ReportPage } from './pages/ReportPage.js'
import { shot } from './shot.js'

test('the top of the page opens the report, which says it measures, then shows what it measured', async ({ page, repositories }) => {
  await repositories.menu('Report').click()
  const report = new ReportPage(page)
  await expect(page).toHaveURL(/#report$/)
  await expect(report.state).toHaveText('Measuring the machine, which takes a few seconds…')
  await expect(report.age).toHaveText('Measuring…')
  await report.expectMeasured()
  await expect(report.age).toHaveText('Read just now')
  // The page is left and returned to without measuring again.
  const measured = await report.card('Memory').measure('RAM').textContent()
  await report.back()
  await expect(repositories.names.first()).toBeVisible()
  await repositories.menu('Report').click()
  await expect(report.card('Memory').measure('RAM')).toHaveText(measured ?? '')
  await expect(report.state).toHaveText(/^Measured /)
})

test('the report shows each thing measured with its sizes, and what to clean with its commands @layout', async ({ report }, testInfo) => {
  await expect(report.titles).toHaveText(['Windows disk', 'Memory', 'Docker', 'Journal', 'Repositories'])
  await expect(report.age).toHaveText('Read just now')
  await expect(report.summary).toHaveText('2 sections with something to clean')
  const disk = report.card('Windows disk')
  await expect(disk.card).toHaveClass(/todo/)
  await expect(disk.measure('C:')).toContainText('615.8 GB used of 1.0 TB, 406.3 GB free')
  await expect(disk.measure('Ubuntu disk image')).toContainText('352.5 GB')
  // A sentence of the advice is text, and only a command is drawn as one, each on its line.
  await expect(disk.advice).toHaveText(['Ubuntu uses 275.9 GB of an image of 352.5 GB on C:, so 76.6 GB come back once trimmed and compacted:', 'Then, from an administrator prompt on Windows:'])
  await expect(disk.commands).toHaveText(['sudo fstrim -av', 'wsl --shutdown', 'diskpart', /^select vdisk file=/, 'attach vdisk readonly', 'compact vdisk', 'detach vdisk', 'exit'])
  // A command longer than its card goes on under itself, and the card never scrolls sideways.
  expect(await disk.card.evaluate((card) => card.scrollWidth <= card.clientWidth)).toBe(true)
  await expect(disk.guide).toHaveAttribute('href', '#docs?name=cleanup&at=disk-image-compaction')
  await expect(report.card('Docker').advice).toHaveText('31.0 GB of images are unused, and removed with:')
  await expect(report.card('Docker').commands).toHaveText(['docker image prune -a --filter until=168h -f'])
  const memory = report.card('Memory')
  await expect(memory.card).not.toHaveClass(/todo/)
  // A short value sits where a size would, and a long one under its label.
  await expect(memory.sizes).toHaveText(['', '0 B used of 12.9 GB', '2.3 GB', '410.0 MB'])
  await expect(memory.card.locator('.measure-bar')).toHaveCount(2)
  // A lone size has nothing to be drawn against.
  await expect(report.card('Journal').card.locator('.measure-bar')).toHaveCount(0)
  await expect(memory.guide).toHaveCount(0)
  await expect(report.card('Repositories').labels).toHaveText(['3 repositories', '~/repos/chade', '~/repos/istarci', '~/repos/notes'])
  await shot(report.page, testInfo, 'report')
})

test('Refresh measures again, and the page reading itself again does not', async ({ page, report }) => {
  const ram = report.card('Memory').measure('RAM')
  const count = Number(/measured (\d+) time/.exec((await ram.textContent()) ?? '')?.[1])
  // A tab that comes back to the front reads the other pages again, and leaves the report as it was measured.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await report.measureAgain()
  await expect(ram).toContainText(`measured ${count + 1} times`)
  await expect(report.state).toHaveText(/^Measured /)
})

test('the report opened by its address names the machine at once, and without the address that signs in says how to sign in', async ({ page, server }) => {
  const report = new ReportPage(page)
  await page.goto(server.url.replace('#', '#report?'))
  await expect(page.locator('#machine')).toHaveText('E2E-PC')
  await expect(report.state).toHaveText('Measuring the machine, which takes a few seconds…')
  await report.expectMeasured()
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await expect(page.locator('#message')).toHaveText(/^Not signed in\./)
  await expect(report.titles).toHaveCount(0)
})
