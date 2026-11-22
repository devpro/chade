import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countsOf, createActions, createApi, RequestError, type Scan } from '../src/index.js'

const saved: Scan = {
  machine: 'TEST-PC',
  date: '2026-11-22T00:00:00.000Z',
  skipped: [],
  tools: [],
  places: [
    {
      system: 'linux',
      kind: 'repository',
      label: '~/repos/a/node_modules',
      path: '/home/me/repos/a/node_modules',
      bytes: 2000,
      packages: 3,
      notes: [],
      tools: ['osv-scanner'],
      findings: [
        { ecosystem: 'npm', package: 'evil', version: '1.0.0', ids: ['MAL-1'], summary: '', severity: 'unknown', malicious: true, tools: ['osv-scanner'] },
        { ecosystem: 'npm', package: 'lodash', version: '4.17.15', ids: ['GHSA-1'], summary: '', severity: 'high', fixed: '4.17.21', malicious: false, tools: ['osv-scanner', 'trivy'] },
      ],
      unused: { reason: 'no commit, no change and no install for 90 days', command: 'rm -rf /home/me/repos/a/node_modules' },
    },
  ],
}

const options = (scan?: { read: () => Promise<Scan | undefined>; run: () => Promise<Scan> }) => ({
  version: '1.2.3',
  machine: 'TEST-PC',
  roots: async () => [],
  store: async () => '',
  report: async () => ({ machine: 'TEST-PC', date: '', sections: [] }),
  ...(scan ? { scan } : {}),
  run: async () => ({ code: 0, stdout: '', stderr: '' }),
})

test('the scan route gives the last saved scan, and nothing before the first', async () => {
  let stored: Scan | undefined
  const api = createApi(options({ read: async () => stored, run: async () => saved }))
  assert.deepEqual(await api.scan(new URLSearchParams()), { version: '1.2.3', machine: 'TEST-PC' })
  stored = saved
  assert.deepEqual(await api.scan(new URLSearchParams()), { version: '1.2.3', machine: 'TEST-PC', scan: saved })
})

test('a scan asked while one runs is that one', async () => {
  let runs = 0
  let finish: (scan: Scan) => void = () => undefined
  const actions = createActions(
    options({
      read: async () => undefined,
      run: () => {
        runs++
        return new Promise<Scan>((resolve) => (finish = resolve))
      },
    }),
  )
  const first = actions.scan(undefined)
  const second = actions.scan(undefined)
  finish(saved)
  assert.deepEqual(await Promise.all([first, second]), [
    { version: '1.2.3', ...saved },
    { version: '1.2.3', ...saved },
  ])
  assert.equal(runs, 1)
  // The next one runs again.
  const third = actions.scan(undefined)
  finish(saved)
  await third
  assert.equal(runs, 2)
})

test('a server without a scanner says so', async () => {
  await assert.rejects(createActions(options()).scan(undefined), (error: unknown) => error instanceof RequestError && error.status === 404)
})

test('a scan comes to its malicious packages, its findings by severity and what nothing uses', () => {
  assert.deepEqual(countsOf(saved), { malicious: 1, severities: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 }, unusedBytes: 2000, unused: 1 })
})
