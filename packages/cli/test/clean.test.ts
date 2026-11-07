import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planCleanup, renderPlan, runCleanup, type Inherit } from '../src/clean.js'
import { NOT_FOUND, type Run } from '../src/exec.js'
import type { Host } from '../src/system.js'

const missing = new Set(['dotnet'])

const fakeRun: Run = async (command, args) => {
  if (command === 'sh' && args[1] === 'command -v "$1"') return { code: missing.has(args[3]) ? 1 : 0, stdout: '', stderr: '' }
  if (command === 'snap') return { code: 0, stdout: 'Name Version Rev Tracking Publisher Notes\ncups 2.4 1266 latest/stable openprinting disabled\n', stderr: '' }
  return { code: NOT_FOUND, stdout: '', stderr: '' }
}

const host: Host = { machine: 'TEST-PC', home: '/home/me', run: fakeRun, systems: [{ kind: 'linux', id: 'linux' }] }

test('steps run in a fixed order, custom ones before the trim, whatever the order of the configuration', async () => {
  const planned = await planCleanup(['fstrim', { name: 'mine', command: 'rm -rf ~/.cache/x' }, 'journal', 'docker-images'], host, false)
  assert.deepEqual(
    planned.map((step) => step.name),
    ['docker-images', 'journal', 'mine', 'fstrim'],
  )
})

test('a step that needs root runs through sudo, except for root itself', async () => {
  const [asUser] = await planCleanup(['journal'], host, false)
  assert.deepEqual(asUser.commands, [['sudo', 'journalctl', '--vacuum-size=500M']])
  const [asRoot] = await planCleanup(['journal'], host, true)
  assert.deepEqual(asRoot.commands, [['journalctl', '--vacuum-size=500M']])
})

test('each disabled snap revision is a command of its own', async () => {
  const [snaps] = await planCleanup(['snap-revisions'], host, false)
  assert.deepEqual(snaps.commands, [['sudo', 'snap', 'remove', 'cups', '--revision=1266']])
})

test('a step whose tool is not installed is skipped, and says why', async () => {
  const [nuget] = await planCleanup(['nuget-cache'], host, false)
  assert.equal(nuget.skipped, 'dotnet is not installed')
  assert.match(renderPlan([nuget]), /nuget-cache {2}skipped, dotnet is not installed/)
})

test('a failed step is reported, and the next steps still run', async () => {
  const calls: string[] = []
  const inherit: Inherit = async (command, args) => {
    calls.push([command, ...args].join(' '))
    return args.includes('exit 3') ? 3 : 0
  }
  const planned = await planCleanup([{ name: 'broken', command: 'exit 3' }, { name: 'fine', command: 'true' }, 'nuget-cache'], host, false)
  const result = await runCleanup(planned, inherit, () => {})
  assert.deepEqual(result, { ran: ['fine'], failed: ['broken'] })
  assert.deepEqual(calls, ['sh -c exit 3', 'sh -c true'])
})

test('from Windows, the Linux steps are skipped and the others run through cmd.exe', async () => {
  const windowsRun: Run = async (command, args) => {
    if (command === 'where') return { code: args[1] === 'dotnet' ? 1 : 0, stdout: '', stderr: '' }
    throw new Error(`${command} is not a Windows tool`)
  }
  const windowsHost: Host = { machine: 'TEST-PC', home: 'C:\\Users\\me', run: windowsRun, systems: [{ kind: 'windows', id: 'windows' }] }
  const planned = await planCleanup(['npm-cache', 'nuget-cache', 'journal', 'snap-revisions', 'fstrim', { name: 'temp', command: 'del /q "%TEMP%\\*.log"' }], windowsHost, false)
  assert.deepEqual(
    planned.map((step) => [step.name, step.skipped]),
    [
      ['npm-cache', undefined],
      ['nuget-cache', 'dotnet is not installed'],
      ['journal', 'for Linux only'],
      ['snap-revisions', 'for Linux only'],
      ['temp', undefined],
      ['fstrim', 'for Linux only'],
    ],
  )
  assert.deepEqual(planned[0].commands, [['cmd.exe', '/d', '/s', '/c', '"npm cache clean --force"']])
  assert.deepEqual(planned[4].commands, [['cmd.exe', '/d', '/s', '/c', '"del /q "%TEMP%\\*.log""']])
  assert.match(renderPlan(planned), /\$ del \/q "%TEMP%\\\*\.log"\n/)
})
