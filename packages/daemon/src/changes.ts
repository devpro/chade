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

// Reads the output of --raw --numstat -z, one entry of each for a file.
// A renamed file has its earlier path then its new one after the entry.
export function parseChangedFiles(text: string): ChangedFile[] {
  const files = new Map<string, ChangedFile>()
  const unmerged = new Set<string>()
  const entries = text.split('\0')
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.startsWith(':')) {
      const status = entry.slice(entry.lastIndexOf(' ') + 1)[0]
      const from = status === 'R' || status === 'C' ? entries[++index] : undefined
      const path = entries[++index]
      // A file in conflict has no two sides to compare.
      if (status === 'U') unmerged.add(path)
      else files.set(path, { path, ...(from === undefined ? {} : { from }), status, binary: false })
      continue
    }
    const [additions, deletions, ...rest] = entry.split('\t')
    if (deletions === undefined) continue
    let path = rest.join('\t')
    if (path === '') {
      index += 2
      path = entries[index]
    }
    const file = files.get(path)
    if (!file) continue
    if (additions === '-') file.binary = true
    else {
      file.additions = Number(additions)
      file.deletions = Number(deletions)
    }
  }
  return [...files.values()].filter((file) => !unmerged.has(file.path))
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
