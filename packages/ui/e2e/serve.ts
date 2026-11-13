// The server of chade ui, as shipped, over the built interface and repositories made for the run.
// The repositories are real ones, read by git, each in one of the states the interface tells apart.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createActions, createApi, startServer, type Report, type Root, type Run } from '@chade/daemon'

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

// Known by the address of a forge, which git still reaches through the remote of the run.
function knownAs(folder: string, remote: string, url: string): void {
  git(folder, 'config', `url.${join(root, 'remotes', `${remote}.git`)}.insteadOf`, url)
  git(folder, 'remote', 'set-url', 'origin', url)
}

repository('wsl-ubuntu', 'clean')

const ahead = repository('wsl-ubuntu', 'ahead')
knownAs(ahead, 'wsl-ubuntu-ahead', 'git@gitlab.com:chade-e2e/ahead.git')
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
knownAs(dirty, 'wsl-ubuntu-dirty', 'https://chade-e2e@dev.azure.com/chade-e2e/system/_git/dirty')
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

// A history with a branch merged, a tag, a rename, and a working tree with a staged file, a changed one and an untracked one.
const history = repository('wsl-ubuntu', 'history')
commit(history, 'guide.md', 'Install\nConfigure\nRun\n', 'Add the guide')
git(history, 'switch', '--quiet', '--create', 'feature/graph')
commit(history, 'graph.txt', 'lanes\n', 'Draw the graph')
git(history, 'switch', '--quiet', 'main')
commit(history, 'guide.md', 'Install\nSet up\nRun\nStop\n', 'Change the guide\n\nThe second step has a shorter name, and the last one was missing.')
git(history, 'merge', '--quiet', '--no-ff', '--message', 'Merge feature/graph', 'feature/graph')
git(history, 'tag', 'v1.0')
git(history, 'push', '--quiet')
knownAs(history, 'wsl-ubuntu-history', 'https://github.com/chade-e2e/history.git')
git(history, 'mv', 'guide.md', 'manual.md')
git(history, 'commit', '--quiet', '--message', 'Rename the guide')
writeFileSync(join(history, 'staged.txt'), 'ready\n')
git(history, 'add', 'staged.txt')
writeFileSync(join(history, 'README.md'), '# history\n\nEdited, not staged.\n')
writeFileSync(join(history, 'notes.txt'), 'not tracked\n')

// A .git that is no repository, as an interrupted clone leaves.
mkdirSync(join(root, 'wsl-ubuntu', 'interrupted', '.git'), { recursive: true })

// The repositories the tests change, under a system of their own, so the lists the other tests count stay as they are.
// The remote of work has one commit more, which a fetch brings, and a branch work never fetched.
const work = repository('sandbox', 'work')
const elsewhere = join(root, 'elsewhere')
git(root, 'clone', '--quiet', join(root, 'remotes', 'sandbox-work.git'), elsewhere)
commit(elsewhere, 'remote.txt', 'pushed from elsewhere\n', 'Add a file from another machine')
git(elsewhere, 'push', '--quiet')
git(elsewhere, 'switch', '--quiet', '--create', 'review')
commit(elsewhere, 'review.txt', 'to review\n', 'Start the review')
git(elsewhere, 'push', '--quiet', '--set-upstream', 'origin', 'review')
writeFileSync(join(work, 'README.md'), '# work\n\nEdited.\n')
writeFileSync(join(work, 'draft.txt'), 'a new file\n')

const portal = repository('windows', 'portal')
repository('windows', 'local-only', { push: false })

// The store, a subfolder of a repository of its own, with two machines: the one of the run, with three snapshots, and another one.
const notes = join(root, 'store')
const store = join(notes, 'systems')
function stored(path: string, content: string | Buffer | undefined): void {
  const file = join(store, path)
  if (content === undefined) return rmSync(file)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content)
}
function snapshot(subject: string): void {
  git(notes, 'add', '--all')
  git(notes, 'commit', '--quiet', '--message', subject)
}
mkdirSync(store, { recursive: true })
git(notes, 'init', '--quiet', '--initial-branch=main')
stored('E2E-PC/wsl-ubuntu/files/etc/wsl.conf', '[boot]\nsystemd=true\n')
stored('E2E-PC/wsl-ubuntu/files/etc/docker/daemon.json', '{\n  "log-driver": "local"\n}\n')
stored('E2E-PC/wsl-ubuntu/inventories/apt-manual.txt', 'curl\ngit\nvim\n')
stored('E2E-PC/windows/files/C/Users/e2e/.wslconfig', '[wsl2]\nmemory=8GB\n')
stored('E2E-PC/windows/inventories/winget.json', '{\n  "Packages": ["Git.Git"]\n}\n')
snapshot('E2E-PC: snapshot of windows, wsl-ubuntu, 2026-11-09 08:30')
stored('OLD-LAPTOP/linux/files/etc/hostname', 'old-laptop\n')
stored('OLD-LAPTOP/linux/files/icon.bin', Buffer.from([0x89, 0x50, 0x00, 0x01]))
snapshot('OLD-LAPTOP: snapshot of linux, 2026-11-09 19:00')
stored('E2E-PC/wsl-ubuntu/inventories/apt-manual.txt', 'curl\ngit\njq\nvim\n')
stored('E2E-PC/windows/files/C/Users/e2e/.wslconfig', '[wsl2]\nmemory=12GB\nswap=0\n')
snapshot('E2E-PC: snapshot of windows, wsl-ubuntu, 2026-11-10 18:12')
stored('E2E-PC/wsl-ubuntu/files/etc/docker/daemon.json', undefined)
stored('E2E-PC/wsl-ubuntu/files/etc/wsl.conf', '[boot]\nsystemd=true\n\n[interop]\nappendWindowsPath=false\n')
stored('E2E-PC/wsl-ubuntu/inventories/snap.txt', 'core22 20260101\n')
snapshot('E2E-PC: snapshot of windows, wsl-ubuntu, 2026-11-11 09:00')

const roots: Root[] = ['windows', 'wsl-ubuntu', 'sandbox', 'missing'].map((system) => ({
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

// A report with what the page tells apart: sizes, details, a hint with its commands, and a section with nothing to clean.
// It counts its runs, so a test sees that it was measured again.
let measured = 0
const report = async (): Promise<Report> => {
  measured++
  await new Promise((resolve) => setTimeout(resolve, 300))
  return {
    machine: 'E2E-PC',
    date: new Date().toISOString(),
    sections: [
      {
        title: 'Windows disk',
        measures: [
          { label: 'C:', detail: '615.8 GB used of 1.0 TB, 406.3 GB free' },
          { label: 'Ubuntu disk image', bytes: 352_500_000_000, detail: 'C:\\Users\\e2e\\AppData\\Local\\Packages\\Ubuntu\\LocalState\\ext4.vhdx' },
        ],
        hints: ['Ubuntu uses 275.9 GB of an image of 352.5 GB on C:, so 76.6 GB come back once trimmed and compacted:', '  sudo fstrim -av', 'Then, from an administrator prompt on Windows:', '  wsl --shutdown', '  diskpart', '  select vdisk file="C:\\Users\\e2e\\AppData\\Local\\Packages\\CanonicalGroupLimited.Ubuntu\\LocalState\\ext4.vhdx"', '  attach vdisk readonly', '  compact vdisk', '  detach vdisk', '  exit'],
        guide: 'disk-image-compaction',
      },
      {
        title: 'Memory',
        measures: [
          { label: 'RAM', detail: `5.9 GB used of 44.2 GB, measured ${measured} time${measured === 1 ? '' : 's'}` },
          { label: 'Swap', detail: '0 B used of 12.9 GB' },
          { label: 'process java', bytes: 2_255_000_000 },
          { label: 'process node', bytes: 410_000_000 },
        ],
        hints: [],
      },
      {
        title: 'Docker',
        measures: [
          { label: 'Images', bytes: 48_200_000_000, detail: '31.0 GB unused' },
          { label: 'Build cache', bytes: 9_100_000_000, detail: '9.1 GB unused' },
          { label: 'Volumes', bytes: 1_200_000_000 },
        ],
        hints: ['31.0 GB of images are unused, and removed with:', '  docker image prune -a --filter until=168h -f'],
        guide: 'docker',
      },
      { title: 'Journal', measures: [{ label: 'systemd journal', bytes: 839_500_000 }], hints: [] },
      {
        title: 'Repositories',
        measures: [
          { label: '3 repositories', bytes: 5_400_000_000 },
          { label: '~/repos/chade', bytes: 3_100_000_000 },
          { label: '~/repos/istarci', bytes: 2_000_000_000 },
          { label: '~/repos/notes', bytes: 300_000_000 },
        ],
        hints: [],
      },
    ],
  }
}

// An IstarCI that watches the repository named history, with a commit of each kind it tells apart, and nothing of the other repositories.
const hashOf = (subject: string): string => git(history, 'log', '--all', '--format=%H', '--fixed-strings', `--grep=${subject}`).trim().split('\n')[0]
const istarciRuns = [
  { id: 'run-rename', commitSha: hashOf('Rename the guide'), status: 'running', workflow: null },
  { id: 'run-merge', commitSha: hashOf('Merge feature/graph'), status: 'success', durationMs: 112_000, workflow: null },
  { id: 'run-change', commitSha: hashOf('Change the guide'), status: 'failure', durationMs: 5_000, workflow: null },
  { id: 'run-draw-by-hand', commitSha: hashOf('Draw the graph'), status: 'failure', workflow: 'release.yml' },
  { id: 'run-start', commitSha: hashOf('Start history'), status: 'cancelled', workflow: null },
]
// A repository of Windows, which IstarCI knows by the path chade reads it through.
const portalRuns = [{ id: 'run-portal', commitSha: git(portal, 'rev-parse', 'HEAD').trim(), status: 'success', durationMs: 40_000, workflow: null }]
const istarciEvents = [{ id: 1, commitSha: hashOf('Draw the graph'), reason: 'A newer commit replaced it in the queue' }]
// IstarCI knows each repository by its folder, and gives the latest word on it: of the commit checked out, or of an older one for ahead.
const istarciRepos = [
  { path: history, latestRun: istarciRuns[0], latestEvent: null },
  { path: portal, latestRun: portalRuns[0], latestEvent: null },
  { path: detached, latestRun: null, latestEvent: null },
  { path: ahead, latestRun: { id: 'run-ahead', commitSha: git(ahead, 'rev-parse', 'HEAD~2').trim(), status: 'failure', branch: 'main', workflow: null }, latestEvent: null },
]
const istarci = createServer((request, response) => {
  const url = new URL(request.url ?? '', 'http://localhost')
  if (request.headers.authorization !== 'Bearer e2e-istarci') return response.writeHead(401).end('{}')
  // An IstarCI that never answers about detached, which the page gives up on without a word.
  if (url.searchParams.get('repoPath') === detached) return
  const watched = url.searchParams.get('repoPath') === history
  if (url.pathname === '/api/v1/repos') return response.end(JSON.stringify(istarciRepos))
  if (url.pathname === '/api/v1/runs' && url.searchParams.get('repoPath') === portal) return response.end(JSON.stringify(portalRuns))
  if (url.pathname === '/api/v1/runs') return response.end(JSON.stringify(watched ? istarciRuns : []))
  if (url.pathname === '/api/v1/events') return response.end(JSON.stringify(watched ? istarciEvents : []))
  response.writeHead(404).end('{}')
})
await new Promise<void>((resolve) => istarci.listen(0, '127.0.0.1', resolve))
const istarciUrl = `http://127.0.0.1:${(istarci.address() as AddressInfo).port}`

const options = {
  version: '0.0.0',
  machine: 'E2E-PC',
  roots: async () => roots,
  store: async () => store,
  report,
  istarci: async () => ({ url: istarciUrl, token: 'e2e-istarci' }),
  run,
}
const server = await startServer({
  port: Number(process.env.E2E_PORT ?? 7899),
  uiDir: join(here, '..', 'dist'),
  api: createApi(options),
  actions: createActions(options),
})
writeFileSync(stateFile, JSON.stringify({ url: server.url, root, store, istarci: istarciUrl }))
console.log(`chade e2e server on ${server.address}, repositories in ${root}`)
