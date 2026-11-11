import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { createApi, parseBranches, parseChanges, parseCommits, RequestError, type Detail, type Diff, type Root, type Run } from '../src/index.js'

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

test('branches read with their upstream and what they are ahead and behind by, the HEAD of a remote left out', () => {
  const text = [
    'refs/heads/main\0aaa\0origin/main\0ahead 2, behind 1\0*',
    'refs/heads/old\0bbb\0origin/old\0gone\0 ',
    'refs/heads/local\0ccc\0\0\0 ',
    'refs/remotes/origin/HEAD\0aaa\0\0\0 ',
    'refs/remotes/origin/main\0ddd\0\0\0 ',
    '',
  ].join('\n')
  assert.deepEqual(parseBranches(text), [
    { name: 'main', remote: false, head: true, commit: 'aaa', upstream: 'origin/main', ahead: 2, behind: 1 },
    { name: 'old', remote: false, head: false, commit: 'bbb', upstream: 'origin/old', gone: true },
    { name: 'local', remote: false, head: false, commit: 'ccc' },
    { name: 'origin/main', remote: true, head: false, commit: 'ddd' },
  ])
})

test('commits read with their parents and the names pointing at them', () => {
  const text = ['c3\0c2 b1\0Ada\x002026-11-10T10:00:00+01:00\0HEAD -> main, tag: v1.0, origin/main\0Merge the feature', 'c1\0\0Ada\x002026-11-09T10:00:00+01:00\0\0Start', ''].join('\n')
  assert.deepEqual(parseCommits(text), [
    { hash: 'c3', parents: ['c2', 'b1'], author: 'Ada', date: '2026-11-10T10:00:00+01:00', refs: ['HEAD -> main', 'tag: v1.0', 'origin/main'], subject: 'Merge the feature' },
    { hash: 'c1', parents: [], author: 'Ada', date: '2026-11-09T10:00:00+01:00', refs: [], subject: 'Start' },
  ])
})

test('changed files read with what is staged and what is not, a renamed one with its earlier path', () => {
  assert.deepEqual(parseChanges('M  staged.txt\0 M edited.txt\0MM both.txt\0R  new name.txt\0old name.txt\0?? notes.txt\0UU conflict.txt\0'), [
    { path: 'staged.txt', staged: 'M', unstaged: ' ' },
    { path: 'edited.txt', staged: ' ', unstaged: 'M' },
    { path: 'both.txt', staged: 'M', unstaged: 'M' },
    { path: 'new name.txt', staged: 'R', unstaged: ' ', from: 'old name.txt' },
    { path: 'notes.txt', staged: ' ', unstaged: '?' },
    { path: 'conflict.txt', staged: 'U', unstaged: 'U' },
  ])
})

let root: Root
let work: string
let api: ReturnType<typeof createApi>

const query = (values: Record<string, string>) => new URLSearchParams(values)

before(async () => {
  const folder = await mkdtemp(join(tmpdir(), 'chade-history-'))
  work = join(folder, 'repos', 'work')
  await mkdir(work, { recursive: true })
  await git(work, 'init', '--quiet', '--initial-branch=main')
  await writeFile(join(work, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(work, 'gone.txt'), 'bye\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '--quiet', '-m', 'Start')
  await git(work, 'switch', '--quiet', '--create', 'feature')
  await writeFile(join(work, 'b.txt'), 'feature\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '--quiet', '-m', 'Add b')
  await git(work, 'switch', '--quiet', 'main')
  await writeFile(join(work, 'a.txt'), 'one\n2\n')
  await rm(join(work, 'gone.txt'))
  await git(work, 'commit', '--quiet', '-am', 'Change a, and remove a file\n\nWith a body.')
  await git(work, 'merge', '--quiet', '--no-ff', '-m', 'Merge feature', 'feature')
  await git(work, 'tag', 'v1.0')
  // Staged, changed and untracked, one of each.
  await rename(join(work, 'b.txt'), join(work, 'c.txt'))
  await git(work, 'add', '--all')
  await writeFile(join(work, 'a.txt'), 'one\n2\nthree\n')
  await writeFile(join(work, 'new.txt'), 'new\n')
  root = { system: 'linux', folder: join(folder, 'repos'), path: join(folder, 'repos'), separator: process.platform === 'win32' ? '\\' : '/', git: 'git' }
  api = createApi({ version: '1.2.3', machine: 'TEST-PC', roots: async () => [root], store: async () => '', report: async () => ({ machine: 'TEST-PC', date: '', sections: [] }), run })
})

test('a repository gives its branches, its history from the newest commit, and the files changed', async () => {
  const detail = (await api.repository(query({ system: 'linux', path: work }))) as Detail
  assert.equal(detail.repository.name, 'work')
  assert.equal(detail.repository.branch, 'main')
  assert.deepEqual(
    detail.branches.map((branch) => [branch.name, branch.head]),
    [
      ['feature', false],
      ['main', true],
    ],
  )
  assert.deepEqual(detail.commits.map((commit) => commit.subject).sort(), ['Add b', 'Change a, and remove a file', 'Merge feature', 'Start'])
  const [merge] = detail.commits
  assert.equal(merge.subject, 'Merge feature')
  assert.equal(merge.parents.length, 2)
  assert.deepEqual(merge.refs, ['HEAD -> main', 'tag: v1.0'])
  assert.equal(merge.author, 'Ada')
  assert.equal(detail.commits.at(-1)?.subject, 'Start')
  assert.equal(detail.more, false)
  assert.deepEqual(detail.changes, [
    { path: 'a.txt', staged: ' ', unstaged: 'M' },
    { path: 'c.txt', staged: 'R', unstaged: ' ', from: 'b.txt' },
    { path: 'new.txt', staged: ' ', unstaged: '?' },
  ])
})

test('a history longer than asked says there is more', async () => {
  const detail = (await api.repository(query({ system: 'linux', path: work, limit: '2' }))) as Detail
  assert.equal(detail.commits.length, 2)
  assert.equal(detail.more, true)
})

test('the diff of a commit gives its message and its patch, a merge against its first parent', async () => {
  const detail = (await api.repository(query({ system: 'linux', path: work }))) as Detail
  const change = detail.commits.find((commit) => commit.subject.startsWith('Change a'))
  const diff = (await api.diff(query({ system: 'linux', path: work, target: change?.hash ?? '' }))) as Diff
  assert.equal(diff.commit?.message, 'Change a, and remove a file\n\nWith a body.')
  assert.equal(diff.commit?.email, 'ada@example.test')
  assert.match(diff.patch, /^diff --git a\/a\.txt b\/a\.txt/m)
  assert.match(diff.patch, /^-two$/m)
  assert.match(diff.patch, /^\+2$/m)
  assert.match(diff.patch, /^deleted file mode/m)
  assert.equal(diff.truncated, false)
  const merge = (await api.diff(query({ system: 'linux', path: work, target: detail.commits[0].hash }))) as Diff
  assert.match(merge.patch, /^\+feature$/m)
})

test('the diff of the working tree is what is staged, or what is changed and not staged', async () => {
  const staged = (await api.diff(query({ system: 'linux', path: work, target: 'staged' }))) as Diff
  assert.equal(staged.commit, undefined)
  assert.match(staged.patch, /^rename from b\.txt$/m)
  assert.doesNotMatch(staged.patch, /three/)
  const unstaged = (await api.diff(query({ system: 'linux', path: work, target: 'unstaged' }))) as Diff
  assert.match(unstaged.patch, /^\+three$/m)
  assert.doesNotMatch(unstaged.patch, /rename/)
  // A file not tracked yet reads as a new file, with its every line added.
  const untracked = (await api.diff(query({ system: 'linux', path: work, target: 'untracked' }))) as Diff
  assert.match(untracked.patch, /^diff --git a\/new\.txt b\/new\.txt$/m)
  assert.match(untracked.patch, /^new file mode/m)
  assert.match(untracked.patch, /^\+new$/m)
  assert.doesNotMatch(untracked.patch, /three/)
  assert.equal(untracked.truncated, false)
})

test('a request reaches only a repository under the repos folders, and only a commit by its full hash', async () => {
  const status = async (call: Promise<unknown>) => {
    try {
      await call
      return 200
    } catch (error) {
      return error instanceof RequestError ? error.status : 500
    }
  }
  assert.equal(await status(api.repository(query({ system: 'linux' }))), 400)
  assert.equal(await status(api.repository(query({ system: 'linux', path: join(work, '..', '..') }))), 404)
  assert.equal(await status(api.repository(query({ system: 'linux', path: '/' }))), 404)
  assert.equal(await status(api.repository(query({ system: 'windows', path: work }))), 404)
  assert.equal(await status(api.diff(query({ system: 'linux', path: '/etc', target: 'staged' }))), 404)
  for (const target of ['', 'HEAD', 'main', '--output=/tmp/x', 'abc123', '-p']) {
    assert.equal(await status(api.diff(query({ system: 'linux', path: work, target }))), 400, target)
  }
  // A full hash that names no commit is an error of git, not a refused request.
  assert.equal(await status(api.diff(query({ system: 'linux', path: work, target: '0'.repeat(40) }))), 500)
})
