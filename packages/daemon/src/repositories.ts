import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { forgeOf, mainRemote, parseRemoteUrls, type Remote } from './remote.js'

export interface Result {
  code: number
  stdout: string
  stderr: string
}

export type Run = (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<Result>

// A folder scanned for repositories, on one of the systems of the machine.
export interface Root {
  // Folder of the system in the store, such as windows or wsl-ubuntu.
  system: string
  // Path this process reads the folder through, /mnt/c/... for a Windows folder read from WSL.
  folder: string
  // Path the system itself, and its git, know the folder by.
  path: string
  separator: '/' | '\\'
  // The git of the system the folder is on, since the git of Linux is slow on a Windows disk and reads its line endings and file modes differently.
  git: string
  cwd?: string
}

export interface Status {
  // Absent on a detached HEAD.
  branch?: string
  // Absent before the first commit.
  head?: string
  upstream?: string
  // Absent without an upstream, or when the upstream branch is gone.
  ahead?: number
  behind?: number
  changed: number
  untracked: number
  conflicts: number
}

export interface Repository extends Status {
  system: string
  name: string
  path: string
  commit?: { subject: string; date: string }
  // The last fetch or pull, which the ahead and behind counts are as old as.
  fetchedAt?: string
  // Absent for a repository without a remote, or with several and none of them origin or tracked.
  remote?: Remote
  error?: string
}

export interface Listing {
  repositories: Repository[]
  warnings: string[]
}

const SKIPPED_FOLDERS = new Set(['node_modules', 'bin', 'obj', 'dist'])
const REPOSITORY_DEPTH = 3
// A git of Windows started from WSL takes a tenth of a second, so the repositories are read side by side.
const CONCURRENCY = 8
export const GIT_TIMEOUT_MS = 30_000

export async function findRepositories(folder: string, relative: string[] = [], depth = REPOSITORY_DEPTH): Promise<string[][]> {
  const entries = await readdir(join(folder, ...relative), { withFileTypes: true }).catch(() => [])
  if (entries.some((entry) => entry.name === '.git')) return [relative]
  if (depth === 0) return []
  const found: string[][] = []
  const children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name))
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    found.push(...(await findRepositories(folder, [...relative, child.name], depth - 1)))
  }
  return found
}

// Reads the output of git status --porcelain=v2 --branch.
export function parseStatus(text: string): Status {
  const status: Status = { changed: 0, untracked: 0, conflicts: 0 }
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      if (oid !== '(initial)') status.head = oid.slice(0, 7)
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      if (head !== '(detached)') status.branch = head
    } else if (line.startsWith('# branch.upstream ')) {
      status.upstream = line.slice('# branch.upstream '.length).trim()
    } else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line)
      if (match) {
        status.ahead = Number(match[1])
        status.behind = Number(match[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) status.changed++
    else if (line.startsWith('u ')) status.conflicts++
    else if (line.startsWith('? ')) status.untracked++
  }
  return status
}

// The path the system knows a repository of a root by.
export function repositoryPath(root: Root, relative: string[]): string {
  return [root.path.replace(/[\\/]+$/, ''), ...relative].join(root.separator)
}

// A repository named by a request, found only among those the roots hold, so a request reaches no other folder of the machine.
export async function findRepository(roots: Root[], system: string, path: string): Promise<{ root: Root; relative: string[] } | undefined> {
  for (const root of roots) {
    if (root.system !== system || !existsSync(root.folder)) continue
    for (const relative of await findRepositories(root.folder)) {
      if (repositoryPath(root, relative) === path) return { root, relative }
    }
  }
  return undefined
}

// The remote the upstream origin/feature/x is on, the longest name that fits, as a remote name can hold a slash.
function remoteOf(urls: Map<string, string>, upstream?: string): Remote | undefined {
  const names = [...urls.keys()]
  const tracked = upstream ? names.filter((name) => upstream.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0] : undefined
  const name = mainRemote(names, tracked)
  return name === undefined ? undefined : { name, ...forgeOf(urls.get(name) ?? '') }
}

export async function readRepository(root: Root, relative: string[], run: Run): Promise<Repository> {
  const path = repositoryPath(root, relative)
  const folder = join(root.folder, ...relative)
  const identity = { system: root.system, name: relative.length > 0 ? relative.join('/') : basename(folder), path }
  const git = (args: string[]) => run(root.git, ['-C', path, ...args], { cwd: root.cwd, timeoutMs: GIT_TIMEOUT_MS })
  // A status refreshes the index when it can, and that write would get in the way of a git command running in the repository at the same time.
  const status = await git(['--no-optional-locks', 'status', '--porcelain=v2', '--branch'])
  if (status.code !== 0) {
    const reason = (status.stderr || status.stdout).trim().split('\n')[0]
    return { ...identity, changed: 0, untracked: 0, conflicts: 0, error: reason || `${root.git} exited with ${status.code}` }
  }
  const repository: Repository = { ...identity, ...parseStatus(status.stdout) }
  // A repository without any remote has no such key, and git exits with 1.
  const [log, urls] = await Promise.all([repository.head ? git(['log', '-1', '--format=%cI%x00%s']) : undefined, git(['config', '--get-regexp', '^remote\\..*\\.url$'])])
  if (log) {
    const [date, subject] = log.stdout.trim().split('\0')
    if (log.code === 0 && subject !== undefined) repository.commit = { subject, date }
  }
  const remote = remoteOf(urls.code === 0 ? parseRemoteUrls(urls.stdout) : new Map(), repository.upstream)
  if (remote) repository.remote = remote
  // A worktree keeps its FETCH_HEAD elsewhere, and shows no fetch time.
  const fetched = await stat(join(folder, '.git', 'FETCH_HEAD')).catch(() => undefined)
  if (fetched) repository.fetchedAt = fetched.mtime.toISOString()
  return repository
}

export async function listRepositories(roots: Root[], run: Run): Promise<Listing> {
  const warnings: string[] = []
  const jobs: { root: Root; relative: string[] }[] = []
  for (const root of roots) {
    if (!existsSync(root.folder)) {
      warnings.push(`${root.system}: the repository folder ${root.path} does not exist`)
      continue
    }
    for (const relative of await findRepositories(root.folder)) jobs.push({ root, relative })
  }
  const repositories = new Array<Repository>(jobs.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next++
      repositories[index] = await readRepository(jobs[index].root, jobs[index].relative, run)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return { repositories, warnings }
}
