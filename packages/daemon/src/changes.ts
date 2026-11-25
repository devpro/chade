import type { Git } from './history.js'
import { RequestError } from './server.js'

// A file of a comparison, listed apart from its lines, so the list is whole whatever the size of the changes.
export interface ChangedFile {
  path: string
  // The earlier path of a renamed file.
  from?: string
  // The letter git gives the change: A, M, D, R, T.
  status: string
  // Absent for a binary file, and for a file whose lines are not counted.
  additions?: number
  deletions?: number
  binary: boolean
}

// The changes of one file, read when the file is opened.
export interface FilePatch {
  file: ChangedFile
  patch: string
}

const COMPARE_OPTIONS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames']
const LIST_OPTIONS = ['--raw', '--numstat', '-z', ...COMPARE_OPTIONS]
const PATCH_OPTIONS = ['--patch', ...COMPARE_OPTIONS]

// Reads the entry of --raw at the index, and gives the index of its last part.
function readRaw(entries: string[], at: number, files: Map<string, ChangedFile>): number {
  const status = entries[at].slice(entries[at].lastIndexOf(' ') + 1)[0]
  if (status === 'R' || status === 'C') {
    const [from, path] = entries.slice(at + 1, at + 3)
    files.set(path, { path, from, status, binary: false })
    return at + 2
  }
  const path = entries[at + 1]
  // A file in conflict has no two sides to compare, and is listed a second time as changed.
  if (files.get(path)?.status !== 'U') files.set(path, { path, status, binary: false })
  return at + 1
}

// Reads the entry of --numstat at the index, and gives the index of its last part.
function readCounts(entries: string[], at: number, files: Map<string, ChangedFile>): number {
  const [additions, deletions, ...rest] = entries[at].split('\t')
  const renamed = deletions !== undefined && rest.join('\t') === ''
  const file = files.get(renamed ? entries[at + 2] : rest.join('\t'))
  if (file && additions === '-') file.binary = true
  else if (file) Object.assign(file, { additions: Number(additions), deletions: Number(deletions) })
  return renamed ? at + 2 : at
}

// Reads the output of --raw --numstat -z, one entry of each for a file.
// A renamed file has its earlier path then its new one after the entry.
export function parseChangedFiles(text: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  const entries = text.split('\0')
  let index = 0
  while (index < entries.length) {
    const last = entries[index].startsWith(':') ? readRaw(entries, index, files) : readCounts(entries, index, files)
    index = last + 1
  }
  return [...files.values()].filter((file) => file.status !== 'U')
}

// Comparing with nothing exits with 1, as any comparison that finds a difference.
async function output(git: Git, args: string[], accepted = 0): Promise<string> {
  const result = await git(args)
  if (result.code < 0 || result.code > accepted) throw new Error((result.stderr || result.stdout).trim().split('\n')[0] || `git ${args[0]} exited with ${result.code}`)
  return result.stdout
}

const missing = (path: string): RequestError => new RequestError(404, `${path} is not among the changes`)

// Every file of a comparison, the command being git diff or git show with what it compares, and the paths it is limited to.
export async function readChangedFiles(git: Git, command: string[], paths: string[] = []): Promise<ChangedFile[]> {
  return parseChangedFiles(await output(git, [...command, ...LIST_OPTIONS, '--', ...paths]))
}

export async function readFilePatch(git: Git, command: string[], path: string, paths: string[] = []): Promise<FilePatch> {
  // The path is one git lists for that comparison, and names that file alone, never a pattern.
  const file = (await readChangedFiles(git, command, paths)).find((candidate) => candidate.path === path)
  if (!file) throw missing(path)
  // Both paths of a renamed file, as git pairs only the files it compares.
  const names = file.from === undefined ? [path] : [file.from, path]
  return { file, patch: await output(git, ['--literal-pathspecs', ...command, ...PATCH_OPTIONS, '--', ...names]) }
}

// The lines of an untracked file are counted one git command each, so those of a folder of generated files are not.
const MAX_COUNTED = 200
// A repository inside of the repository is listed as a folder, which has no line.
const isFolder = (path: string): boolean => path.endsWith('/')
const added = (path: string): ChangedFile => ({ path, status: 'A', binary: false })

export async function readUntrackedFiles(git: Git, paths: string[]): Promise<ChangedFile[]> {
  const files: ChangedFile[] = []
  for (const [index, path] of paths.entries()) {
    const file = added(path)
    files.push(file)
    if (index >= MAX_COUNTED || isFolder(path)) continue
    const result = await git(['diff', '--no-index', ...LIST_OPTIONS, '--', '/dev/null', path])
    // A file git cannot read, or removed meanwhile, stays in the list without its count.
    if (result.code < 0 || result.code > 1) continue
    const [counted] = parseChangedFiles(result.stdout)
    if (counted) Object.assign(file, counted, { path, status: 'A' })
  }
  return files
}

export async function readUntrackedPatch(git: Git, paths: string[], path: string): Promise<FilePatch> {
  if (!paths.includes(path)) throw missing(path)
  const [file] = await readUntrackedFiles(git, [path])
  return { file, patch: isFolder(path) ? '' : await output(git, ['diff', '--no-index', ...PATCH_OPTIONS, '--', '/dev/null', path], 1) }
}
