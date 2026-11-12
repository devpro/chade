import { GIT_TIMEOUT_MS, readRepository, repositoryPath, type Repository, type Root, type Run } from './repositories.js'

export interface Commit {
  hash: string
  parents: string[]
  author: string
  date: string
  // Names pointing at the commit, as git decorates them: HEAD -> main, origin/main, tag: v1.0.
  refs: string[]
  subject: string
}

export interface Branch {
  name: string
  remote: boolean
  // The branch checked out.
  head: boolean
  commit: string
  upstream?: string
  ahead?: number
  behind?: number
  // The upstream was deleted on the remote.
  gone?: boolean
}

export interface FileChange {
  path: string
  // The earlier path of a renamed file.
  from?: string
  // The letter git status gives the file in the index, and in the working tree: M, A, D, R, U, ? when untracked, a space when unchanged.
  staged: string
  unstaged: string
}

export interface Detail {
  repository: Repository
  branches: Branch[]
  commits: Commit[]
  // The history goes on after the commits listed.
  more: boolean
  changes: FileChange[]
  // The commit checked out, which an amend rewrites, absent before the first commit.
  last?: LastCommit
  // The page of the remote on the web, absent for a remote that is a folder or a host whose pages are unknown.
  web?: string
}

export interface LastCommit {
  message: string
  // On a remote branch already, so rewriting it would need a force push.
  pushed: boolean
}

export interface Diff {
  commit?: { hash: string; author: string; email: string; date: string; message: string }
  patch: string
  // The patch was cut, being larger than a page can show.
  truncated: boolean
}

// Where each forge shows a branch, after the address of the repository.
const BRANCH_PAGES: Record<string, string> = { 'github.com': '/tree/', 'gitlab.com': '/-/tree/', 'bitbucket.org': '/src/' }

// The page on the web of a repository whose remote is at the address given, git@host:owner/name.git or https://host/owner/name.git, at the branch given on the hosts that have a page for it.
export function webAddress(remote: string, branch?: string): string | undefined {
  let base: string
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(remote)
  if (scp) base = `https://${scp[1]}/${scp[2]}`
  else {
    let url: URL
    try {
      url = new URL(remote)
    } catch {
      return undefined
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined
    // The port of ssh is no port of the web, and the name and password of a remote stay out of a link.
    base = url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}${url.pathname}` : `https://${url.hostname}${url.pathname}`
  }
  const web = new URL(base.replace(/\/+$/, '').replace(/\.git$/, ''))
  // A host without a dot is a folder read as scp, C:/repos/name, or a name of the local network.
  if (!web.hostname.includes('.') || web.pathname.split('/').filter(Boolean).length < 2) return undefined
  const page = BRANCH_PAGES[web.hostname]
  if (page && branch) web.pathname += page + branch.split('/').map(encodeURIComponent).join('/')
  return web.href
}

export const DEFAULT_COMMITS = 300
export const MAX_COMMITS = 5000
export const MAX_PATCH = 2 * 1024 * 1024
// Untracked files are read one git command each, so a folder of generated files is not read whole.
const MAX_UNTRACKED = 200

export type Git = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

function gitOf(root: Root, relative: string[], run: Run): Git {
  // Reading never waits for a lock, and file names come as they are rather than escaped.
  return (args) => run(root.git, ['-C', repositoryPath(root, relative), '--no-optional-locks', '-c', 'core.quotePath=false', ...args], { cwd: root.cwd, timeoutMs: GIT_TIMEOUT_MS })
}

export function parseBranches(text: string): Branch[] {
  const branches: Branch[] = []
  for (const line of text.split('\n')) {
    const [ref, commit, upstream, track, head] = line.split('\0')
    if (!commit) continue
    const remote = ref.startsWith('refs/remotes/')
    const name = ref.replace(/^refs\/(heads|remotes)\//, '')
    // The HEAD of a remote is a pointer to its default branch, not a branch.
    if (remote && name.endsWith('/HEAD')) continue
    const branch: Branch = { name, remote, head: head === '*', commit }
    if (upstream) {
      branch.upstream = upstream
      if (track === 'gone') branch.gone = true
      else {
        branch.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
        branch.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
      }
    }
    branches.push(branch)
  }
  return branches
}

export function parseCommits(text: string): Commit[] {
  const commits: Commit[] = []
  for (const line of text.split('\n')) {
    const [hash, parents, author, date, refs, ...subject] = line.split('\0')
    if (!hash || date === undefined) continue
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      date,
      refs: refs ? refs.split(', ') : [],
      // A subject holds no NUL, and joining keeps one that somehow does.
      subject: subject.join('\0'),
    })
  }
  return commits
}

// Reads the output of git status --porcelain=v1 -z, where a renamed file is followed by its earlier path.
export function parseChanges(text: string): FileChange[] {
  const changes: FileChange[] = []
  const entries = text.split('\0')
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.length < 4) continue
    const [staged, unstaged] = entry
    const change: FileChange = { path: entry.slice(3), staged: staged === '?' ? ' ' : staged, unstaged }
    if (staged === 'R' || staged === 'C' || unstaged === 'R' || unstaged === 'C') change.from = entries[++index]
    changes.push(change)
  }
  return changes
}

export async function repositoryDetail(root: Root, relative: string[], run: Run, limit = DEFAULT_COMMITS): Promise<Detail> {
  const git = gitOf(root, relative, run)
  const repository = await readRepository(root, relative, run)
  if (repository.error !== undefined) return { repository, branches: [], commits: [], more: false, changes: [] }
  const count = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_COMMITS), MAX_COMMITS)
  const none = Promise.resolve({ code: 0, stdout: '', stderr: '' })
  const [refs, log, status, message, unpushed] = await Promise.all([
    git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)', 'refs/heads', 'refs/remotes']),
    // Every branch and tag, and HEAD for a detached one, but not the stash, whose commits are no history.
    repository.head
      ? git(['log', '--branches', '--remotes', '--tags', 'HEAD', '--date-order', `--max-count=${count + 1}`, '--format=%H%x00%P%x00%an%x00%cI%x00%D%x00%s'])
      : none,
    git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    repository.head ? git(['log', '-1', '--format=%B', 'HEAD']) : none,
    repository.head ? git(UNPUSHED) : none,
  ])
  for (const result of [refs, log, status, message, unpushed]) {
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split('\n')[0] || `${root.git} exited with ${result.code}`)
  }
  const commits = parseCommits(log.stdout)
  const detail: Detail = { repository, branches: parseBranches(refs.stdout), commits: commits.slice(0, count), more: commits.length > count, changes: parseChanges(status.stdout) }
  if (repository.head) detail.last = { message: message.stdout.trim(), pushed: unpushed.stdout.trim() === '' }
  const web = await readWeb(git, repository.branch)
  if (web) detail.web = web
  return detail
}

// The page of the remote the branch checked out tracks, at that branch, or of origin, or of the only remote, when the branch tracks none.
async function readWeb(git: Git, branch: string | undefined): Promise<string | undefined> {
  // A branch name holds no character a pattern of for-each-ref reads as a wildcard.
  const [tracked, remotes] = await Promise.all([
    branch ? git(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track)', `refs/heads/${branch}`]) : undefined,
    git(['remote']),
  ])
  const [remote, ref, track] = (tracked?.code === 0 ? tracked.stdout.trim() : '').split('\0')
  const names = remotes.code === 0 ? remotes.stdout.split('\n').filter(Boolean) : []
  const name = remote && names.includes(remote) ? remote : names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : undefined
  if (!name) return undefined
  // The address as written in the configuration, as a rewrite of it by insteadOf reaches the same repository by another way, not its page.
  const url = await git(['config', '--get', `remote.${name}.url`])
  if (url.code !== 0) return undefined
  // A branch that was never pushed, or whose upstream is gone, has no page on the remote yet.
  const pushed = name === remote && ref?.startsWith('refs/heads/') && track !== '[gone]'
  return webAddress(url.stdout.trim(), pushed ? ref.slice('refs/heads/'.length) : undefined)
}

// Prints HEAD when no remote branch holds it yet, and nothing once it is pushed.
export const UNPUSHED = ['rev-list', '--max-count=1', 'HEAD', '--not', '--remotes']

export const DIFF_OPTIONS = ['--patch', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames']

// The files git does not track yet, each as a patch that adds its every line.
async function untrackedPatch(git: Git): Promise<Diff> {
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.code !== 0) throw new Error((status.stderr || status.stdout).trim().split('\n')[0])
  // The names come from git itself, never from the request.
  const files = parseChanges(status.stdout)
    .filter((file) => file.unstaged === '?')
    .map((file) => file.path)
  const diff: Diff = { patch: '', truncated: files.length > MAX_UNTRACKED }
  for (const file of files.slice(0, MAX_UNTRACKED)) {
    // Comparing with nothing exits with 1, as any comparison that finds a difference.
    const result = await git(['diff', '--no-index', ...DIFF_OPTIONS, '--', '/dev/null', file])
    if (result.code > 1) continue
    if (diff.patch.length + result.stdout.length > MAX_PATCH) {
      diff.truncated = true
      break
    }
    diff.patch += result.stdout
  }
  return diff
}

// Who made a commit, when, and its whole message.
export async function readCommit(git: Git, hash: string): Promise<NonNullable<Diff['commit']>> {
  const show = await git(['show', '--no-patch', '--format=%H%x00%an%x00%ae%x00%aI%x00%B', hash])
  if (show.code !== 0) throw new Error((show.stderr || show.stdout).trim().split('\n')[0])
  const [full, author, email, date, ...message] = show.stdout.split('\0')
  return { hash: full, author, email, date, message: message.join('\0').trim() }
}

// A patch no larger than a page can show, cut at the end of a line, so the last one shown is whole.
export function cutPatch(patch: string): { patch: string; truncated: boolean } {
  if (patch.length <= MAX_PATCH) return { patch, truncated: false }
  return { patch: patch.slice(0, patch.lastIndexOf('\n', MAX_PATCH) + 1), truncated: true }
}

// The patch of a commit against its first parent, or of what is staged, of what is changed and not staged, or of the files not tracked.
export async function repositoryDiff(root: Root, relative: string[], run: Run, target: string): Promise<Diff> {
  const git = gitOf(root, relative, run)
  const diff: Diff = { patch: '', truncated: false }
  let result
  if (target === 'untracked') return untrackedPatch(git)
  if (target === 'staged') result = await git(['diff', '--cached', ...DIFF_OPTIONS])
  else if (target === 'unstaged') result = await git(['diff', ...DIFF_OPTIONS])
  else {
    // A full hash and nothing else, so the value never reads as an option or a path.
    if (!/^[0-9a-f]{40}$/.test(target)) throw new Error('the target of a diff is staged, unstaged, untracked or the full hash of a commit')
    diff.commit = await readCommit(git, target)
    result = await git(['show', '--format=', '--diff-merges=first-parent', ...DIFF_OPTIONS, target])
  }
  if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split('\n')[0])
  return { ...diff, ...cutPatch(result.stdout) }
}
