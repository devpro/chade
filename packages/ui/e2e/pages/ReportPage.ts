import { expect, type Locator, type Page } from '@playwright/test'

// One thing the report measures, with its sizes and what to do about them.
export class ReportCard {
  readonly labels: Locator
  readonly sizes: Locator
  readonly advice: Locator
  readonly commands: Locator
  readonly guide: Locator

  constructor(readonly card: Locator) {
    this.labels = card.locator('.measure-label')
    this.sizes = card.locator('.measure-size')
    this.advice = card.locator('.advice')
    this.commands = card.locator('.commands div')
    this.guide = card.getByRole('link', { name: 'How to, step by step' })
  }

  measure(label: string): Locator {
    return this.card.locator('.measure').filter({ has: this.card.page().locator('.measure-label', { hasText: new RegExp(`^${label}$`) }) })
  }
}

// The page of the report: what takes disk and memory on the machine, and what to clean.
export class ReportPage {
  readonly titles: Locator
  readonly summary: Locator
  readonly state: Locator
  readonly age: Locator

  constructor(readonly page: Page) {
    this.titles = page.locator('#report .card h3')
    this.summary = page.locator('#report-summary')
    this.state = page.locator('#report-state')
    this.age = page.locator('#scanned')
  }

  // Opens the address chade ui gives, going on to the report, and waits for it to be measured.
  async signIn(url: string): Promise<void> {
    await this.page.goto(url.replace('#', '#report?'))
    await this.expectMeasured()
  }

  async expectMeasured(): Promise<void> {
    await expect(this.titles.first()).toBeVisible()
    await expect(this.state).toHaveText(/^Measured /)
  }

  card(title: string): ReportCard {
    return new ReportCard(this.page.locator('#report .card').filter({ has: this.page.locator('h3', { hasText: new RegExp(`^${title}$`) }) }))
  }

  async measureAgain(): Promise<void> {
    await this.page.getByRole('button', { name: 'Refresh' }).click()
  }

  async back(): Promise<void> {
    await this.page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Repositories' }).click()
  }
}
