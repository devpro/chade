import { expect, type Locator, type Page } from '@playwright/test'

// One folder or image the scan read, opened on its packages.
export class ScanPlace {
  readonly label: Locator
  readonly meta: Locator
  readonly badges: Locator
  readonly notes: Locator
  readonly packages: Locator
  readonly clean: Locator

  constructor(readonly place: Locator) {
    this.label = place.locator('summary .place-label')
    this.meta = place.locator('summary .place-meta')
    this.badges = place.locator('summary .badge')
    this.notes = place.locator('summary .note')
    this.packages = place.locator('.findings tbody tr')
    this.clean = place.locator('.clean')
  }

  async open(): Promise<void> {
    await this.place.locator('summary').click()
    await expect(this.place).toHaveAttribute('open', '')
  }
}

// The page of the scan: vulnerable and malicious packages on the disk, a tab for each kind of place.
export class SecurityPage {
  readonly state: Locator
  readonly alert: Locator
  readonly tabs: Locator
  readonly systems: Locator
  readonly levels: Locator
  readonly filter: Locator
  readonly scan: Locator
  readonly places: Locator
  readonly empty: Locator
  readonly skipped: Locator
  readonly scanners: Locator
  readonly guide: Locator

  constructor(readonly page: Page) {
    this.state = page.locator('#security-state')
    this.alert = page.locator('#security-alert li')
    this.tabs = page.locator('#security-tabs .tab')
    this.systems = page.getByRole('group', { name: 'System' }).getByRole('button')
    this.levels = page.getByRole('group', { name: 'Level' }).getByRole('button')
    this.filter = page.getByRole('searchbox', { name: 'Filter the scan' })
    this.scan = page.getByRole('button', { name: 'Scan', exact: true })
    this.places = page.locator('#security-content .place')
    this.empty = page.locator('#security-content .empty')
    this.skipped = page.locator('#security .skipped li')
    this.scanners = page.locator('#security .scanners li')
    this.guide = page.locator('#security .skipped .guide')
  }

  async signIn(url: string): Promise<void> {
    await this.page.goto(url.replace('#', '#security?'))
    await expect(this.state).toHaveText(/^Scanned /)
  }

  tab(name: string): Locator {
    return this.tabs.filter({ has: this.page.locator('span', { hasText: new RegExp(`^${name}$`) }) })
  }

  system(name: string): Locator {
    return this.systems.filter({ hasText: new RegExp(`^${name}$`) })
  }

  level(name: string): Locator {
    return this.levels.filter({ hasText: new RegExp(`^${name}\\d+$`) })
  }

  place(label: string): ScanPlace {
    return new ScanPlace(this.places.filter({ has: this.page.locator('summary .place-label', { hasText: label }) }))
  }
}
