import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// A port the system hands out unless one is given, so a run never meets another on the same machine, a chade ui of the developer among them.
// It is set in the environment, which the workers inherit when they load this file again, so they all read the same one.
if (!process.env.E2E_PORT) {
  const script = "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close() })"
  process.env.E2E_PORT = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim()
}
const port = process.env.E2E_PORT
const baseURL = `http://127.0.0.1:${port}`
// The server writes there the address that signs in and the folder of its repositories, which the tests read.
process.env.E2E_STATE ??= join(tmpdir(), `chade-e2e-${port}.json`)

// Screenshots are taken for review only when asked, and then in the dark theme and at phone width as well.
// The theme and the width change the styles alone, so there only the tests tagged @layout run, those that capture a page.
const screenshots = process.env.SCREENSHOTS === '1'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  // The tests change the repositories the one server reads.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  outputDir: fileURLToPath(new URL('./test-results', import.meta.url)),
  use: {
    baseURL,
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --import tsx e2e/serve.ts',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: baseURL,
    // A server left from an earlier run would read repositories this one did not make.
    reuseExistingServer: false,
    // Playwright kills the server otherwise, which leaves its repositories in the temporary folder.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    ...(screenshots
      ? [
          { name: 'desktop-dark', grep: /@layout/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'dark' as const } },
          { name: 'mobile', grep: /@layout/, use: { ...devices['Pixel 7'] } },
        ]
      : []),
  ],
})
