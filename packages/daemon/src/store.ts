import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cutPatch, DEFAULT_COMMITS, DIFF_OPTIONS, MAX_COMMITS, readCommit, type Diff, type Git } from './history.js'
import { findRepositories, GIT_TIMEOUT_MS, repositoryPath, type Root, type Run } from './repositories.js'
import { RequestError } from './server.js'

// A commit that changed the folder of a machine, which is what chade snapshot makes.
export interface Snapshot {
  hash: string
  author: string
  date: string
  subject: string
}

export interface Machine {
  name: string
  // The folders of the machine, one per system captured: windows, wsl-ubuntu, linux.
  systems: string[]
  // From the newest.
  snapshots: Snapshot[]
  // The machine has older snapshots than those listed.
  more: boolean
}

export interface Store {
  path: string
  machines: Machine[]
  // The repository holding the store, when the interface lists it, named as its page is.
  repository?: { system: string; path: string }
  // Why the store cannot be read, when it cannot.
  error?: string
}

export interface StoredChange {
  // Path in the store, the folder of the machine first.
  path: string
  // The earlier path of a renamed file.
  from?: string
  // The letter git gives the change: A, M, D, R.
  status: string
}

// What a snapshot changed since the one before it on the same machine.
export interface SnapshotDetail extends Diff {
  // The snapshot compared with, absent for the first one of a machine, which is compared with nothing.
  previous?: string
  // Every file changed, which the patch may hold only a part of when it is cut.
  changes: StoredChange[]
}

export interface StoredFile {
  path: string
  content: string
  truncated: boolean
  binary: boolean
}

// The tree of a repository with no file, which git accepts as the base of the first snapshot.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// The store is read from its own folder, the root of a repository or a subfolder of one, so every path git gives or takes starts there.
function gitOf(store: string, run: Run): Git {
  // Reading never waits for a lock, and file names come as they are rather than escaped.
  return (args) => run('git', ['-C', store, '--no-optional-locks', '-c', 'core.quotePath=false', ...args], { timeoutMs: GIT_TIMEOUT_MS })
}

async function output(git: Git, args: string[]): Promise<string> {
  const result = await git(args)
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split('\n')[0] || `git ${args[0]} exited with ${result.code}`)
  return result.stdout
}

const names = (text: string): string[] => text.split('\0').filter((name) => name !== '')

// The folders of the last commit, as a store holds nothing else at its root than its machines.
async function machineNames(git: Git): Promise<string[]> {
  const tree = await git(['ls-tree', '-d', '--name-only', '-z', 'HEAD'])
  // A repository without a commit has no machine yet.
  return tree.code === 0 ? names(tree.stdout) : []
}

export function parseSnapshots(text: string): Snapshot[] {
  const snapshots: Snapshot[] = []
  for (const line of text.split('\n')) {
    const [hash, author, date, ...subject] = line.split('\0')
    if (!hash || date === undefined) continue
    snapshots.push({ hash, author, date, subject: subject.join('\0') })
  }
  return snapshots
}

// Reads the output of git diff --name-status -z, where a renamed file comes as its earlier path then its new one.
export function parseStoredChanges(text: string): StoredChange[] {
  const changes: StoredChange[] = []
  const entries = text.split('\0')
  for (let index = 0; index + 1 < entries.length; index++) {
    const status = entries[index][0]
    if (status === 'R' || status === 'C') {
      changes.push({ path: entries[index + 2], from: entries[index + 1], status })
      index += 2
    } else changes.push({ path: entries[++index], status })
  }
  return changes
}

export async function readStore(store: string, run: Run, limit = DEFAULT_COMMITS): Promise<Store> {
  if (!existsSync(store)) return { path: store, machines: [], error: `the store ${store} does not exist, chade init creates it` }
  const git = gitOf(store, run)
  if ((await git(['rev-parse', '--is-inside-work-tree'])).code !== 0) {
    return { path: store, machines: [], error: `the store ${store} is not a folder of a git repository, chade init creates it` }
  }
  const count = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_COMMITS), MAX_COMMITS)
  const machines: Machine[] = []
  for (const name of await machineNames(git)) {
    const [systems, log] = await Promise.all([
      output(git, ['ls-tree', '-d', '--name-only', '-z', 'HEAD', '--', `${name}/`]),
      output(git, ['log', `--max-count=${count + 1}`, '--format=%H%x00%an%x00%cI%x00%s', 'HEAD', '--', name]),
    ])
    const snapshots = parseSnapshots(log)
    machines.push({
      name,
      systems: names(systems).map((path) => path.slice(name.length + 1)),
      snapshots: snapshots.slice(0, count),
      more: snapshots.length > count,
    })
  }
  return { path: store, machines }
}

// The repository of the store among those under the repos folders, where its page shows what is left to push.
export async function storeRepository(store: string, roots: Root[], run: Run): Promise<Store['repository']> {
  const top = await gitOf(store, run)(['rev-parse', '--show-toplevel'])
  if (top.code !== 0) return undefined
  // Git gives the long name of each folder, where a root on Windows can hold a short one, RUNNER~1 for runneradmin, so both sides are compared as the system resolves them.
  const real = (path: string) => realpath(path).catch(() => resolve(path))
  const folder = await real(top.stdout.trim())
  for (const root of roots) {
    if (!existsSync(root.folder)) continue
    for (const relative of await findRepositories(root.folder)) {
      if ((await real(join(root.folder, ...relative))) === folder) return { system: root.system, path: repositoryPath(root, relative) }
    }
  }
  return undefined
}

// A machine and a snapshot named by a request, found only among those git lists, so a request reaches nothing else of the repository.
async function locate(store: string, run: Run, machine: string, commit: string): Promise<Git> {
  const git = gitOf(store, run)
  if (!existsSync(store) || !(await machineNames(git)).includes(machine)) throw new RequestError(404, `${machine} is not a machine of the store`)
  // A full hash and nothing else, so the value never reads as an option or a path.
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new RequestError(400, 'a snapshot is named by the full hash of its commit')
  const snapshots = await output(git, ['rev-list', 'HEAD', '--', machine])
  if (!snapshots.split('\n').includes(commit)) throw new RequestError(404, `${commit} is not a snapshot of ${machine}`)
  return git
}

export async function readSnapshot(store: string, run: Run, machine: string, commit: string): Promise<SnapshotDetail> {
  const git = await locate(store, run, machine, commit)
  const previous = (await output(git, ['rev-list', '-1', '--skip=1', commit, '--', machine])).trim()
  // Relative to the store, as the paths of the files are, wherever the store is in its repository.
  const compare = ['diff', '--relative', '--find-renames']
  const range = [previous || EMPTY_TREE, commit, '--', machine]
  const [details, changes, patch] = await Promise.all([
    readCommit(git, commit),
    output(git, [...compare, '--name-status', '-z', ...range]),
    output(git, [...compare, ...DIFF_OPTIONS, ...range]),
  ])
  return { commit: details, ...(previous ? { previous } : {}), changes: parseStoredChanges(changes), ...cutPatch(patch) }
}

// Every file a machine had at a snapshot, changed by it or not.
export async function readSnapshotFiles(store: string, run: Run, machine: string, commit: string): Promise<{ files: string[] }> {
  const git = await locate(store, run, machine, commit)
  return { files: names(await output(git, ['ls-tree', '-r', '--name-only', '-z', commit, '--', `${machine}/`])) }
}

export async function readSnapshotFile(store: string, run: Run, machine: string, commit: string, path: string): Promise<StoredFile> {
  const { files } = await readSnapshotFiles(store, run, machine, commit)
  // The path is one git lists for that snapshot, so it names a file of the machine and nothing else.
  if (!files.includes(path)) throw new RequestError(404, `${path} is not a file of that snapshot`)
  const content = await output(gitOf(store, run), ['show', `${commit}:./${path}`])
  // Text holds no NUL, and a page has no use for the bytes of anything else.
  if (content.includes('\0')) return { path, content: '', truncated: false, binary: true }
  const cut = cutPatch(content)
  return { path, content: cut.patch, truncated: cut.truncated, binary: false }
}
