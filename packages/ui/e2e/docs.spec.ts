import { expect, test } from './fixtures.js'
import { DocsPage } from './pages/DocsPage.js'
import { shot } from './shot.js'

test('the documentation shows the pages of the repository, with tables, code and the headings of the page @layout', async ({ page, docs }, testInfo) => {
  await expect(docs.pages).toHaveText(['User guide', 'Commands', 'Configuration', 'Web interface', 'System clean-up', 'Contributor guide'])
  await expect(docs.title).toHaveText('Chade')
  await expect(page.locator('#machine')).toHaveText('E2E-PC')
  await expect(docs.headings.first()).toHaveText('Requirements')
  // A step of a list keeps the block of code under it, and a table its cells.
  await expect(docs.article.locator('ol > li').first().locator('pre')).toHaveText('npm install --global @devprofr/chade')
  // An image comes from another site, which the page loads nothing from.
  await expect(docs.article.locator('img')).toHaveCount(0)
  await shot(page, testInfo, 'docs')
  await docs.headings.filter({ hasText: 'Documentation' }).click()
  await expect(page).toHaveURL(/#docs\?at=documentation$/)
  await expect(docs.heading('Documentation')).toBeInViewport()
  await docs.open('Configuration')
  await expect(docs.article.locator('td code', { hasText: /^store$/ })).toBeVisible()
})

test('a link to another page of the documentation opens it in the interface, at the heading it names', async ({ page, docs }) => {
  await docs.article.getByRole('link', { name: 'Web interface', exact: true }).click()
  await expect(page).toHaveURL(/#docs\?name=web-interface$/)
  await expect(docs.title).toHaveText('Web interface')
  await docs.article.getByRole('link', { name: 'system clean-up' }).first().click()
  await expect(docs.title).toHaveText('System clean-up')
  await expect(docs.pages.filter({ hasText: 'System clean-up' })).toHaveAttribute('aria-current', 'page')
  await docs.article.getByRole('link', { name: 'disk image compaction' }).click()
  await expect(page).toHaveURL(/#docs\?name=cleanup&at=disk-image-compaction$/)
  await expect(docs.heading('Disk image compaction')).toBeInViewport()
  await docs.open('Contributor guide')
  await expect(docs.title).toHaveText('Contributor guide')
  await expect(page).toHaveTitle('Contributor guide · Chade')
  // A note of GitHub shows its kind as a title.
  await expect(docs.article.locator('blockquote strong').first()).toHaveText('Note')
  await page.goBack()
  await expect(docs.title).toHaveText('System clean-up')
})

test('what the report advises links to its step in the documentation', async ({ page, report }) => {
  // A slow server shows the page late, and the heading is reached once it is shown.
  await page.route('**/api/ping', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await route.continue()
  })
  await report.card('Windows disk').guide.click()
  const docs = new DocsPage(page)
  await expect(docs.title).toHaveText('System clean-up')
  await expect(docs.heading('Disk image compaction')).toBeInViewport()
})
