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

// The two screens the interface is designed for: 1920x1200 and 2560x1440, both scaled at 125% by Windows.
// A browser sees them in CSS pixels, 1536x960 and 2048x1152, and draws 1.25 pixel of the screen for each.
const screen1536 = { ...devices['Desktop Chrome'], viewport: { width: 1536, height: 960 }, deviceScaleFactor: 1.25 }
const screen2048 = { ...devices['Desktop Chrome'], viewport: { width: 2048, height: 1152 }, deviceScaleFactor: 1.25 }

// Screenshots are taken for review only when asked, and then on the larger screen and in the dark theme as well.
// The width and the theme change the styles alone, so there only the tests tagged @layout run, those that capture a page.
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
    { name: 'screen-1536', use: screen1536 },
    ...(screenshots
      ? [
          { name: 'screen-2048', grep: /@layout/, use: screen2048 },
          { name: 'screen-1536-dark', grep: /@layout/, use: { ...screen1536, colorScheme: 'dark' as const } },
        ]
      : []),
  ],
})
