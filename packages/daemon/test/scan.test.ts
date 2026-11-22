import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions, countsOf, packagesOf, createActions, createApi, RequestError, type Scan } from '../src/index.js'

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

test('the report route gives the saved report, and measures again when asked fresh', async () => {
  let measured = 0
  const saved = { machine: 'TEST-PC', date: '2026-11-22T06:00:00.000Z', sections: [] }
  const api = createApi({
    ...options(),
    report: async () => ({ machine: 'TEST-PC', date: `measured ${++measured}`, sections: [] }),
    savedReport: async () => saved,
  })
  assert.deepEqual(await api.report(new URLSearchParams()), { version: '1.2.3', machine: 'TEST-PC', scannedAt: '2026-11-22T06:00:00.000Z', sections: [] })
  assert.equal(measured, 0)
  assert.deepEqual(await api.report(new URLSearchParams('fresh=1')), { version: '1.2.3', machine: 'TEST-PC', scannedAt: 'measured 1', sections: [] })
  // Without a saved report, the page still gets one, measured.
  const unsaved = createApi({ ...options(), report: async () => ({ machine: 'TEST-PC', date: 'measured', sections: [] }), savedReport: async () => undefined })
  assert.equal(((await unsaved.report(new URLSearchParams())) as { scannedAt: string }).scannedAt, 'measured')
})

test('versions are compared part by part, a number as a number', () => {
  assert.equal(compareVersions('4.17.9', '4.17.21'), -1)
  assert.equal(compareVersions('v1.26.11', '1.26.10'), 1)
  assert.equal(compareVersions('go1.26.11', '1.26.11'), 0)
  assert.equal(compareVersions('1.2', '1.2.1'), -1)
  assert.deepEqual(['13.0.1', '9.0.1', '13.0.0'].sort(compareVersions), ['9.0.1', '13.0.0', '13.0.1'])
})

test('the findings of a package version are one, fixed by the highest version that fixes one of them', () => {
  const found = (id: string, severity: Scan['places'][number]['findings'][number]['severity'], fixed?: string, name = 'lodash') => ({ ecosystem: 'npm', package: name, version: '4.17.15', ids: [id], summary: '', severity, ...(fixed ? { fixed } : {}), malicious: false, tools: ['osv-scanner'] })
  const packages = packagesOf([found('GHSA-1', 'medium', '4.17.21'), found('GHSA-2', 'low', undefined, 'minimist'), found('GHSA-3', 'high', '4.17.19'), found('GHSA-4', 'low')])
  assert.deepEqual(packages.map((one) => [one.package, one.fixed, one.unfixed, one.findings.map((finding) => finding.ids[0])]), [
    ['lodash', '4.17.21', 1, ['GHSA-3', 'GHSA-1', 'GHSA-4']],
    ['minimist', undefined, 1, ['GHSA-2']],
  ])
})
