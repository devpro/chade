import { expect, test } from './fixtures.js'
import { shot } from './shot.js'

test('the logs show the steps of the jobs, the newest first, and one job alone when chosen @layout', async ({ page, repositories }, testInfo) => {
  await repositories.menu('Logs').click()
  const lines = page.locator('#logs-content .log-text')
  await expect(lines).toHaveText(['image 1 of 58: node:24, 1.1 GB', 'started', 'failed after 1 min 0 s: no registry answered', 'started'])
  await expect(page.locator('#logs-content tr.bad')).toHaveCount(1)
  await shot(page, testInfo, 'logs')
  await page.getByRole('group', { name: 'Job' }).getByRole('button', { name: 'scan' }).click()
  await expect(lines).toHaveText(['image 1 of 58: node:24, 1.1 GB', 'started'])
  await expect(page).toHaveURL(/#logs\?job=scan$/)
  await page.reload()
  await expect(lines).toHaveCount(2)
})
