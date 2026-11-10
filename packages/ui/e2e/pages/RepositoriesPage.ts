import { expect, type Locator, type Page } from '@playwright/test'

// The cells of one repository, by what the column says.
export class RepositoryRow {
  constructor(readonly row: Locator) {}

  get path(): Locator {
    return this.row.locator('.path')
  }

  get branch(): Locator {
    return this.row.locator('td').nth(1)
  }

  get upstream(): Locator {
    return this.row.locator('td').nth(2)
  }

  get workingTree(): Locator {
    return this.row.locator('td').nth(3)
  }

  get lastCommit(): Locator {
    return this.row.locator('.subject')
  }

  get error(): Locator {
    return this.row.locator('td.error')
  }
}

// The one page of the interface: the systems as tabs, and the repositories of the system chosen.
export class RepositoriesPage {
  readonly machine: Locator
  readonly summary: Locator
  readonly warnings: Locator
  readonly message: Locator
  readonly names: Locator
  readonly tabs: Locator
  readonly age: Locator

  constructor(readonly page: Page) {
    this.machine = page.locator('#machine')
    this.summary = page.locator('#summary')
    this.warnings = page.locator('#warnings li')
    this.message = page.locator('#content p')
    this.names = page.locator('tbody .name')
    this.tabs = page.getByRole('tab')
    this.age = page.locator('#scanned')
  }

  // Opens the address chade ui gives, and waits for the repositories it signs in to.
  async signIn(url: string): Promise<void> {
    await this.page.goto(url)
    await expect(this.names.first()).toBeVisible()
  }

  async open(): Promise<void> {
    await this.page.goto('/')
  }

  tab(system: string): Locator {
    return this.page.getByRole('tab', { name: system })
  }

  async showSystem(system: string): Promise<void> {
    await this.tab(system).click()
    await expect(this.tab(system)).toHaveAttribute('aria-selected', 'true')
  }

  repository(name: string): RepositoryRow {
    return new RepositoryRow(this.page.locator('tbody tr').filter({ has: this.page.locator('.name', { hasText: new RegExp(`^${name}$`) }) }))
  }

  async filter(text: string): Promise<void> {
    await this.page.getByRole('searchbox', { name: 'Filter the repositories' }).fill(text)
  }

  async onlyThoseWithSomethingToDo(only = true): Promise<void> {
    await this.page.getByLabel('Only those with something to do').setChecked(only)
  }

  // Reads the repositories again, and waits for the answer.
  async refresh(): Promise<void> {
    const answer = this.page.waitForResponse((response) => response.url().endsWith('/api/state'))
    await this.page.getByRole('button', { name: 'Refresh' }).click()
    await answer
    await expect(this.page.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  }
}
