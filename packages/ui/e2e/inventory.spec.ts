import { expect, test } from './fixtures.js'
import { shot } from './shot.js'

test('the inventory counts the repositories of each technology, with a link to them @layout', async ({ page, repositories }, testInfo) => {
  await repositories.showSystem('wsl-ubuntu')
  await repositories.menu('Inventory').click()
  await expect(page.locator('#inventory-content tbody tr')).toHaveText(['Docker1Show the repositories', 'Node.js1Show the repositories', 'Terraform1Show the repositories'])
  await shot(page, testInfo, 'inventory')
  await page.getByRole('link', { name: 'Show the Terraform repositories' }).click()
  await expect(page.locator('#content .name')).toHaveText(['clean'])
  await expect(repositories.technology('Terraform')).toHaveAttribute('aria-pressed', 'true')
  // The address follows the filter: another chip, a reload, a repository and back, then none.
  await expect(page).toHaveURL(/#system=wsl-ubuntu&technology=terraform$/)
  await repositories.technology('Docker').click()
  await expect(page).toHaveURL(/technology=terraform%2Cdocker$/)
  // A filter is no step of the history: Back returns to the inventory, and Forward to the list as it was.
  await page.goBack()
  await expect(page.locator('#inventory-content')).toBeVisible()
  await page.goForward()
  await expect(repositories.technology('Docker')).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(repositories.technology('Docker')).toHaveAttribute('aria-pressed', 'true')
  await expect(repositories.names).toHaveText(['clean'])
  await repositories.openRepository('clean')
  await page.getByRole('link', { name: '← Repositories' }).click()
  await expect(repositories.technology('Terraform')).toHaveAttribute('aria-pressed', 'true')
  await repositories.technology('Docker').click()
  await repositories.technology('Terraform').click()
  await expect(page).toHaveURL(/\/$/)
  await expect(repositories.names).toHaveCount(9)
  await repositories.technology('Docker').click()
  await repositories.showSystem('windows')
  await expect(page).toHaveURL(/\/$/)
})
