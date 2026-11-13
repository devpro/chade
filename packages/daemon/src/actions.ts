import { parseBranches, parseChanges, UNPUSHED } from './history.js'
import { GIT_TIMEOUT_MS, parseStatus, repositoryPath, type Root, type Run } from './repositories.js'
import { RequestError } from './server.js'

// What the interface asks to change in a repository, the only changes chade makes to it.
export const ACTIONS = ['fetch', 'pull', 'push', 'checkout', 'branch', 'stage', 'unstage', 'commit', 'amend'] as const

export interface ActionRequest {
  action: string
  // checkout: a branch of the repository, local or remote.
  // branch: the name of the branch to create and check out.
  branch?: string
  // branch: the commit to start from, HEAD when absent.
  from?: string
  // stage, unstage: files among the changes, all of them when absent.
  files?: string[]
  // commit, amend: the message.
  message?: string
}

// A fetch, a pull or a push waits for a remote, where the other commands only touch the disk.
const NETWORK_TIMEOUT_MS = 120_000
const MAX_OUTPUT = 4000

// What a command printed, trimmed for a person to read, and as it is for a parser, where a leading space means something.
type Git = (args: string[], timeoutMs?: number, raw?: boolean) => Promise<string>

function gitOf(root: Root, relative: string[], run: Run): Git {
  return async (args, timeoutMs = GIT_TIMEOUT_MS, raw = false) => {
    const result = await run(root.git, ['-C', repositoryPath(root, relative), ...args], { cwd: root.cwd, timeoutMs })
    const output = [result.stdout, result.stderr]
      .map((text) => text.trim())
      .filter(Boolean)
      .join('\n')
      .slice(-MAX_OUTPUT)
    // What git answers is the reason, a hook that refused a push for instance, and the interface shows it as it is.
    if (result.code !== 0) throw new RequestError(409, output || `${root.git} ${args[0]} exited with ${result.code}`)
    return raw ? result.stdout : output
  }
}

function invalid(message: string): never {
  throw new RequestError(400, message)
}

type Action = (typeof ACTIONS)[number]

interface Context {
  git: Git
  // What a command printed, untrimmed, for a parser.
  read: (args: string[]) => Promise<string>
  request: ActionRequest
}

async function pull({ git, read }: Context): Promise<string> {
  // Fast forward when it can, merge otherwise, whatever pull.rebase and pull.ff say, and never an editor for the message of the merge.
  try {
    return await git(['pull', '--no-rebase', '--ff', '--no-edit'], NETWORK_TIMEOUT_MS)
  } catch (error) {
    // A merge that stopped on a conflict is undone, so the repository is never left half merged.
    if (!(error instanceof RequestError) || (await read(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']).catch(() => '')) === '') throw error
    await git(['merge', '--abort'])
    throw new RequestError(409, `${error.message}\nThe merge was aborted, and the branch is as it was before the pull.`)
  }
}

async function push({ git, read }: Context): Promise<string> {
  const status = parseStatus(await read(['status', '--porcelain=v2', '--branch']))
  if (!status.branch) invalid('no branch is checked out, so there is nothing to push')
  if (status.upstream) return git(['push'], NETWORK_TIMEOUT_MS)
  // A branch never pushed goes to origin, or to the only remote, under its own name, and tracks it from then on.
  const remotes = (await git(['remote'])).split('\n').filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0]
  if (!remote) invalid('the repository has no remote to push to')
  return git(['push', '--set-upstream', remote, status.branch], NETWORK_TIMEOUT_MS)
}

async function checkout({ git, read, request }: Context): Promise<string> {
  const refs = await read(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)', 'refs/heads', 'refs/remotes'])
  const branches = parseBranches(refs)
  const target = branches.find((branch) => branch.name === request.branch)
  if (!target) invalid(`${request.branch} is not a branch of the repository`)
  if (!target.remote) return git(['switch', target.name])
  // A remote branch is checked out as the local branch of the same name, created to track it when it does not exist.
  const local = target.name.slice(target.name.indexOf('/') + 1)
  const exists = branches.some((branch) => !branch.remote && branch.name === local)
  return git(exists ? ['switch', local] : ['switch', '--track', target.name])
}

async function branch({ git, request }: Context): Promise<string> {
  const name = request.branch ?? ''
  if (name === '' || name.startsWith('-')) invalid('a branch needs a name, which does not start with a dash')
  if (request.from !== undefined && !/^[0-9a-f]{40}$/.test(request.from)) invalid('a branch starts from HEAD or from the full hash of a commit')
  try {
    await git(['check-ref-format', '--branch', name])
  } catch {
    invalid(`${name} is not a valid branch name`)
  }
  return git(['switch', '--create', name, ...(request.from ? [request.from] : [])])
}

async function stage({ git, read, request }: Context): Promise<string> {
  const command = request.action === 'stage' ? ['add', '--all'] : ['reset', '--quiet']
  if (request.files === undefined) return git(command)
  if (!Array.isArray(request.files) || request.files.length === 0 || request.files.some((file) => typeof file !== 'string')) invalid('files is a list of paths')
  const changes = parseChanges(await read(['status', '--porcelain=v1', '-z', '--untracked-files=all']))
  const paths: string[] = []
  for (const file of request.files) {
    const change = changes.find((candidate) => candidate.path === file)
    if (!change) invalid(`${file} is not among the changes of the repository`)
    // A renamed file is two paths in the index, the one it left and the one it took.
    paths.push(change.path, ...(change.from ? [change.from] : []))
  }
  return git([...command, '--', ...paths])
}

function messageOf(request: ActionRequest): string {
  const message = typeof request.message === 'string' ? request.message.trim() : ''
  if (message === '') invalid('a commit needs a message')
  return message
}

async function commit({ git, read, request }: Context): Promise<string> {
  const message = messageOf(request)
  const changes = parseChanges(await read(['status', '--porcelain=v1', '-z']))
  if (!changes.some((change) => change.staged !== ' ' && change.staged !== 'U')) invalid('nothing is staged, so there is nothing to commit')
  return git(['commit', '--message', message])
}

async function amend({ git, read, request }: Context): Promise<string> {
  const message = messageOf(request)
  if (!parseStatus(await read(['status', '--porcelain=v2', '--branch'])).head) invalid('there is no commit to amend yet')
  // A commit a remote holds is never rewritten, as the next push would have to force.
  if ((await read(UNPUSHED)).trim() === '') invalid('the last commit is already pushed, so it is not amended')
  return git(['commit', '--amend', '--message', message])
}

const HANDLERS: Record<Action, (context: Context) => Promise<string>> = {
  fetch: ({ git }) => git(['fetch', '--all', '--prune'], NETWORK_TIMEOUT_MS),
  pull,
  push,
  checkout,
  branch,
  stage,
  unstage: stage,
  commit,
  amend,
}

// Every value that reaches a git command is checked against what git itself lists, or against a strict form,
// so a request never names an option, a path outside of the changes, or a ref that does not exist.
export async function runAction(root: Root, relative: string[], run: Run, request: ActionRequest): Promise<{ output: string }> {
  if (!(ACTIONS as readonly string[]).includes(request.action)) invalid(`${request.action} is not one of ${ACTIONS.join(', ')}`)
  const git = gitOf(root, relative, run)
  const read = (args: string[]): Promise<string> => git(args, GIT_TIMEOUT_MS, true)
  return { output: await HANDLERS[request.action as Action]({ git, read, request }) }
}
