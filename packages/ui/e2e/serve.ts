// The server of chade ui, as shipped, over the built interface and repositories made for the run.
// The repositories are real ones, read by git, each in one of the states the interface tells apart.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listRepositories, startServer, type Root, type Run } from '@chade/daemon'

const here = fileURLToPath(new URL('.', import.meta.url))
const stateFile = process.env.E2E_STATE
if (!stateFile) throw new Error('E2E_STATE names the file the tests read the address from')

const root = mkdtempSync(join(tmpdir(), 'chade-e2e-'))
process.on('exit', () => {
  rmSync(root, { recursive: true, force: true })
  rmSync(stateFile, { force: true })
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0))

// The git settings of the machine stay out, so the run reads the same on any of them.
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'e2e',
  GIT_AUTHOR_EMAIL: 'e2e@example.test',
  GIT_COMMITTER_NAME: 'e2e',
  GIT_COMMITTER_EMAIL: 'e2e@example.test',
}

function git(folder: string, ...args: string[]): string {
  return execFileSync('git', ['-C', folder, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commit(folder: string, file: string, content: string, subject: string): void {
  writeFileSync(join(folder, file), content)
  git(folder, 'add', '--all')
  git(folder, 'commit', '--quiet', '--message', subject)
}

// A repository with one commit on main, pushed to a remote of its own unless told otherwise.
function repository(system: string, name: string, options: { push?: boolean } = {}): string {
  const folder = join(root, system, name)
  mkdirSync(folder, { recursive: true })
  git(folder, 'init', '--quiet', '--initial-branch=main')
  commit(folder, 'README.md', `# ${name}\n`, `Start ${name}`)
  if (options.push !== false) {
    const remote = join(root, 'remotes', `${system}-${name.replaceAll('/', '-')}.git`)
    mkdirSync(remote, { recursive: true })
    git(remote, 'init', '--quiet', '--bare', '--initial-branch=main')
    git(folder, 'remote', 'add', 'origin', remote)
    git(folder, 'push', '--quiet', '--set-upstream', 'origin', 'main')
  }
  return folder
}

repository('wsl-ubuntu', 'clean')

const ahead = repository('wsl-ubuntu', 'ahead')
commit(ahead, 'a.txt', 'one\n', 'Add a file that is not pushed yet')
commit(ahead, 'a.txt', 'two\n', 'Change the file, which <b>is not</b> markup')

// Behind by the commit another clone pushed, and fetched since.
const behind = repository('wsl-ubuntu', 'behind')
const other = join(root, 'other-clone')
git(root, 'clone', '--quiet', join(root, 'remotes', 'wsl-ubuntu-behind.git'), other)
commit(other, 'b.txt', 'pushed from elsewhere\n', 'Add a file from another machine')
git(other, 'push', '--quiet')
git(behind, 'fetch', '--quiet')

const dirty = repository('wsl-ubuntu', 'dirty')
writeFileSync(join(dirty, 'README.md'), '# dirty, edited\n')
writeFileSync(join(dirty, 'notes.txt'), 'not tracked\n')
writeFileSync(join(dirty, 'todo.txt'), 'not tracked either\n')

const feature = repository('wsl-ubuntu', 'group/feature')
git(feature, 'switch', '--quiet', '--create', 'feature/never-pushed')

const detached = repository('wsl-ubuntu', 'detached')
git(detached, 'checkout', '--quiet', '--detach')

const conflict = repository('wsl-ubuntu', 'conflict')
git(conflict, 'switch', '--quiet', '--create', 'theirs')
commit(conflict, 'README.md', '# theirs\n', 'Rename to theirs')
git(conflict, 'switch', '--quiet', 'main')
commit(conflict, 'README.md', '# ours\n', 'Rename to ours')
try {
  git(conflict, 'merge', '--quiet', 'theirs')
} catch {
  // The merge stops on the conflict, which is the state wanted.
}

// A .git that is no repository, as an interrupted clone leaves.
mkdirSync(join(root, 'wsl-ubuntu', 'interrupted', '.git'), { recursive: true })

repository('windows', 'portal')
repository('windows', 'local-only', { push: false })

const roots: Root[] = ['windows', 'wsl-ubuntu', 'missing'].map((system) => ({
  system: system === 'missing' ? 'wsl-ubuntu' : system,
  folder: join(root, system),
  path: join(root, system),
  separator: process.platform === 'win32' ? '\\' : '/',
  git: 'git',
}))

const run: Run = async (command, args, options = {}) => {
  try {
    return { code: 0, stdout: execFileSync(command, args, { cwd: options.cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const server = await startServer({
  port: Number(process.env.E2E_PORT ?? 7899),
  uiDir: join(here, '..', 'dist'),
  api: {
    ping: async () => ({ version: '0.0.0' }),
    state: async () => ({ version: '0.0.0', machine: 'E2E-PC', scannedAt: new Date().toISOString(), ...(await listRepositories(roots, run)) }),
  },
})
writeFileSync(stateFile, JSON.stringify({ url: server.url, root }))
console.log(`chade e2e server on ${server.address}, repositories in ${root}`)
