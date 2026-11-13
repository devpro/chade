import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page, TestInfo } from '@playwright/test'

export const SCREENSHOT_DIR = fileURLToPath(new URL('./screenshots', import.meta.url))

// Saves what the page shows under a stable name, for review, and does nothing unless SCREENSHOTS=1.
// The name starts with the project, so the captures of one state on each screen and theme sit side by side.
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  if (process.env.SCREENSHOTS !== '1') return
  // The caret is hidden, so that two captures of one state differ only where the state does.
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${testInfo.project.name}--${name}.png`), fullPage: true, animations: 'disabled', caret: 'hide' })
}
