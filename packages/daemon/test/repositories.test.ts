import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findRepositories, listRepositories, parseStatus, type Root, type Run } from '../src/index.js'

const run: Run = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
    })
  })

async function git(folder: string, ...args: string[]): Promise<void> {
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false']
  const result = await run('git', ['-C', folder, ...identity, ...args])
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`)
}

function rootOf(folder: string): Root {
  return { system: 'linux', folder, path: folder, separator: process.platform === 'win32' ? '\\' : '/', git: 'git' }
}

test('a status gives the branch, its upstream, what it is ahead and behind by, and what changed', () => {
  const status = parseStatus(
    [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567',
      '# branch.head feature/ui',
      '# branch.upstream origin/feature/ui',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb README.md',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\told.txt',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
      '? notes.txt',
      '',
    ].join('\n'),
  )
  assert.deepEqual(status, { head: '0123456', branch: 'feature/ui', upstream: 'origin/feature/ui', ahead: 2, behind: 1, changed: 2, untracked: 1, conflicts: 1 })
})

test('a status before the first commit, or on a detached HEAD, has no commit, or no branch', () => {
  assert.deepEqual(parseStatus('# branch.oid (initial)\n# branch.head main\n'), { branch: 'main', changed: 0, untracked: 0, conflicts: 0 })
  assert.equal(parseStatus('# branch.oid 0123456789abcdef\n# branch.head (detached)\n').branch, undefined)
})

test('the repositories of a folder are found three levels deep, and nothing is searched inside one', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'chade-find-'))
  for (const path of ['a/.git', 'group/b/.git', 'group/b/nested/.git', 'one/two/three/c/.git', 'node_modules/d/.git', '.hidden/e/.git', 'plain']) {
    await mkdir(join(folder, path), { recursive: true })
  }
  assert.deepEqual(await findRepositories(folder), [['a'], ['group', 'b']])
})

test('each repository of a root is listed with its branch, its changes, its last commit and what it is ahead of its upstream by', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'chade-repos-'))
  const origin = join(folder, 'remotes', 'origin.git')
  await mkdir(origin, { recursive: true })
  await git(origin, 'init', '--quiet', '--bare', '--initial-branch=main')
  const work = join(folder, 'work')
  for (const name of ['pushed', 'empty']) {
    await mkdir(join(work, name), { recursive: true })
    await git(join(work, name), 'init', '--quiet', '--initial-branch=main')
  }
  const pushed = join(work, 'pushed')
  await writeFile(join(pushed, 'a.txt'), 'one\n')
  await git(pushed, 'add', '.')
  await git(pushed, 'commit', '--quiet', '-m', 'First commit')
  await git(pushed, 'remote', 'add', 'origin', origin)
  await git(pushed, 'push', '--quiet', '--set-upstream', 'origin', 'main')
  await writeFile(join(pushed, 'a.txt'), 'two\n')
  await git(pushed, 'commit', '--quiet', '-am', 'Second <b>commit</b>')
  await writeFile(join(pushed, 'a.txt'), 'three\n')
  await writeFile(join(pushed, 'b.txt'), 'new\n')

  const missing = join(folder, 'missing')
  const listing = await listRepositories([rootOf(work), rootOf(missing)], run)
  assert.deepEqual(listing.warnings, [`linux: the repository folder ${missing} does not exist`])
  assert.deepEqual(
    listing.repositories.map((repository) => repository.name),
    ['empty', 'pushed'],
  )
  const [empty, repository] = listing.repositories
  assert.deepEqual(empty, { system: 'linux', name: 'empty', path: join(work, 'empty'), branch: 'main', changed: 0, untracked: 0, conflicts: 0 })
  assert.equal(repository.path, pushed)
  assert.equal(repository.branch, 'main')
  assert.equal(repository.upstream, 'origin/main')
  // A remote that is a folder is plain git, with no host.
  assert.deepEqual(repository.remote, { name: 'origin', forge: 'git' })
  assert.deepEqual([repository.ahead, repository.behind], [1, 0])
  assert.deepEqual([repository.changed, repository.untracked, repository.conflicts], [1, 1, 0])
  assert.equal(repository.commit?.subject, 'Second <b>commit</b>')
  assert.ok(!Number.isNaN(Date.parse(repository.commit?.date ?? '')))
  assert.equal(repository.error, undefined)
})

test('a root that is a repository itself is named after its folder, and a folder git refuses is listed with the reason', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'chade-root-'))
  const broken = join(folder, 'broken')
  // A .git that is no repository, as an interrupted clone leaves.
  await mkdir(join(broken, '.git'), { recursive: true })
  const { repositories } = await listRepositories([rootOf(broken)], run)
  assert.equal(repositories.length, 1)
  assert.equal(repositories[0].name, 'broken')
  assert.match(repositories[0].error ?? '', /not a git repository/)
})
