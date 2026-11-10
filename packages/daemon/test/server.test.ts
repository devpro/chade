import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { startServer, type Server } from '../src/index.js'

let server: Server
let uiDir: string

before(async () => {
  uiDir = await mkdtemp(join(tmpdir(), 'chade-ui-'))
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>chade</title>')
  await writeFile(join(uiDir, 'app.js'), 'console.log(1)')
  await writeFile(join(uiDir, 'notes.txt'), 'not a page')
  server = await startServer({
    port: 0,
    uiDir,
    api: {
      repositories: async () => ({ repositories: [] }),
      broken: async () => {
        throw new Error('git is missing')
      },
    },
    actions: { action: async (body) => ({ received: body }) },
  })
})

after(() => server.close())

// fetch refuses to set the Host header, which is what the server checks.
function get(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, server.address)
    const call = request({ host: url.hostname, port: url.port, path, method, headers }, (response) => {
      let body = ''
      response.on('data', (chunk) => (body += chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }))
    })
    call.on('error', reject)
    call.end(body)
  })
}

const signedIn = (): Record<string, string> => ({ authorization: `Bearer ${server.token}` })

test('the address that signs in carries the token in its fragment, on the loopback address', () => {
  assert.match(server.address, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(server.url, `${server.address}/#token=${server.token}`)
  assert.ok(server.token.length >= 43)
})

test('the pages are served without the token, with a policy that runs no script from elsewhere', async () => {
  const page = await get('/')
  assert.equal(page.status, 200)
  assert.match(page.body, /<title>chade<\/title>/)
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/)
  assert.equal((await get('/app.js')).headers['content-type'], 'text/javascript; charset=utf-8')
})

test('only the files of the interface are served', async () => {
  assert.equal((await get('/notes.txt')).status, 404)
  assert.equal((await get('/../server.test.ts')).status, 404)
  assert.equal((await get('/%2e%2e/%2e%2e/etc/passwd')).status, 404)
})

test('the API answers the token, and nothing else', async () => {
  assert.equal((await get('/api/repositories')).status, 401)
  assert.equal((await get('/api/repositories', { authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await get(`/api/repositories?token=${server.token}`)).status, 401)
  const answer = await get('/api/repositories', signedIn())
  assert.equal(answer.status, 200)
  assert.deepEqual(JSON.parse(answer.body), { repositories: [] })
  assert.equal((await get('/api/unknown', signedIn())).status, 404)
})

test('a route that fails answers with its error', async () => {
  const answer = await get('/api/broken', signedIn())
  assert.equal(answer.status, 500)
  assert.deepEqual(JSON.parse(answer.body), { error: 'git is missing' })
})

test('a request named after another host, or sent by another site, is refused even with the token', async () => {
  assert.equal((await get('/api/repositories', { ...signedIn(), host: 'evil.example.test' })).status, 403)
  assert.equal((await get('/', { host: 'evil.example.test' })).status, 403)
  assert.equal((await get('/api/repositories', { ...signedIn(), origin: 'https://evil.example.test' })).status, 403)
  assert.equal((await get('/api/repositories', { ...signedIn(), origin: server.address })).status, 200)
  const port = new URL(server.address).port
  assert.equal((await get('/api/repositories', { ...signedIn(), host: `localhost:${port}` })).status, 200)
})

const json = (): Record<string, string> => ({ ...signedIn(), 'content-type': 'application/json' })

test('a route that changes something answers a POST of JSON, with the token', async () => {
  const answer = await get('/api/action', json(), 'POST', JSON.stringify({ action: 'fetch' }))
  assert.equal(answer.status, 200)
  assert.deepEqual(JSON.parse(answer.body), { received: { action: 'fetch' } })
  assert.equal((await get('/api/action', { 'content-type': 'application/json' }, 'POST', '{}')).status, 401)
  assert.equal((await get('/api/action', { ...json(), origin: 'https://evil.example.test' }, 'POST', '{}')).status, 403)
})

test('a body that is not JSON is refused, as a form of another site would send it, and so is one too large', async () => {
  assert.equal((await get('/api/action', { ...signedIn(), 'content-type': 'text/plain' }, 'POST', '{}')).status, 415)
  assert.equal((await get('/api/action', { ...signedIn(), 'content-type': 'application/x-www-form-urlencoded' }, 'POST', 'action=fetch')).status, 415)
  assert.equal((await get('/api/action', signedIn(), 'POST', '{}')).status, 415)
  assert.equal((await get('/api/action', json(), 'POST', '{not json')).status, 400)
  assert.equal((await get('/api/action', json(), 'POST', JSON.stringify({ message: 'x'.repeat(1024 * 1024) }))).status, 413)
})

test('a route answers its own method only, and a page is only read', async () => {
  assert.equal((await get('/api/repositories', json(), 'POST', '{}')).status, 405)
  assert.equal((await get('/api/action', signedIn())).status, 405)
  assert.equal((await get('/api/unknown', json(), 'POST', '{}')).status, 404)
  assert.equal((await get('/api/repositories', signedIn(), 'DELETE')).status, 405)
  assert.equal((await get('/', {}, 'POST', '')).status, 405)
})

test('a port already taken says so', async () => {
  const port = Number(new URL(server.address).port)
  await assert.rejects(startServer({ port, uiDir, api: {} }), /port \d+ is taken, --port chooses another one/)
})
