import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import type { Config } from '../src/config.js'
import { diffArgs } from '../src/diff.js'
import { NOT_FOUND, run, type Run } from '../src/exec.js'
import { snapshot, type Logger } from '../src/snapshot.js'
import type { Host } from '../src/system.js'
import { Windows } from '../src/windows.js'

// The store commits with an identity of its own, whatever the global git configuration of the machine running the tests holds: signing, hooks, a missing name.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'chade test'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'chade@example.test'

let root: string
let store: string
let drive: string
const warnings: string[] = []
const log: Logger = { info: () => {}, warn: (message) => warnings.push(message) }

// Stands in for the tools of a WSL machine, where C:\ is a folder of the test and every other command is the real one, git above all.
const fakeRun: Run = async (command, args, options) => {
  if (command === 'apt-mark') return { code: 0, stdout: 'git\ncurl\n', stderr: '' }
  if (command === 'snap') return { code: NOT_FOUND, stdout: '', stderr: '' }
  if (command === 'wslpath') return { code: 0, stdout: join(drive, args[1].slice(3).replaceAll('\\', '/')), stderr: '' }
  if (command === 'cmd.exe' && args[2] === 'echo') {
    const variables: Record<string, string> = { '%USERPROFILE%': 'C:\\Users\\me', '%TEMP%': 'C:\\Temp' }
    return { code: 0, stdout: `${variables[args[3]] ?? args[3]}\r\n`, stderr: '' }
  }
  if (command === 'winget.exe') {
    const output = join(drive, args[2].slice(3).replaceAll('\\', '/'))
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify({ CreationDate: new Date().toISOString(), Sources: [{ Packages: [{ PackageIdentifier: 'Git.Git' }] }] }))
    return { code: 0, stdout: '', stderr: '' }
  }
  return run(command, args, options)
}

function host(withWindows = false): Host {
  return {
    machine: 'TEST-PC',
    home: join(root, 'home'),
    run: fakeRun,
    windows: withWindows ? new Windows(fakeRun) : undefined,
    systems: withWindows ? [{ kind: 'windows', id: 'windows' }, { kind: 'linux', id: 'wsl-test' }] : [{ kind: 'linux', id: 'linux' }],
  }
}

async function commits(): Promise<number> {
  return Number((await run('git', ['-C', store, 'rev-list', '--count', 'HEAD'])).stdout.trim())
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'chade-snapshot-'))
  store = join(root, 'store')
  drive = join(root, 'c')
  warnings.length = 0
  await mkdir(store, { recursive: true })
  await run('git', ['-C', store, 'init', '--quiet', '--initial-branch=main'])
  await mkdir(join(root, 'home', '.app'), { recursive: true })
  await writeFile(join(root, 'home', '.app', 'config.yml'), 'url: https://example.test\ntoken: abc123\n')
})

test('a snapshot writes the files and inventories of the machine, redacted, in one commit', async () => {
  const config: Config = { store, linux: { files: ['~/.app/config.yml'], inventories: ['apt-manual', 'snap'], repos: [] }, redact: [], cleanup: [] }
  const result = await snapshot(config, host(), log, { secretScan: false })
  assert.ok(result.commit)
  const file = join(store, 'TEST-PC', 'linux', 'files', root.slice(1), 'home', '.app', 'config.yml')
  assert.equal(await readFile(file, 'utf8'), 'url: https://example.test\ntoken: ***\n')
  assert.equal(await readFile(join(store, 'TEST-PC', 'linux', 'inventories', 'apt-manual.txt'), 'utf8'), 'git\ncurl\n')
  // A tool that is not installed is no inventory at all, rather than an empty one that would read as "nothing installed".
  assert.ok(!existsSync(join(store, 'TEST-PC', 'linux', 'inventories', 'snap.txt')))
  assert.deepEqual(warnings, [])
  assert.equal(await commits(), 1)
})

test('an unchanged system commits nothing', async () => {
  const config: Config = { store, linux: { files: ['~/.app/config.yml'], inventories: [], repos: [] }, redact: [], cleanup: [] }
  await snapshot(config, host(), log, { secretScan: false })
  const second = await snapshot(config, host(), log, { secretScan: false })
  assert.equal(second.commit, undefined)
  assert.equal(await commits(), 1)
})

test('a file taken out of the configuration leaves the snapshot, and diff compares the last two', async () => {
  const config: Config = { store, linux: { files: ['~/.app/config.yml'], inventories: ['apt-manual'], repos: [] }, redact: [], cleanup: [] }
  await snapshot(config, host(), log, { secretScan: false })
  await snapshot({ ...config, linux: { ...config.linux!, files: [] } }, host(), log, { secretScan: false })
  assert.ok(!existsSync(join(store, 'TEST-PC', 'linux', 'files')))
  assert.equal(await commits(), 2)
  const args = await diffArgs(config, 'TEST-PC', run, undefined, { stat: true })
  const output = (await run('git', args)).stdout
  assert.match(output, /config\.yml/)
  assert.doesNotMatch(output, /apt-manual/)
})

test('a missing file is a warning, and the rest of the snapshot is still taken', async () => {
  const config: Config = { store, linux: { files: ['/no/such/file', '~/.app'], inventories: [], repos: [] }, redact: [], cleanup: [] }
  const result = await snapshot(config, host(), log, { secretScan: false })
  assert.ok(result.commit)
  assert.deepEqual(warnings, ['linux: /no/such/file: does not exist'])
})

test('a dry run writes and commits nothing', async () => {
  const config: Config = { store, linux: { files: ['~/.app/config.yml'], inventories: [], repos: [] }, redact: [], cleanup: [] }
  const result = await snapshot(config, host(), log, { dryRun: true })
  assert.equal(result.entries.size, 1)
  assert.ok(!existsSync(join(store, 'TEST-PC')))
})

test('on WSL, the Windows files and winget land in a windows folder beside the distribution', async () => {
  await mkdir(join(drive, 'Users', 'me'), { recursive: true })
  await writeFile(join(drive, 'Users', 'me', '.wslconfig'), '[wsl2]\nmemory=8GB\n')
  const config: Config = {
    store,
    linux: { files: [], inventories: ['apt-manual'], repos: [] },
    windows: { files: ['%USERPROFILE%\\.wslconfig'], inventories: ['winget'], repos: [] },
    redact: [],
    cleanup: [],
  }
  await snapshot(config, host(true), log, { secretScan: false })
  assert.equal(await readFile(join(store, 'TEST-PC', 'windows', 'files', 'C', 'Users', 'me', '.wslconfig'), 'utf8'), '[wsl2]\nmemory=8GB\n')
  const winget = await readFile(join(store, 'TEST-PC', 'windows', 'inventories', 'winget.json'), 'utf8')
  assert.match(winget, /Git\.Git/)
  assert.doesNotMatch(winget, /CreationDate/)
  // The export file is temporary, on the Windows side.
  assert.ok(!existsSync(join(drive, 'Temp', `chade-winget-${process.pid}.json`)))
  assert.ok(existsSync(join(store, 'TEST-PC', 'wsl-test', 'inventories', 'apt-manual.txt')))
  assert.deepEqual(warnings, [])
})

test('git-repos lists every repository under the folders and their remotes', async () => {
  const repos = join(root, 'home', 'repos')
  for (const name of ['one', 'group/two']) {
    await mkdir(join(repos, name), { recursive: true })
    await run('git', ['-C', join(repos, name), 'init', '--quiet'])
  }
  await run('git', ['-C', join(repos, 'one'), 'remote', 'add', 'origin', 'https://me:token@example.test/one.git'])
  const config: Config = { store, linux: { files: [], inventories: [], repos: ['~/repos', '~/missing'] }, redact: [], cleanup: [] }
  await snapshot(config, host(), log, { secretScan: false })
  const listing = await readFile(join(store, 'TEST-PC', 'linux', 'inventories', 'git-repos.txt'), 'utf8')
  assert.equal(listing, '~/repos/group/two\t-\n~/repos/one\torigin\thttps://me:***@example.test/one.git\n')
  assert.deepEqual(warnings, ['linux: repository folder ~/missing does not exist'])
})

test('a store outside of any git repository is refused', async () => {
  await rm(join(store, '.git'), { recursive: true })
  const config: Config = { store, linux: { files: [], inventories: [], repos: [] }, redact: [], cleanup: [] }
  await assert.rejects(snapshot(config, host(), log), /not a folder of a git repository, chade init creates it/)
})

const gitleaks = (await run('gitleaks', ['version'])).code === 0

test('a secret no redact key masks stops the commit', { skip: !gitleaks && 'gitleaks is not installed' }, async () => {
  // The key is put together at run time, so the scan of this repository never finds it in the source.
  const key = ['AKIA', 'Z3MZKLQRE6OJBN7X'].join('')
  await writeFile(join(root, 'home', '.app', 'aws'), `[default]\naws_access_key_id = ${key}\n`)
  const config: Config = { store, linux: { files: ['~/.app/aws'], inventories: [], repos: [] }, redact: [], cleanup: [] }
  await assert.rejects(snapshot(config, host(), log), /gitleaks found a secret in the snapshot, nothing was committed/)
  assert.equal((await run('git', ['-C', store, 'rev-list', '--count', 'HEAD'])).code, 128)
  assert.equal((await run('git', ['-C', store, 'diff', '--cached', '--name-only'])).stdout, '')
})

test('a store in a subfolder of a repository commits only its machine folder, and leaves the rest of the repository alone', async () => {
  const repository = join(root, 'notes')
  const subfolder = join(repository, 'systems')
  await mkdir(subfolder, { recursive: true })
  await run('git', ['-C', repository, 'init', '--quiet', '--initial-branch=main'])
  await writeFile(join(repository, 'todo.md'), '# Todo\n')
  await run('git', ['-C', repository, 'add', 'todo.md'])
  const config: Config = { store: subfolder, linux: { files: ['~/.app/config.yml'], inventories: [], repos: [] }, redact: [], cleanup: [] }
  const result = await snapshot(config, host(), log, { secretScan: false })
  assert.ok(result.commit)
  const committed = (await run('git', ['-C', repository, 'show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n')
  assert.ok(committed.every((path) => path.startsWith('systems/TEST-PC/linux/')), committed.join(', '))
  // The file staged before the snapshot is still staged, and still not committed.
  assert.equal((await run('git', ['-C', repository, 'diff', '--cached', '--name-only'])).stdout.trim(), 'todo.md')
  const args = await diffArgs(config, 'TEST-PC', run, undefined, {})
  assert.match((await run('git', args)).stdout, /systems\/TEST-PC\/linux\/files/)
})
