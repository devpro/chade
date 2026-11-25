import { join } from 'node:path'
import { expect, test } from './fixtures.js'
import { RepositoryPage } from './pages/RepositoryPage.js'
import { UpdatesPage } from './pages/UpdatesPage.js'
import { shot } from './shot.js'

test('the packages with a newer version show at once, those that fix a vulnerability first @layout', async ({ page, server }, testInfo) => {
  const updates = new UpdatesPage(page)
  await updates.signIn(server.url)
  await expect(updates.tabs).toHaveText(['Packages2', 'Images1', 'Tools2', 'Unknown1'])
  await expect(updates.updates.locator('.place-label')).toHaveText(['lodash', 'typescript'])
  const lodash = updates.update('lodash')
  await expect(lodash.locator('summary .badge')).toHaveText(['fixes 2 vulnerabilities', 'patch'])
  await lodash.locator('summary').click()
  await expect(lodash.locator('.uses a')).toHaveText(['clean', 'history'])
  await expect(lodash.locator('.uses code')).toHaveText(['npm install lodash@4.17.21', 'npm install lodash@4.17.21'])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await shot(page, testInfo, 'updates-packages')
  await updates.chip('major').click()
  await expect(updates.updates.locator('.place-label')).toHaveText(['typescript'])
  // The address keeps the filter, so a reload shows the same.
  await expect(page).toHaveURL(/tab=packages&change=major$/)
  await page.reload()
  await expect(updates.updates.locator('.place-label')).toHaveText(['typescript'])
  await updates.chip('major').click()
  await expect(page).toHaveURL(/tab=packages$/)
  await updates.filter.fill('history')
  await expect(updates.updates.locator('.place-label')).toHaveText(['lodash'])
})

test('the images, the tools and what is unknown have their tabs', async ({ page, server }, testInfo) => {
  const updates = new UpdatesPage(page)
  await updates.signIn(server.url)
  await updates.open('Images')
  await expect(updates.update('node').locator('summary .badge')).toHaveText(['rebuilt'])
  await updates.open('Tools')
  await expect(updates.rows.locator('strong')).toHaveText(['flux', 'trivy'])
  await expect(updates.content.locator('.apt-line')).toContainText('8 apt packages to upgrade')
  await expect(updates.rows.first().getByRole('link', { name: '2.10.1' })).toHaveAttribute('href', 'https://github.com/fluxcd/flux2/releases/tag/v2.10.1')
  await expect(updates.rows.nth(1).getByRole('button', { name: /^Copy sudo apt update/ })).toBeVisible()
  await shot(page, testInfo, 'updates-tools')
  await page.getByRole('button', { name: 'Also up to date' }).click()
  await expect(updates.rows.locator('strong')).toHaveText(['flux', 'trivy', 'terraform'])
  await updates.open('Unknown')
  await expect(updates.problems).toHaveText(['private/app:1.0 in history: docker.io answered 401'])
})

test('the page of a repository shows its technologies and links to its own updates', async ({ page, server }, testInfo) => {
  const repository = new RepositoryPage(page)
  await repository.signIn(server.url, 'wsl-ubuntu', join(server.root, 'wsl-ubuntu', 'clean'))
  await repository.expectOpen('clean')
  await expect(page.locator('#branches .technology')).toHaveText(['Node.js', 'Terraform', 'Docker'])
  const link = page.locator('#branches').getByRole('link', { name: '3 updates' })
  await expect(link).toHaveClass(/fixes/)
  await shot(page, testInfo, 'repository-technologies')
  await link.click()
  const updates = new UpdatesPage(page)
  await expect(updates.tabs.first()).toHaveText('Packages2')
  await updates.update('lodash').locator('summary').click()
  await expect(updates.update('lodash').locator('.uses code')).toHaveCount(1)
  await page.getByRole('button', { name: 'clean ✕' }).click()
  await expect(page).not.toHaveURL(/repository=/)
  await expect(updates.update('lodash').locator('.uses code')).toHaveCount(2)
})

test('Check asks the registries again behind the page', async ({ page, server }) => {
  const updates = new UpdatesPage(page)
  await updates.signIn(server.url)
  await updates.check.click()
  await expect(updates.state).toHaveText(/^Asking the registries/)
  await expect(updates.state).toHaveText(/^Checked /)
  await expect(page.locator('#scanned')).toHaveText('Read just now')
})
