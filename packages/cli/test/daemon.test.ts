import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer } from '@chade/daemon'
import { logPath, runningDaemon, signInUrl, statePath, stopDaemon, writeState, type DaemonState } from '../src/daemon.js'

async function folder(): Promise<{ configFile: string; uiDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'chade-daemon-'))
  await writeFile(join(root, 'index.html'), '<!doctype html>')
  return { configFile: join(root, 'home', '.chade', 'config.yml'), uiDir: root }
}

test('the state and the log of the server are kept beside the configuration', () => {
  assert.equal(statePath(join('home', '.chade', 'config.yml')), join('home', '.chade', 'daemon.json'))
  assert.equal(logPath(join('home', '.chade', 'config.yml')), join('home', '.chade', 'daemon.log'))
})

test('a server is found through its state file, when it answers the token of that file', async () => {
  const { configFile, uiDir } = await folder()
  assert.equal(await runningDaemon(configFile), undefined)
  const server = await startServer({ port: 0, uiDir, api: { ping: async () => ({ version: '1.2.3' }) } })
  try {
    // A process that does not exist, so stopping the server of the file ends nothing of this test.
    const state: DaemonState = { pid: 2 ** 22 + 1, address: server.address, token: server.token, version: '1.2.3', startedAt: new Date().toISOString() }
    await writeState(configFile, state)
    assert.deepEqual(await runningDaemon(configFile), state)
    assert.equal(signInUrl(state), server.url)
    if (process.platform !== 'win32') assert.equal((await stat(statePath(configFile))).mode & 0o777, 0o600)

    // The file of a server that is gone names an address where another program may answer, without the token.
    await writeState(configFile, { ...state, token: 'another' })
    assert.equal(await runningDaemon(configFile), undefined)

    await writeState(configFile, state)
    assert.deepEqual(await stopDaemon(configFile), state)
    assert.ok(!existsSync(statePath(configFile)))
  } finally {
    await server.close()
  }
})

test('a state file left by a server that no longer listens reads as no server, and stopping it removes the file', async () => {
  const { configFile, uiDir } = await folder()
  const server = await startServer({ port: 0, uiDir, api: { ping: async () => ({}) } })
  await writeState(configFile, { pid: 2 ** 22 + 1, address: server.address, token: server.token, version: '1.2.3', startedAt: '' })
  await server.close()
  assert.equal(await runningDaemon(configFile), undefined)
  assert.equal(await stopDaemon(configFile), undefined)
  assert.ok(!existsSync(statePath(configFile)))
})
