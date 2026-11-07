import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Run } from '../src/exec.js'
import { detectHost, systemKinds } from '../src/system.js'

const calls: string[] = []

// Answers cmd.exe the way a Windows host does, and fails any other command, so a test sees which tools a host reaches.
const fakeRun: Run = async (command, args) => {
  calls.push(command)
  if (command === 'cmd.exe' && args.join(' ') === '/d /c echo %COMPUTERNAME%') return { code: 0, stdout: 'DESKTOP-TEST\r\n', stderr: '' }
  return { code: 1, stdout: '', stderr: `${command} is not expected` }
}

test('Windows captures Windows alone, WSL the distribution and its Windows host', () => {
  assert.deepEqual(systemKinds('win32', {}), ['windows'])
  assert.deepEqual(systemKinds('linux', { WSL_DISTRO_NAME: 'Ubuntu' }), ['windows', 'linux'])
  assert.throws(() => systemKinds('darwin', {}), /runs on Linux, on WSL and on Windows/)
})

test('on Windows, the host is the Windows system, named after the computer, and reads its paths as they are', async () => {
  calls.length = 0
  const host = await detectHost({ platform: 'win32', env: { COMPUTERNAME: 'DESKTOP-TEST', HOME: 'C:\\Users\\me' }, run: fakeRun })
  assert.equal(host.machine, 'DESKTOP-TEST')
  assert.deepEqual(host.systems, [{ kind: 'windows', id: 'windows' }])
  assert.equal(await host.windows?.linuxPath('C:\\Users\\me\\.wslconfig'), 'C:\\Users\\me\\.wslconfig')
  // cmd.exe runs from the folder chade runs from, since /mnt/c means nothing on Windows.
  assert.equal(host.windows?.cwd(), undefined)
  assert.deepEqual(calls, [])
})

test('on WSL, the host is the Windows computer name, with the Windows system and the distribution', async () => {
  const host = await detectHost({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu', HOME: '/home/me' }, run: fakeRun })
  assert.equal(host.machine, 'DESKTOP-TEST')
  assert.deepEqual(host.systems, [
    { kind: 'windows', id: 'windows' },
    { kind: 'linux', id: 'wsl-ubuntu' },
  ])
})

test('the machine of the configuration names the host on Windows too', async () => {
  const host = await detectHost({ platform: 'win32', env: { COMPUTERNAME: 'DESKTOP-TEST' }, machine: 'laptop', run: fakeRun })
  assert.equal(host.machine, 'laptop')
})
