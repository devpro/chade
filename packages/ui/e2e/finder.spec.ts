import { expect, test } from './fixtures.js'
import { Finder } from './pages/Finder.js'
import { shot } from './shot.js'

test('r opens a search over the repositories of every system, and Enter opens the one selected @layout', async ({ page, repositories, history }, testInfo) => {
  await repositories.menu('Repositories').click()
  await expect(repositories.names.first()).toBeVisible()
  const finder = new Finder(page)
  await finder.open()
  await expect(finder.options).toHaveCount(await repositories.tabs.locator('.count:not(.todo)').allTextContents().then((counts) => counts.reduce((sum, count) => sum + Number(count), 0)))
  await shot(page, testInfo, 'finder')
  await page.keyboard.type('hist')
  await expect(finder.names).toHaveText(['history'])
  await expect(finder.selected).toContainText('wsl-ubuntu')
  await page.keyboard.press('Enter')
  await expect(finder.dialog).toBeHidden()
  await history.expectOpen('history')
})

test('the arrows select a repository, and a click opens another from the page of the first', async ({ page, history }) => {
  const finder = new Finder(page)
  await finder.open()
  // The page of a repository has not read the list, so the search reads it.
  await expect(finder.names.first()).toBeVisible()
  const second = await finder.names.nth(1).textContent()
  await page.keyboard.press('ArrowDown')
  await expect(finder.selected.locator('.finder-name')).toHaveText(second ?? '')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(finder.options.last()).toHaveAttribute('aria-selected', 'true')
  await finder.input.fill('clean')
  await finder.options.first().click()
  await expect(finder.dialog).toBeHidden()
  await history.expectOpen('clean')
})

test('Escape and a click outside close the search, and leave the page behind as it was', async ({ page, history }) => {
  await history.workingTree.click()
  await history.openFile('staged.txt')
  await expect(history.comparison.view).toBeVisible()
  const finder = new Finder(page)
  await finder.open()
  await page.keyboard.press('Escape')
  await expect(finder.dialog).toBeHidden()
  await expect(history.comparison.view).toBeVisible()
  await finder.open()
  await page.mouse.click(20, 500)
  await expect(finder.dialog).toBeHidden()
  await expect(history.comparison.view).toBeVisible()
})

test('a search without a match says so, and Enter then does nothing', async ({ page, repositories }) => {
  await expect(repositories.names.first()).toBeVisible()
  const finder = new Finder(page)
  await finder.open()
  await page.keyboard.type('no such repository')
  await expect(finder.note).toHaveText('No repository matches.')
  await page.keyboard.press('Enter')
  await expect(finder.dialog).toBeVisible()
})

test('r stays a letter in a field, and Ctrl+R stays with the browser', async ({ page, repositories }) => {
  const finder = new Finder(page)
  const filter = page.getByRole('searchbox', { name: 'Filter the repositories' })
  await filter.focus()
  await page.keyboard.type('portal r')
  await expect(filter).toHaveValue('portal r')
  await expect(finder.dialog).toBeHidden()
  await filter.blur()
  const prevented = await page.evaluate(() => !document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, cancelable: true })))
  expect(prevented).toBe(false)
  await expect(finder.dialog).toBeHidden()
  await expect(repositories.names.first()).toBeVisible()
})

test('a search without a sign-in says how to sign in', async ({ page }) => {
  await page.goto('/')
  const finder = new Finder(page)
  await finder.open()
  await expect(finder.note).toContainText('Not signed in.')
})
