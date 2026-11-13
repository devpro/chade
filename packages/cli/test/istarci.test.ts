import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { istarciServer, parseIstarciConfig } from '../src/istarci.js'

test('IstarCI is asked on the loopback address, at the port and with the token of its configuration', () => {
  assert.deepEqual(parseIstarciConfig('server:\n  host: 0.0.0.0\n  port: 7900\n  webhookToken: abc\n'), { url: 'http://127.0.0.1:7900', token: 'abc' })
  assert.deepEqual(parseIstarciConfig('server:\n  webhookToken: abc\n'), { url: 'http://127.0.0.1:7842', token: 'abc' })
})

test('a configuration without a token or a valid port leaves IstarCI out', () => {
  assert.equal(parseIstarciConfig('server:\n  webhookToken: ""\n'), undefined)
  assert.equal(parseIstarciConfig('server:\n  port: 99999\n  webhookToken: abc\n'), undefined)
  assert.equal(parseIstarciConfig('verbose: true\n'), undefined)
  assert.equal(parseIstarciConfig(''), undefined)
})

test('the configuration is read from the folder of IstarCI in the home, and its absence is no error', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chade-istarci-'))
  assert.equal(await istarciServer(home), undefined)
  await mkdir(join(home, '.istarci'))
  await writeFile(join(home, '.istarci', 'config.yml'), 'server: [unclosed\n')
  assert.equal(await istarciServer(home), undefined)
  await writeFile(join(home, '.istarci', 'config.yml'), 'server:\n  webhookToken: abc\n')
  assert.deepEqual(await istarciServer(home), { url: 'http://127.0.0.1:7842', token: 'abc' })
})
