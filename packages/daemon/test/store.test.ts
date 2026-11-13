import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { before, test } from 'node:test'
import { createApi, parseSnapshots, parseStoredChanges, RequestError, type Report, type Root, type Run, type SnapshotDetail, type Store, type StoredFile } from '../src/index.js'

const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

const run: Run = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd, env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
    })
  })

async function git(folder: string, ...args: string[]): Promise<string> {
  const identity = ['-c', 'user.name=Ada', '-c', 'user.email=ada@example.test', '-c', 'commit.gpgsign=false']
  const result = await run('git', ['-C', folder, ...identity, ...args])
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

test('snapshots read from the log, a subject kept whole', () => {
  assert.deepEqual(parseSnapshots('c2\0Ada\x002026-11-10T18:12:00+01:00\0PC-A: snapshot of linux, 2026-11-10 18:12\nc1\0Ada\x002026-11-09T10:00:00+01:00\0First\n'), [
    { hash: 'c2', author: 'Ada', date: '2026-11-10T18:12:00+01:00', subject: 'PC-A: snapshot of linux, 2026-11-10 18:12' },
    { hash: 'c1', author: 'Ada', date: '2026-11-09T10:00:00+01:00', subject: 'First' },
  ])
})

test('the files a snapshot changed read with their letter, a renamed one with its earlier path', () => {
  assert.deepEqual(parseStoredChanges('M\0PC-A/linux/a.txt\0R100\0PC-A/linux/old.txt\0PC-A/linux/new.txt\0D\0PC-A/linux/gone.txt\0'), [
    { path: 'PC-A/linux/a.txt', status: 'M' },
    { path: 'PC-A/linux/new.txt', from: 'PC-A/linux/old.txt', status: 'R' },
    { path: 'PC-A/linux/gone.txt', status: 'D' },
  ])
  assert.deepEqual(parseStoredChanges(''), [])
})

let folder: string
let notes: string
let store: string
let configured: string
let api: ReturnType<typeof createApi>

const query = (values: Record<string, string>) => new URLSearchParams(values)

async function write(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(store, path)), { recursive: true })
  await writeFile(join(store, path), content)
}

async function snapshot(subject: string): Promise<string> {
  await git(notes, 'add', '--all')
  await git(notes, 'commit', '--quiet', '-m', subject)
  return git(notes, 'rev-parse', 'HEAD')
}

const hashes: Record<string, string> = {}

let measured = 0
let release: () => void = () => undefined
// A report that takes until it is released, as the real one takes the time of its commands.
const report = async (): Promise<Report> => {
  const count = ++measured
  await new Promise<void>((resolve) => (release = resolve))
  return { machine: 'PC-A', date: '2026-11-11T09:00:00.000Z', sections: [{ title: `Disk ${count}`, measures: [{ label: '/', bytes: 1000 }], hints: [] }] }
}

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'chade-store-'))
  // The store is a subfolder of a repository that holds other things, the harder of the two layouts.
  notes = join(folder, 'repos', 'notes')
  store = join(notes, 'systems')
  configured = store
  await mkdir(store, { recursive: true })
  await git(notes, 'init', '--quiet', '--initial-branch=main')
  await writeFile(join(notes, 'README.md'), '# notes\n')
  await write('PC-A/linux/files/etc/wsl.conf', '[boot]\nsystemd=true\n')
  await write('PC-A/linux/inventories/apt-manual.txt', 'git\nvim\n')
  await write('PC-A/linux/inventories/old name.txt', 'kept as it is, under another name\nline two\nline three\n')
  await write('PC-A/windows/files/C/Users/ada/.wslconfig', '[wsl2]\nmemory=8GB\n')
  hashes.first = await snapshot('PC-A: snapshot of linux, windows, 2026-11-09 10:00')
  await write('PC-B/linux/files/etc/hostname', 'pc-b\n')
  await write('PC-B/linux/files/icon.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
  hashes.other = await snapshot('PC-B: snapshot of linux, 2026-11-09 11:00')
  // A commit of the repository that is no snapshot, as it changes no machine.
  await writeFile(join(notes, 'README.md'), '# notes\n\nMore.\n')
  await snapshot('Write the notes')
  await write('PC-A/linux/inventories/apt-manual.txt', 'git\nvim\ncurl\n')
  await rename(join(store, 'PC-A/linux/inventories/old name.txt'), join(store, 'PC-A/linux/inventories/new name.txt'))
  await rm(join(store, 'PC-A/windows/files/C/Users/ada/.wslconfig'))
  await write('PC-A/windows/inventories/winget.json', '{}\n')
  hashes.second = await snapshot('PC-A: snapshot of linux, windows, 2026-11-10 18:12')
  await write('PC-A/linux/files/etc/wsl.conf', '[boot]\nsystemd=false\n')
  hashes.third = await snapshot('PC-A: snapshot of linux, windows, 2026-11-11 09:00')
  const root: Root = { system: 'linux', folder: join(folder, 'repos'), path: join(folder, 'repos'), separator: process.platform === 'win32' ? '\\' : '/', git: 'git' }
  api = createApi({ version: '1.2.3', machine: 'PC-A', roots: async () => [root], store: async () => configured, report, run })
})

test('the store gives its machines, their systems and their snapshots from the newest, and the repository holding it', async () => {
  const answer = (await api.store(query({}))) as Store & { machine: string }
  assert.equal(answer.machine, 'PC-A')
  assert.equal(answer.path, store)
  assert.equal(answer.error, undefined)
  assert.deepEqual(answer.repository, { system: 'linux', path: notes })
  assert.deepEqual(
    answer.machines.map((machine) => [machine.name, machine.systems, machine.snapshots.map((snapshot) => snapshot.hash), machine.more]),
    [
      ['PC-A', ['linux', 'windows'], [hashes.third, hashes.second, hashes.first], false],
      ['PC-B', ['linux'], [hashes.other], false],
    ],
  )
  assert.equal(answer.machines[0].snapshots[0].subject, 'PC-A: snapshot of linux, windows, 2026-11-11 09:00')
  assert.equal(answer.machines[0].snapshots[0].author, 'Ada')
})

test('a machine with more snapshots than asked says there is more', async () => {
  const answer = (await api.store(query({ limit: '2' }))) as Store
  assert.deepEqual(
    answer.machines.map((machine) => [machine.snapshots.length, machine.more]),
    [
      [2, true],
      [1, false],
    ],
  )
})

test('a snapshot gives what it changed since the one before on the same machine, with paths from the store', async () => {
  const detail = (await api.snapshot(query({ machine: 'PC-A', commit: hashes.second }))) as SnapshotDetail
  // The commits in between, of another machine and of the notes, are not what it is compared with.
  assert.equal(detail.previous, hashes.first)
  assert.equal(detail.commit?.message, 'PC-A: snapshot of linux, windows, 2026-11-10 18:12')
  assert.deepEqual(detail.changes, [
    { path: 'PC-A/linux/inventories/apt-manual.txt', status: 'M' },
    { path: 'PC-A/linux/inventories/new name.txt', from: 'PC-A/linux/inventories/old name.txt', status: 'R' },
    { path: 'PC-A/windows/files/C/Users/ada/.wslconfig', status: 'D' },
    { path: 'PC-A/windows/inventories/winget.json', status: 'A' },
  ])
  assert.match(detail.patch, /^diff --git a\/PC-A\/linux\/inventories\/apt-manual\.txt b\/PC-A\/linux\/inventories\/apt-manual\.txt$/m)
  assert.match(detail.patch, /^\+curl$/m)
  assert.doesNotMatch(detail.patch, /README|PC-B|systems\//)
  assert.equal(detail.truncated, false)
})

test('the first snapshot of a machine is compared with nothing, so every file is added', async () => {
  const detail = (await api.snapshot(query({ machine: 'PC-B', commit: hashes.other }))) as SnapshotDetail
  assert.equal(detail.previous, undefined)
  assert.deepEqual(detail.changes, [
    { path: 'PC-B/linux/files/etc/hostname', status: 'A' },
    { path: 'PC-B/linux/files/icon.bin', status: 'A' },
  ])
  assert.match(detail.patch, /^\+pc-b$/m)
})

test('a snapshot lists every file the machine had then, and gives the content of one', async () => {
  const { files } = (await api['snapshot-files'](query({ machine: 'PC-A', commit: hashes.first }))) as { files: string[] }
  assert.deepEqual(files, [
    'PC-A/linux/files/etc/wsl.conf',
    'PC-A/linux/inventories/apt-manual.txt',
    'PC-A/linux/inventories/old name.txt',
    'PC-A/windows/files/C/Users/ada/.wslconfig',
  ])
  const then = (await api['snapshot-file'](query({ machine: 'PC-A', commit: hashes.first, path: 'PC-A/linux/files/etc/wsl.conf' }))) as StoredFile
  assert.deepEqual(then, { path: 'PC-A/linux/files/etc/wsl.conf', content: '[boot]\nsystemd=true\n', truncated: false, binary: false })
  const now = (await api['snapshot-file'](query({ machine: 'PC-A', commit: hashes.third, path: 'PC-A/linux/files/etc/wsl.conf' }))) as StoredFile
  assert.equal(now.content, '[boot]\nsystemd=false\n')
})

test('a file that is not text is said so, without its bytes', async () => {
  const file = (await api['snapshot-file'](query({ machine: 'PC-B', commit: hashes.other, path: 'PC-B/linux/files/icon.bin' }))) as StoredFile
  assert.deepEqual(file, { path: 'PC-B/linux/files/icon.bin', content: '', truncated: false, binary: true })
})

test('a request reaches a machine, a snapshot and a file only among those git lists', async () => {
  const refused = async (route: 'snapshot' | 'snapshot-files' | 'snapshot-file', values: Record<string, string>, status: number) => {
    await assert.rejects(
      api[route](query(values)),
      (error: unknown) => error instanceof RequestError && error.status === status,
      `${route} ${JSON.stringify(values)}`,
    )
  }
  await refused('snapshot', { machine: 'PC-A' }, 400)
  await refused('snapshot', { machine: 'PC-C', commit: hashes.first }, 404)
  await refused('snapshot', { machine: '..', commit: hashes.first }, 404)
  await refused('snapshot', { machine: 'PC-A', commit: 'HEAD' }, 400)
  await refused('snapshot', { machine: 'PC-A', commit: '--all' }, 400)
  // A commit of the repository, and of the store, that is not one of that machine.
  await refused('snapshot', { machine: 'PC-A', commit: hashes.other }, 404)
  await refused('snapshot-files', { machine: 'PC-B', commit: hashes.third }, 404)
  await refused('snapshot-file', { machine: 'PC-A', commit: hashes.third }, 400)
  await refused('snapshot-file', { machine: 'PC-A', commit: hashes.third, path: '../README.md' }, 404)
  await refused('snapshot-file', { machine: 'PC-A', commit: hashes.third, path: 'PC-B/linux/files/etc/hostname' }, 404)
  // A file the machine no longer had at that snapshot.
  await refused('snapshot-file', { machine: 'PC-A', commit: hashes.third, path: 'PC-A/windows/files/C/Users/ada/.wslconfig' }, 404)
})

test('a store that is missing, in no repository, or without a snapshot yet, says so or lists no machine', async () => {
  try {
    configured = join(folder, 'nowhere')
    const missing = (await api.store(query({}))) as Store
    assert.deepEqual(missing.machines, [])
    assert.match(missing.error ?? '', /does not exist/)
    // The folder of the test is in no repository, unless the temporary folder itself is in one.
    configured = join(folder, 'empty')
    await mkdir(configured)
    await git(configured, 'init', '--quiet', '--initial-branch=main')
    const empty = (await api.store(query({}))) as Store
    assert.deepEqual([empty.machines, empty.error, empty.repository], [[], undefined, undefined])
    await assert.rejects(api.snapshot(query({ machine: 'PC-A', commit: hashes.first })), (error: unknown) => error instanceof RequestError && error.status === 404)
  } finally {
    configured = store
  }
})

test('a report asked while one is measured is that one, and the next one measures again', async () => {
  const first = api.report(query({}))
  const second = api.report(query({}))
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const [one, two] = (await Promise.all([first, second])) as { version: string; machine: string; scannedAt: string; sections: Report['sections'] }[]
  assert.equal(measured, 1)
  assert.deepEqual(one, { version: '1.2.3', machine: 'PC-A', scannedAt: '2026-11-11T09:00:00.000Z', sections: [{ title: 'Disk 1', measures: [{ label: '/', bytes: 1000 }], hints: [] }] })
  assert.deepEqual(two, one)
  const third = api.report(query({}))
  await new Promise((resolve) => setImmediate(resolve))
  release()
  assert.equal(((await third) as { sections: Report['sections'] }).sections[0].title, 'Disk 2')
})
