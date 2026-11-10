import { readFileSync } from 'node:fs'
import { test as base } from '@playwright/test'
import { join } from 'node:path'
import { RepositoriesPage } from './pages/RepositoriesPage.js'
import { RepositoryPage } from './pages/RepositoryPage.js'

export interface Server {
  // The address chade ui opens, with the token in its fragment.
  url: string
  // Folder of the repositories the server reads, one subfolder per system.
  root: string
}

export const test = base.extend<{ server: Server; repositories: RepositoriesPage; history: RepositoryPage }>({
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
})

export { expect } from '@playwright/test'
