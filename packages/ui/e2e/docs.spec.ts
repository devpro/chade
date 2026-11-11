import { expect, test } from './fixtures.js'
import { DocsPage } from './pages/DocsPage.js'
import { shot } from './shot.js'

test('the documentation shows the pages of the repository, with tables, code and the headings of the page @layout', async ({ page, docs }, testInfo) => {
  await expect(docs.pages).toHaveText(['User guide', 'System clean-up', 'Contributor guide'])
  await expect(docs.title).toHaveText('Chade')
  await expect(page.locator('#machine')).toHaveText('E2E-PC')
  await expect(docs.headings.first()).toHaveText('Requirements')
  // A step of a list keeps the block of code under it, and a table its cells.
  await expect(docs.article.locator('ol > li').first().locator('pre')).toHaveText('chade init --store ~/system-snapshots')
  await expect(docs.article.locator('td code', { hasText: /^store$/ })).toBeVisible()
  // An image comes from another site, which the page loads nothing from.
  await expect(docs.article.locator('img')).toHaveCount(0)
  await shot(page, testInfo, 'docs')
  await docs.headings.filter({ hasText: 'Web interface' }).click()
  await expect(page).toHaveURL(/#docs\?at=web-interface$/)
  await expect(docs.heading('Web interface')).toBeInViewport()
})

test('a link to another page of the documentation opens it in the interface, at the heading it names', async ({ page, docs }) => {
  await docs.article.getByRole('link', { name: 'docs/cleanup.md' }).nth(1).click()
  await expect(page).toHaveURL(/#docs\?name=cleanup&at=disk-image-compaction$/)
  await expect(docs.title).toHaveText('System clean-up')
  await expect(docs.heading('Disk image compaction')).toBeInViewport()
  await expect(docs.pages.filter({ hasText: 'System clean-up' })).toHaveAttribute('aria-current', 'page')
  await docs.open('Contributor guide')
  await expect(docs.title).toHaveText('Contributor guide')
  // A note of GitHub shows its kind as a title.
  await expect(docs.article.locator('blockquote strong').first()).toHaveText('Note')
  await page.goBack()
  await expect(docs.title).toHaveText('System clean-up')
})

test('what the report advises links to its step in the documentation', async ({ page, report }) => {
  await report.card('Windows disk').guide.click()
  const docs = new DocsPage(page)
  await expect(docs.title).toHaveText('System clean-up')
  await expect(docs.heading('Disk image compaction')).toBeInViewport()
})
