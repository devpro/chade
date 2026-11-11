import { readFileSync } from 'node:fs'
import { test as base } from '@playwright/test'
import { join } from 'node:path'
import { RepositoriesPage } from './pages/RepositoriesPage.js'
import { RepositoryPage } from './pages/RepositoryPage.js'
import { DocsPage } from './pages/DocsPage.js'
import { ReportPage } from './pages/ReportPage.js'
import { StorePage } from './pages/StorePage.js'

export interface Server {
  // The address chade ui opens, with the token in its fragment.
  url: string
  // Folder of the repositories the server reads, one subfolder per system.
  root: string
  // Folder of the store the server reads.
  store: string
}

export const test = base.extend<{ server: Server; repositories: RepositoriesPage; history: RepositoryPage; store: StorePage; report: ReportPage; docs: DocsPage }>({
  server: async ({}, use) => {
    const file = process.env.E2E_STATE
    if (!file) throw new Error('E2E_STATE is set by the Playwright configuration')
    await use(JSON.parse(readFileSync(file, 'utf8')) as Server)
  },
  // The page of the repositories, signed in the way chade ui signs in.
  repositories: async ({ page, server }, use) => {
    const repositories = new RepositoriesPage(page)
    await repositories.signIn(server.url)
    await use(repositories)
  },
  // The page of the repository named history, which has a branch merged, a tag and uncommitted changes.
  history: async ({ page, server }, use) => {
    const history = new RepositoryPage(page)
    await history.signIn(server.url, 'wsl-ubuntu', join(server.root, 'wsl-ubuntu', 'history'))
    await history.expectOpen('history')
    await use(history)
  },
  // The page of the store, which has two machines, the one of the run with three snapshots.
  store: async ({ page, server }, use) => {
    const store = new StorePage(page)
    await store.signIn(server.url)
    await use(store)
  },
  // The documentation, on its first page.
  docs: async ({ page, server }, use) => {
    const docs = new DocsPage(page)
    await docs.signIn(server.url)
    await use(docs)
  },
  // The page of the report, once measured.
  report: async ({ page, server }, use) => {
    const report = new ReportPage(page)
    await report.signIn(server.url)
    await use(report)
  },
})

export { expect } from '@playwright/test'
