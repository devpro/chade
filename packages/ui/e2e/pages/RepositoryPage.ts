import { expect, type Locator, type Page } from '@playwright/test'

// The changes of one file, shown in place of the history.
export class FileComparison {
  readonly path: Locator
  readonly status: Locator
  readonly added: Locator
  readonly removed: Locator
  readonly note: Locator

  constructor(readonly view: Locator) {
    this.path = view.locator('.diff-head .file-path')
    this.status = view.locator('.diff-head .status')
    this.added = view.locator('.line.add .text')
    this.removed = view.locator('.line.del .text')
    this.note = view.locator('p')
  }

  async close(): Promise<void> {
    await this.view.getByRole('button', { name: 'Close' }).click()
  }
}

// The page of one repository: its branches, its history as a graph, the files of the commit chosen, and the changes of one of them.
export class RepositoryPage {
  readonly name: Locator
  readonly path: Locator
  readonly state: Locator
  readonly commits: Locator
  readonly subjects: Locator
  readonly workingTree: Locator
  readonly branches: Locator
  readonly changes: Locator
  readonly heading: Locator
  readonly body: Locator
  readonly files: Locator
  readonly comparison: FileComparison
  readonly history: Locator
  readonly resizer: Locator
  readonly notice: Locator
  readonly noticeText: Locator
  readonly commitMessage: Locator
  readonly commitButton: Locator
  readonly message: Locator

  constructor(readonly page: Page) {
    this.name = page.locator('#repository-name')
    this.path = page.locator('#repository-path')
    this.state = page.locator('#repository-state')
    this.commits = page.locator('#history .commit-row:not(.working-tree)')
    this.subjects = this.commits.locator('.subject')
    this.workingTree = page.locator('#history .working-tree')
    this.branches = page.locator('#branches .branch-item')
    this.changes = page.locator('#detail')
    this.heading = this.changes.locator('h2')
    this.body = this.changes.locator('.body')
    this.files = this.changes.locator('.index .file-link')
    this.comparison = new FileComparison(page.locator('#diff'))
    this.history = page.locator('#history')
    this.resizer = page.getByRole('separator', { name: 'Width of the history' })
    this.notice = page.locator('#notice-title')
    this.noticeText = page.locator('#notice-text')
    this.commitMessage = page.getByRole('textbox', { name: 'Commit message' })
    this.commitButton = page.getByRole('button', { name: 'Commit', exact: true })
    this.message = page.locator('#message')
  }

  // Opens the address chade ui gives, going on to a repository, and to one of its commits when given.
  async signIn(url: string, system: string, path: string, commit?: string): Promise<void> {
    const params = new URLSearchParams({ system, path, ...(commit ? { commit } : {}) })
    await this.page.goto(`${url}&${params}`)
  }

  async expectOpen(name: string): Promise<void> {
    await expect(this.name).toHaveText(name)
    await expect(this.commits.first()).toBeVisible()
  }

  commit(subject: string): Locator {
    return this.commits.filter({ hasText: subject })
  }

  // The names drawn on a commit: branches, tags and HEAD.
  refs(subject: string): Locator {
    return this.commit(subject).locator('.ref')
  }

  async choose(subject: string): Promise<void> {
    await this.commit(subject).click()
    await expect(this.commit(subject)).toHaveClass(/selected/)
  }

  branch(name: string): Locator {
    return this.branches.filter({ has: this.page.locator('.branch-name', { hasText: new RegExp(`^${name}$`) }) })
  }

  // Opens the changes of a file of the commit chosen, from the list of its files.
  async openFile(path: string): Promise<void> {
    await this.files.filter({ hasText: path }).click()
    await expect(this.comparison.path).toContainText(path)
  }

  // Fetch, Pull or Push, and the notice that it is done.
  async run(action: 'Fetch' | 'Pull' | 'Push', done: string): Promise<void> {
    await this.page.getByRole('button', { name: action, exact: true }).click()
    await expect(this.notice).toHaveText(done)
  }

  async checkOut(branch: string): Promise<void> {
    await this.branch(branch).hover()
    await this.page.getByRole('button', { name: `Check out ${branch}`, exact: true }).click()
    await expect(this.notice).toHaveText(`Checked out ${branch}`)
  }

  async createBranch(name: string): Promise<void> {
    await this.page.getByRole('button', { name: 'New branch' }).click()
    await this.page.getByRole('textbox', { name: 'Name of the new branch' }).fill(name)
    await this.page.getByRole('button', { name: 'Create branch' }).click()
  }

  // The files under a title of the uncommitted changes: Staged, Not staged or Untracked.
  part(title: string): Locator {
    // From its first letter, as Staged is also the end of Not staged.
    return this.changes.locator('h3', { hasText: new RegExp(`^${title}`) }).locator('+ ul .file-path')
  }

  async stage(path: string): Promise<void> {
    await this.page.getByRole('button', { name: `Stage ${path}`, exact: true }).click()
    await expect(this.notice).toHaveText(`Staged ${path}`)
  }

  async unstage(path: string): Promise<void> {
    await this.page.getByRole('button', { name: `Unstage ${path}`, exact: true }).click()
    await expect(this.notice).toHaveText(`Unstaged ${path}`)
  }

  async commitWith(message: string): Promise<void> {
    await this.commitMessage.fill(message)
    await this.commitButton.click()
    await expect(this.notice).toHaveText('Committed')
  }

  // Drags the bar between the history and the changes, to the right by the pixels given, or to the left when negative.
  async resizeHistory(by: number): Promise<void> {
    const box = await this.resizer.boundingBox()
    if (!box) throw new Error('the bar that resizes the history is not shown')
    await this.page.mouse.move(box.x + box.width / 2, box.y + 100)
    await this.page.mouse.down()
    await this.page.mouse.move(box.x + box.width / 2 + by, box.y + 100, { steps: 5 })
    await this.page.mouse.up()
  }

  async historyWidth(): Promise<number> {
    return (await this.history.boundingBox())?.width ?? 0
  }

  async back(): Promise<void> {
    await this.page.getByRole('link', { name: '← Repositories' }).click()
  }
}
