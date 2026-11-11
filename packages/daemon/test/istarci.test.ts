import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { pathKey, readChecks, readRepositories, type IstarciServer } from '../src/index.js'

const sha = (digit: string) => digit.repeat(40)
const REPO = '/home/me/repos/app'

const runs = [
  { id: 'r5', commitSha: sha('5'), status: 'running', workflow: null },
  // A workflow run by hand is not the pipeline of its commit.
  { id: 'r4m', commitSha: sha('4'), status: 'failure', workflow: 'release.yml' },
  { id: 'r4', commitSha: sha('4'), status: 'success', durationMs: 112_000, workflow: null },
  { id: 'r3', commitSha: sha('3'), status: 'failure', durationMs: 5_000, workflow: null },
  // An older run of the same commit, which the newer one replaces.
  { id: 'r3-old', commitSha: sha('3'), status: 'success', workflow: null },
  { id: 'r2', commitSha: sha('2'), status: 'cancelled', workflow: null },
  { id: 'bad', commitSha: 'not a hash', status: 'success', workflow: null },
  { id: 'odd', commitSha: sha('9'), status: 'exploded', workflow: null },
]
const events = [
  { id: 1, commitSha: sha('1'), reason: 'A newer commit replaced it in the queue' },
  // A commit that ran after it was first left out is known by its run.
  { id: 2, commitSha: sha('3'), reason: 'No workflow matched it' },
]

const repos = [
  { path: REPO, latestRun: runs[0], latestEvent: { ...events[0], at: 1, branch: 'main' } },
  // A commit left out after the latest run.
  { path: '/mnt/c/Users/me/projects/portal', latestRun: { ...runs[2], triggeredAt: 1, branch: 'main' }, latestEvent: { ...events[0], at: 2, branch: 'feature/x' } },
  { path: '/home/me/repos/quiet', latestRun: null, latestEvent: null },
]

let istarci: Server
let server: IstarciServer
const asked: string[] = []

before(async () => {
  istarci = createServer((request, response) => {
    asked.push(request.url ?? '')
    if (request.headers.authorization !== 'Bearer secret') return response.writeHead(401).end('{}')
    const url = new URL(request.url ?? '', 'http://localhost')
    if (url.pathname === '/api/v1/repos') return response.end(JSON.stringify(repos))
    if (url.searchParams.get('repoPath') !== REPO) return response.end('[]')
    if (url.pathname === '/api/v1/runs') return response.end(JSON.stringify(runs))
    if (url.pathname === '/api/v1/events') return response.end(JSON.stringify(events))
    response.writeHead(404).end('{}')
  })
  await new Promise<void>((resolve) => istarci.listen(0, '127.0.0.1', resolve))
  server = { url: `http://127.0.0.1:${(istarci.address() as AddressInfo).port}`, token: 'secret' }
})

after(() => {
  istarci.closeAllConnections()
  istarci.close()
})

test('each commit takes the status of its newest pipeline run, with the page of the run', async () => {
  const checks = await readChecks(server, REPO)
  assert.deepEqual(checks[sha('5')], { status: 'running', url: `${server.url}/#/run/r5` })
  assert.deepEqual(checks[sha('4')], { status: 'success', durationMs: 112_000, url: `${server.url}/#/run/r4` })
  assert.equal(checks[sha('3')].status, 'failure')
  assert.equal(checks[sha('2')].status, 'cancelled')
  assert.equal(checks[sha('9')], undefined)
  assert.equal(Object.keys(checks).length, 5)
  assert.ok(asked.some((url) => url.includes('limit=200')))
})

test('a commit IstarCI did not run links to the page of the repository, with the reason', async () => {
  const checks = await readChecks(server, REPO)
  assert.deepEqual(checks[sha('1')], {
    status: 'not-run',
    reason: 'A newer commit replaced it in the queue',
    url: `${server.url}/#/repo/${encodeURIComponent(REPO)}`,
  })
})

test('a repository IstarCI does not watch has no check', async () => {
  assert.deepEqual(await readChecks(server, '/home/me/repos/other'), {})
})

test('no check when IstarCI is not set up, refuses the token, or does not answer', async () => {
  assert.deepEqual(await readChecks(undefined, REPO), {})
  assert.deepEqual(await readChecks({ ...server, token: 'old' }, REPO), {})
  assert.deepEqual(await readChecks({ url: 'http://127.0.0.1:1', token: 'secret' }, REPO), {})
  const started = Date.now()
  // An IstarCI that never answers is given up on at the timeout.
  const silent: typeof fetch = (_input, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  assert.deepEqual(await readChecks(server, REPO, silent), {})
  assert.ok(Date.now() - started < 3000)
})

test('an answer that is not a list gives no check', async () => {
  const odd: typeof fetch = async () => new Response('{"error":"no"}')
  assert.deepEqual(await readChecks(server, REPO, odd), {})
})

test('a folder of Windows has one key, read from WSL or from Windows', () => {
  assert.equal(pathKey('/mnt/c/Users/Me/projects/app/'), 'c:/users/me/projects/app')
  assert.equal(pathKey('C:\\Users\\me\\projects\\app'), 'c:/users/me/projects/app')
  assert.equal(pathKey('/mnt/d'), 'd:')
  // A folder of Linux keeps its case, which tells two folders apart there.
  assert.equal(pathKey('/home/Me/repos/app'), '/home/Me/repos/app')
})

test('each repository IstarCI watches has the newer of its latest run and its latest commit not run', async () => {
  const watched = await readRepositories(server)
  assert.deepEqual(watched.get(REPO), { path: REPO, latest: { sha: sha('5'), status: 'running', url: `${server.url}/#/run/r5` } })
  const portal = watched.get('c:/users/me/projects/portal')
  assert.equal(portal?.path, '/mnt/c/Users/me/projects/portal')
  assert.deepEqual(portal?.latest, {
    sha: sha('1'),
    status: 'not-run',
    reason: 'A newer commit replaced it in the queue',
    branch: 'feature/x',
    url: `${server.url}/#/repo/${encodeURIComponent('/mnt/c/Users/me/projects/portal')}`,
  })
  assert.deepEqual(watched.get('/home/me/repos/quiet'), { path: '/home/me/repos/quiet' })
  assert.equal((await readRepositories(undefined)).size, 0)
  assert.equal((await readRepositories({ ...server, token: 'old' })).size, 0)
})
