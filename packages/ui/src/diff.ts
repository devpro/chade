export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'hunk' | 'note'
  text: string
  // Line numbers in the file before and after, where the line exists.
  before?: number
  after?: number
}

export interface DiffFile {
  path: string
  // The earlier path of a renamed file.
  from?: string
  status: 'added' | 'deleted' | 'renamed' | 'modified'
  binary: boolean
  additions: number
  deletions: number
  lines: DiffLine[]
}

// The header of a file, up to its first hunk, says what became of it.
function readHeader(file: DiffFile, line: string): void {
  if (line.startsWith('new file mode')) file.status = 'added'
  else if (line.startsWith('deleted file mode')) file.status = 'deleted'
  else if (line.startsWith('rename from ')) {
    file.status = 'renamed'
    file.from = line.slice('rename from '.length)
  } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length)
  else if (line.startsWith('+++ b/')) file.path = line.slice('+++ b/'.length)
  else if (line.startsWith('--- a/') && file.status === 'deleted') file.path = line.slice('--- a/'.length)
  else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
}

// A line of a hunk, numbered on the side or the sides it is on.
function readHunkLine(file: DiffFile, line: string, at: { before: number; after: number }): void {
  if (line.startsWith('+')) {
    file.additions++
    file.lines.push({ kind: 'add', text: line.slice(1), after: at.after++ })
  } else if (line.startsWith('-')) {
    file.deletions++
    file.lines.push({ kind: 'del', text: line.slice(1), before: at.before++ })
  } else if (line.startsWith(' ')) file.lines.push({ kind: 'context', text: line.slice(1), before: at.before++, after: at.after++ })
  else if (line.startsWith('\\')) file.lines.push({ kind: 'note', text: line.slice(2) })
}

// Reads a patch as git diff and git show write it, into its files and their lines.
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  // The header of a file ends at its first hunk, and a line of content can start with --- or +++ as well.
  let inHunk = false
  const at = { before: 0, after: 0 }
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const names = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      file = { path: names?.[2] ?? line.slice('diff --git '.length), status: 'modified', binary: false, additions: 0, deletions: 0, lines: [] }
      files.push(file)
      inHunk = false
      continue
    }
    if (!file) continue
    if (!inHunk) readHeader(file, line)
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      inHunk = true
      at.before = Number(hunk[1])
      at.after = Number(hunk[2])
      file.lines.push({ kind: 'hunk', text: line })
    } else if (inHunk) readHunkLine(file, line, at)
  }
  return files
}
