import { expect, type Locator, type Page } from '@playwright/test'

// One folder or image the scan read, opened on its findings.
export class ScanPlace {
  readonly label: Locator
  readonly badges: Locator
  readonly notes: Locator
  readonly findings: Locator

  constructor(readonly place: Locator) {
    this.label = place.locator('summary .place-label')
    this.badges = place.locator('summary .badge')
    this.notes = place.locator('summary .note')
    this.findings = place.locator('.findings tr')
  }

  async open(): Promise<void> {
    await this.place.locator('summary').click()
    await expect(this.findings.first()).toBeVisible()
  }
}

// The page of the scan: vulnerable and malicious packages on the disk, and what nothing uses.
export class SecurityPage {
  readonly parts: Locator
  readonly summary: Locator
  readonly state: Locator
  readonly tabs: Locator
  readonly filter: Locator
  readonly scan: Locator
  readonly unused: Locator
  readonly skipped: Locator
  readonly scanners: Locator

  constructor(readonly page: Page) {
    this.parts = page.locator('#security .scan-part > h3')
    this.summary = page.locator('#security-summary')
    this.state = page.locator('#security-state')
    this.tabs = page.locator('#security-tabs .tab')
    this.filter = page.getByRole('searchbox', { name: 'Filter the scan' })
    this.scan = page.getByRole('button', { name: 'Scan', exact: true })
    this.unused = page.locator('#security .unused tbody tr')
    this.skipped = page.locator('#security .skipped li')
    this.scanners = page.locator('#security .scanners li')
  }

  async signIn(url: string): Promise<void> {
    await this.page.goto(url.replace('#', '#security?'))
    await expect(this.state).toHaveText(/^Scanned /)
  }

  part(title: RegExp): Locator {
    return this.page.locator('#security .scan-part').filter({ has: this.page.locator('h3', { hasText: title }) })
  }

  place(part: RegExp, label: string): ScanPlace {
    return new ScanPlace(this.part(part).locator('.place').filter({ has: this.page.locator('summary .place-label', { hasText: label }) }))
  }

  tab(name: string): Locator {
    return this.tabs.filter({ has: this.page.locator('span', { hasText: new RegExp(`^${name}$`) }) })
  }
}
