import { expect, test } from './fixtures.js'
import { RepositoriesPage } from './pages/RepositoriesPage.js'
import { shot } from './shot.js'

test('the page opened without the address that signs in shows no repository and says how to sign in @layout', async ({ page }, testInfo) => {
  const repositories = new RepositoriesPage(page)
  await repositories.open()
  await expect(repositories.message).toHaveText('Not signed in. The chade ui command opens this page with the address that signs in.')
  await expect(repositories.names).toHaveCount(0)
  await shot(page, testInfo, 'not-signed-in')
})

test('signing in takes the token out of the address, and the tab stays signed in when it is loaded again', async ({ page, repositories }) => {
  expect(new URL(page.url()).hash).toBe('')
  expect(await page.evaluate(() => history.length)).toBe(await page.evaluate(() => history.length))
  await page.reload()
  await expect(repositories.names.first()).toBeVisible()
  await expect(repositories.machine).toHaveText('E2E-PC')
})

test('the token of a server that is gone ends the session, and says how to open a new one', async ({ page, server }) => {
  const repositories = new RepositoriesPage(page)
  await page.goto(server.url.replace(/token=.*/, 'token=from-an-earlier-start'))
  await expect(repositories.message).toHaveText('The session ended with the server it came from. The chade ui command opens a new one.')
  await expect(repositories.tabs).toHaveCount(0)
  // The token is forgotten, so loading the page again asks to sign in rather than failing the same way.
  await page.reload()
  await expect(repositories.message).toContainText('Not signed in.')
})

test('the API answers the token and not a page that has none', async ({ page, server }) => {
  await page.goto('/')
  const status = (token?: string) =>
    page.evaluate(async (given) => (await fetch('api/state', given ? { headers: { Authorization: `Bearer ${given}` } } : {})).status, token)
  expect(await status()).toBe(401)
  expect(await status(server.url.split('token=')[1])).toBe(200)
})
