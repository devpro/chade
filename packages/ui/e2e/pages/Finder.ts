import { expect, type Locator, type Page } from '@playwright/test'

// The search that the r key opens over any page.
export class Finder {
  readonly dialog: Locator
  readonly input: Locator
  readonly options: Locator
  readonly names: Locator
  readonly selected: Locator
  readonly note: Locator

  constructor(readonly page: Page) {
    this.dialog = page.getByRole('dialog', { name: 'Open a repository' })
    this.input = this.dialog.getByRole('combobox')
    this.options = this.dialog.getByRole('option')
    this.names = this.dialog.locator('.finder-name')
    this.selected = this.dialog.getByRole('option', { selected: true })
    this.note = this.dialog.getByRole('status')
  }

  async open(): Promise<void> {
    await this.page.keyboard.press('r')
    await expect(this.input).toBeFocused()
    await expect(this.input).toHaveValue('')
  }
}
