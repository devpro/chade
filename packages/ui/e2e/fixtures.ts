import { readFileSync } from 'node:fs'
import { test as base } from '@playwright/test'
import { RepositoriesPage } from './pages/RepositoriesPage.js'

export interface Server {
  // The address chade ui opens, with the token in its fragment.
  url: string
  // Folder of the repositories the server reads, one subfolder per system.
  root: string
}

export const test = base.extend<{ server: Server; repositories: RepositoriesPage }>({
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
})

export { expect } from '@playwright/test'
