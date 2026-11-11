import { expect, type Locator, type Page } from '@playwright/test'

// The documentation: its pages, the one shown, and the headings of that one.
export class DocsPage {
  readonly pages: Locator
  readonly article: Locator
  readonly title: Locator
  readonly headings: Locator

  constructor(readonly page: Page) {
    this.pages = page.getByRole('navigation', { name: 'Documentation' }).getByRole('link')
    this.article = page.locator('#docs-page')
    this.title = this.article.locator('h1')
    this.headings = page.getByRole('navigation', { name: 'On this page' }).getByRole('link')
  }

  // Opens the address chade ui gives, going on to the documentation.
  async signIn(url: string): Promise<void> {
    await this.page.goto(url.replace('#', '#docs?'))
    await expect(this.title).toBeVisible()
  }

  async open(title: string): Promise<void> {
    await this.pages.filter({ hasText: title }).click()
    await expect(this.pages.filter({ hasText: title })).toHaveAttribute('aria-current', 'page')
  }

  heading(text: string): Locator {
    return this.article.getByRole('heading', { name: text, exact: true })
  }
}
