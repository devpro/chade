import { expect, type Locator, type Page } from '@playwright/test'
import { FileComparison } from './RepositoryPage.js'

// The page of the store: its machines, the snapshots of one, what a snapshot changed or held, and one file of it.
export class StorePage {
  readonly path: Locator
  readonly machines: Locator
  readonly systems: Locator
  readonly snapshots: Locator
  readonly detail: Locator
  readonly heading: Locator
  readonly facts: Locator
  readonly groups: Locator
  readonly files: Locator
  readonly file: FileComparison
  readonly content: Locator
  readonly history: Locator
  readonly message: Locator

  constructor(readonly page: Page) {
    this.path = page.locator('#store-path')
    this.machines = page.locator('#store-machines .branch-item')
    this.systems = page.locator('#store-machines .machine-system')
    this.snapshots = page.locator('#store-snapshots .commit-row')
    this.detail = page.locator('#store-detail')
    this.heading = this.detail.locator('h2')
    this.facts = this.detail.locator('.facts')
    this.groups = this.detail.locator('h3')
    this.files = this.detail.locator('.file-link')
    this.file = new FileComparison(page.locator('#store-file'))
    this.content = page.locator('#store-file .line .text')
    this.history = page.locator('#store-snapshots')
    this.message = page.locator('#store-snapshots p')
  }

  // Opens the address chade ui gives, going on to the store.
  async signIn(url: string): Promise<void> {
    await this.page.goto(url.replace('#', '#store?'))
    await this.expectOpen()
  }

  async expectOpen(): Promise<void> {
    await expect(this.snapshots.first()).toBeVisible()
    await expect(this.heading).toBeVisible()
  }

  machine(name: string): Locator {
    return this.machines.filter({ has: this.page.locator('.branch-name', { hasText: new RegExp(`^${name}$`) }) })
  }

  async chooseMachine(name: string): Promise<void> {
    await this.machine(name).click()
    await expect(this.machine(name)).toHaveClass(/selected/)
  }

  snapshot(subject: string): Locator {
    return this.snapshots.filter({ hasText: subject })
  }

  async choose(subject: string): Promise<void> {
    await this.snapshot(subject).click()
    await expect(this.snapshot(subject)).toHaveClass(/selected/)
  }

  view(name: 'Changes' | 'Files'): Locator {
    return this.detail.getByRole('tab', { name })
  }

  // Lists what the snapshot changed, or every file the machine had at it.
  async show(name: 'Changes' | 'Files'): Promise<void> {
    await this.view(name).click()
    await expect(this.view(name)).toHaveAttribute('aria-selected', 'true')
  }

  async openFile(path: string): Promise<void> {
    await this.files.filter({ hasText: path }).click()
    await expect(this.file.path).toContainText(path)
  }

  async back(): Promise<void> {
    await this.page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Repositories' }).click()
  }
}
