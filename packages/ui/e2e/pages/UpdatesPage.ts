import { expect, type Locator, type Page } from '@playwright/test'

// The page of the updates: the packages, the images and the tools.
export class UpdatesPage {
  readonly state: Locator
  readonly tabs: Locator
  readonly updates: Locator
  readonly rows: Locator
  readonly problems: Locator
  readonly content: Locator
  readonly check: Locator
  readonly filter: Locator

  constructor(readonly page: Page) {
    this.state = page.locator('#updates-state')
    this.tabs = page.locator('#updates-tabs').getByRole('tab')
    this.content = page.locator('#updates-content')
    this.updates = this.content.locator('details')
    this.rows = this.content.locator('tbody tr')
    this.problems = this.content.locator('.skipped li')
    this.check = page.getByRole('button', { name: 'Check', exact: true })
    this.filter = page.getByRole('searchbox', { name: 'Filter the updates' })
  }

  async signIn(url: string): Promise<void> {
    await this.page.goto(url.replace('#', '#updates?system=wsl-ubuntu&'))
    await expect(this.state).toHaveText(/^Checked /)
  }

  async open(name: string): Promise<void> {
    await this.tabs.filter({ hasText: name }).click()
  }

  chip(name: string): Locator {
    return this.page.getByRole('group', { name: 'Change' }).getByRole('button', { name })
  }

  update(name: string): Locator {
    return this.updates.filter({ has: this.page.locator('.place-label', { hasText: new RegExp(`^${name}$`) }) })
  }
}
