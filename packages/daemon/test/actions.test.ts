import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { createActions, createApi, RequestError, type Root, type Run } from '../src/index.js'

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.test',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.test',
}

const run: Run = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: options.cwd, env }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr })
    })
  })

async function git(folder: string, ...args: string[]): Promise<string> {
  const result = await run('git', ['-C', folder, ...args])
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

let folder: string
let work: string
let other: string
let action: (request: Record<string, unknown>) => Promise<{ output: string }>
// The commits deleting a branch would lose, as the interface asks before it deletes.
let lost: (name: string) => Promise<number>

// The status a request is refused with, 200 when it is not.
async function status(request: Record<string, unknown>): Promise<number> {
  try {
    await action(request)
    return 200
  } catch (error) {
    return error instanceof RequestError ? error.status : 500
  }
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'chade-actions-'))
  const origin = join(folder, 'origin.git')
  work = join(folder, 'repos', 'work')
  other = join(folder, 'other')
  await mkdir(origin)
  await mkdir(work, { recursive: true })
  await git(origin, 'init', '--quiet', '--bare', '--initial-branch=main')
  await git(work, 'init', '--quiet', '--initial-branch=main')
  await writeFile(join(work, 'a.txt'), 'one\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '--quiet', '-m', 'Start')
  await git(work, 'remote', 'add', 'origin', origin)
  await git(work, 'push', '--quiet', '--set-upstream', 'origin', 'main')
  await git(folder, 'clone', '--quiet', origin, other)
  const root: Root = { system: 'linux', folder: join(folder, 'repos'), path: join(folder, 'repos'), separator: process.platform === 'win32' ? '\\' : '/', git: 'git' }
  const options = { version: '1.2.3', machine: 'TEST-PC', roots: async () => [root], store: async () => '', report: async () => ({ machine: 'TEST-PC', date: '', sections: [] }), run }
  const actions = createActions(options)
  const api = createApi(options)
  lost = async (name) => ((await api.branch(new URLSearchParams({ system: 'linux', path: work, name }))) as { lost: number }).lost
  action = (request) => actions.action({ system: 'linux', path: work, ...request }) as Promise<{ output: string }>
})

test('a fetch brings what the remote has, and a pull moves the branch to it', async () => {
  await writeFile(join(other, 'b.txt'), 'from elsewhere\n')
  await git(other, 'add', '.')
  await git(other, 'commit', '--quiet', '-m', 'Add b')
  await git(other, 'push', '--quiet')
  await action({ action: 'fetch' })
  assert.equal(await git(work, 'rev-list', '--count', 'HEAD..origin/main'), '1')
  await action({ action: 'pull' })
  assert.equal(await git(work, 'log', '-1', '--format=%s'), 'Add b')
})

test('a pull of a branch that diverged merges it, and a conflict aborts the merge with what git says', async () => {
  await writeFile(join(other, 'b.txt'), 'from elsewhere\n')
  await git(other, 'add', '.')
  await git(other, 'commit', '--quiet', '-m', 'Add b')
  await git(other, 'push', '--quiet')
  await writeFile(join(work, 'c.txt'), 'local\n')
  await git(work, 'add', '.')
  await git(work, 'commit', '--quiet', '-m', 'Add c')
  // A setting that would otherwise refuse, or rebase, is overridden.
  await git(work, 'config', 'pull.ff', 'only')
  await action({ action: 'pull' })
  assert.equal(await git(work, 'log', '-1', '--format=%p'), `${await git(work, 'rev-parse', '--short', 'HEAD^1')} ${await git(work, 'rev-parse', '--short', 'origin/main')}`)
  assert.equal(await git(work, 'status', '--porcelain'), '')

  await writeFile(join(other, 'a.txt'), 'theirs\n')
  await git(other, 'commit', '--quiet', '-am', 'Change a there')
  await git(other, 'push', '--quiet')
  await writeFile(join(work, 'a.txt'), 'ours\n')
  await git(work, 'commit', '--quiet', '-am', 'Change a here')
  const before = await git(work, 'rev-parse', 'HEAD')
  await assert.rejects(action({ action: 'pull' }), (error: RequestError) => error.status === 409 && /CONFLICT/.test(error.message) && /aborted/.test(error.message))
  assert.equal(await git(work, 'rev-parse', 'HEAD'), before)
  assert.equal(await git(work, 'status', '--porcelain'), '')
  assert.equal((await run('git', ['-C', work, 'rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])).code, 1)
})

test('files are staged and unstaged by name or all at once, a renamed one with both its paths', async () => {
  await writeFile(join(work, 'a.txt'), 'two\n')
  await writeFile(join(work, 'new.txt'), 'new\n')
  await action({ action: 'stage', files: ['new.txt'] })
  assert.equal(await git(work, 'diff', '--cached', '--name-only'), 'new.txt')
  await action({ action: 'stage' })
  assert.equal(await git(work, 'diff', '--cached', '--name-only'), 'a.txt\nnew.txt')
  await action({ action: 'unstage', files: ['a.txt'] })
  assert.equal(await git(work, 'diff', '--cached', '--name-only'), 'new.txt')
  await action({ action: 'unstage' })
  assert.equal(await git(work, 'diff', '--cached', '--name-only'), '')

  await git(work, 'checkout', '--quiet', '--', 'a.txt')
  await rename(join(work, 'a.txt'), join(work, 'renamed.txt'))
  await action({ action: 'stage', files: ['a.txt', 'renamed.txt'] })
  assert.match(await git(work, 'status', '--porcelain'), /^R {2}a\.txt -> renamed\.txt$/m)
  await action({ action: 'unstage', files: ['renamed.txt'] })
  assert.equal(await git(work, 'diff', '--cached', '--name-only'), '')
})

test('a commit takes what is staged, with its message, lines and all', async () => {
  await writeFile(join(work, 'a.txt'), 'two\n')
  await writeFile(join(work, 'left.txt'), 'not staged\n')
  await action({ action: 'stage', files: ['a.txt'] })
  await action({ action: 'commit', message: '  Change a\n\nWith a body, and a "quote".\n' })
  assert.equal(await git(work, 'log', '-1', '--format=%B'), 'Change a\n\nWith a body, and a "quote".')
  assert.equal(await git(work, 'status', '--porcelain'), '?? left.txt')
  assert.equal(await status({ action: 'commit', message: 'Nothing staged' }), 400)
  assert.equal(await status({ action: 'commit', message: '   ' }), 400)
})

test('an amend rewrites the last commit with what is staged and a new message, until it is pushed', async () => {
  await writeFile(join(work, 'a.txt'), 'two\n')
  await action({ action: 'stage' })
  await action({ action: 'commit', message: 'Change a' })
  await writeFile(join(work, 'b.txt'), 'forgotten\n')
  await action({ action: 'stage' })
  await action({ action: 'amend', message: 'Change a, and add b' })
  assert.equal(await git(work, 'rev-list', '--count', 'origin/main..HEAD'), '1')
  assert.equal(await git(work, 'log', '-1', '--format=%s'), 'Change a, and add b')
  assert.equal(await git(work, 'show', '--format=', '--name-only', 'HEAD'), 'a.txt\nb.txt')
  // Nothing staged: the message alone changes.
  await action({ action: 'amend', message: 'Reworded' })
  assert.equal(await git(work, 'log', '-1', '--format=%s'), 'Reworded')
  assert.equal(await status({ action: 'amend', message: '  ' }), 400)
  await action({ action: 'push' })
  assert.equal(await status({ action: 'amend', message: 'Too late' }), 400)
  assert.equal(await git(work, 'log', '-1', '--format=%s'), 'Reworded')
})

test('a push sends the branch, and gives a branch never pushed its upstream', async () => {
  await writeFile(join(work, 'a.txt'), 'two\n')
  await action({ action: 'stage' })
  await action({ action: 'commit', message: 'Change a' })
  await action({ action: 'push' })
  assert.equal(await git(work, 'rev-list', '--count', 'origin/main..HEAD'), '0')
  await action({ action: 'branch', branch: 'feature/new' })
  assert.equal(await git(work, 'branch', '--show-current'), 'feature/new')
  await action({ action: 'push' })
  assert.equal(await git(work, 'rev-parse', '--abbrev-ref', 'feature/new@{upstream}'), 'origin/feature/new')
  await git(work, 'checkout', '--quiet', '--detach')
  assert.equal(await status({ action: 'push' }), 400)
})

test('a branch is checked out by its name, a remote one as the local branch that tracks it', async () => {
  await git(other, 'switch', '--quiet', '--create', 'remote-only')
  await git(other, 'push', '--quiet', '--set-upstream', 'origin', 'remote-only')
  await action({ action: 'fetch' })
  await action({ action: 'checkout', branch: 'origin/remote-only' })
  assert.equal(await git(work, 'branch', '--show-current'), 'remote-only')
  assert.equal(await git(work, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/remote-only')
  await action({ action: 'checkout', branch: 'main' })
  assert.equal(await git(work, 'branch', '--show-current'), 'main')
  // The local branch exists now, and is the one checked out again.
  await action({ action: 'checkout', branch: 'origin/remote-only' })
  assert.equal(await git(work, 'branch', '--show-current'), 'remote-only')
})

test('a branch that is not checked out is pulled by a fast forward, and refused once it diverged', async () => {
  await action({ action: 'branch', branch: 'feature' })
  await writeFile(join(work, 'local.txt'), 'not committed\n')
  await writeFile(join(other, 'b.txt'), 'from elsewhere\n')
  await git(other, 'add', '.')
  await git(other, 'commit', '--quiet', '-m', 'Add b')
  await git(other, 'push', '--quiet')
  await action({ action: 'pull', branch: 'main' })
  assert.equal(await git(work, 'log', '-1', '--format=%s', 'main'), 'Add b')
  assert.equal(await git(work, 'rev-parse', 'origin/main'), await git(work, 'rev-parse', 'main'))
  // The branch checked out and its working tree are as they were.
  assert.equal(await git(work, 'branch', '--show-current'), 'feature')
  assert.equal(await git(work, 'log', '-1', '--format=%s'), 'Start')
  assert.equal(await git(work, 'status', '--porcelain'), '?? local.txt')
  assert.equal(await status({ action: 'pull', branch: 'main' }), 200)

  await git(work, 'branch', '--force', 'main', 'main~1')
  await git(work, 'switch', '--quiet', 'main')
  await git(work, 'commit', '--quiet', '--allow-empty', '-m', 'Local only')
  await git(work, 'switch', '--quiet', 'feature')
  const before = await git(work, 'rev-parse', 'main')
  await assert.rejects(action({ action: 'pull', branch: 'main' }), (error: RequestError) => error.status === 409 && /once checked out/.test(error.message))
  assert.equal(await git(work, 'rev-parse', 'main'), before)
  // A branch that tracks nothing, a remote one and one git does not list have nothing to pull.
  await git(work, 'branch', 'untracked')
  assert.equal(await status({ action: 'pull', branch: 'untracked' }), 400)
  assert.equal(await status({ action: 'pull', branch: 'origin/main' }), 400)
  assert.equal(await status({ action: 'pull', branch: '--all' }), 400)
})

test('a pull that names the branch checked out is the pull of the working tree', async () => {
  await writeFile(join(other, 'b.txt'), 'from elsewhere\n')
  await git(other, 'add', '.')
  await git(other, 'commit', '--quiet', '-m', 'Add b')
  await git(other, 'push', '--quiet')
  await action({ action: 'pull', branch: 'main' })
  assert.equal(await git(work, 'log', '-1', '--format=%s'), 'Add b')
  assert.equal(await git(work, 'status', '--porcelain'), '')
})

test('a branch is deleted, its own commits lost only when the request says so', async () => {
  // Squash merged on the remote: the branch holds commits that main never will.
  await action({ action: 'branch', branch: 'squashed' })
  await git(work, 'commit', '--quiet', '--allow-empty', '-m', 'One')
  await git(work, 'commit', '--quiet', '--allow-empty', '-m', 'Two')
  await git(work, 'branch', 'merged', 'main')
  await git(work, 'branch', 'pushed')
  await git(work, 'push', '--quiet', 'origin', 'pushed')
  await git(work, 'switch', '--quiet', 'main')
  assert.equal(await lost('merged'), 0)
  assert.equal(await lost('squashed'), 0)
  await action({ action: 'delete', branch: 'merged' })
  // The remote branch holds the commits, so nothing is lost, where git branch --delete would refuse.
  await action({ action: 'delete', branch: 'pushed' })
  await git(work, 'push', '--quiet', 'origin', '--delete', 'pushed')
  assert.equal(await lost('squashed'), 2)
  await assert.rejects(action({ action: 'delete', branch: 'squashed' }), (error: RequestError) => error.status === 409 && /^2 commits of squashed are in no other branch/.test(error.message))
  assert.equal(await git(work, 'branch', '--format=%(refname:short)'), 'main\nsquashed')
  await action({ action: 'delete', branch: 'squashed', force: true })
  assert.equal(await git(work, 'branch', '--format=%(refname:short)'), 'main')
  // The branch checked out stays, as a remote branch, an option and a name git does not list.
  for (const branch of ['main', 'origin/main', '--all', 'nowhere', undefined]) {
    assert.equal(await status({ action: 'delete', branch, force: true }), 400, branch)
  }
  await assert.rejects(lost('origin/main'), (error: RequestError) => error.status === 400)
  await assert.rejects(lost('--all'), (error: RequestError) => error.status === 400)
})

test('a branch is created from HEAD or from a commit, under a name git accepts', async () => {
  const start = await git(work, 'rev-parse', 'HEAD')
  await writeFile(join(work, 'a.txt'), 'two\n')
  await git(work, 'commit', '--quiet', '-am', 'Change a')
  await action({ action: 'branch', branch: 'from-start', from: start })
  assert.equal(await git(work, 'rev-parse', 'HEAD'), start)
  for (const branch of ['', '-b', '--orphan', 'two words', 'a..b', 'from-start']) {
    assert.notEqual(await status({ action: 'branch', branch }), 200, branch)
  }
  assert.equal(await status({ action: 'branch', branch: 'x', from: 'main' }), 400)
  assert.equal(await git(work, 'branch', '--show-current'), 'from-start')
})

test('a request reaches no option, no ref and no file but those the repository lists', async () => {
  await writeFile(join(work, 'new.txt'), 'new\n')
  assert.equal(await status({ action: 'checkout', branch: '--orphan' }), 400)
  assert.equal(await status({ action: 'checkout', branch: 'nowhere' }), 400)
  assert.equal(await status({ action: 'checkout' }), 400)
  assert.equal(await status({ action: 'stage', files: ['../../other/README.md'] }), 400)
  assert.equal(await status({ action: 'stage', files: ['a.txt'] }), 400)
  assert.equal(await status({ action: 'stage', files: [] }), 400)
  assert.equal(await status({ action: 'stage', files: 'new.txt' }), 400)
  assert.equal(await status({ action: 'unstage', files: ['--hard'] }), 400)
  assert.equal(await status({ action: 'reset' }), 400)
  assert.equal(await status({ action: 'push', path: other }), 404)
  assert.equal(await status({ action: 'fetch', system: 'windows' }), 404)
  assert.equal(await status({ path: undefined, action: 'fetch' }), 400)
  assert.equal(await git(work, 'status', '--porcelain'), '?? new.txt')
})

test('one action runs in a repository at a time', async () => {
  const [first, second] = await Promise.all([status({ action: 'fetch' }), status({ action: 'fetch' })])
  assert.deepEqual([first, second].sort(), [200, 409])
  assert.equal(await status({ action: 'fetch' }), 200)
})
