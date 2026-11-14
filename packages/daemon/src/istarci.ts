import { trimTrailing } from './text.js'

// IstarCI, a CI that runs on this machine, answers on its local HTTP API what it ran of each commit.
// chade reads it when it runs and shows nothing of it otherwise, so the two tools stay separate.

// Where IstarCI answers, and the token it asks for, read from its own configuration at each read.
export interface IstarciServer {
  url: string
  token: string
}

export const CHECK_STATUSES = ['queued', 'running', 'success', 'failure', 'cancelled', 'skipped', 'not-run'] as const
export type CheckStatus = (typeof CHECK_STATUSES)[number]

// What IstarCI did with one commit, and the page of IstarCI that tells more.
export interface Check {
  status: CheckStatus
  durationMs?: number
  // Why a commit was not run, in the words of IstarCI.
  reason?: string
  url: string
}

// The latest word of IstarCI on a repository, and the commit it is about, which may not be the one checked out.
export interface RepositoryCheck extends Check {
  sha: string
  branch?: string
}

// A folder of Windows is /mnt/c/... on WSL and C:\... on Windows, and its case and the way of its slashes do not matter, so one key names it on either side.
export function pathKey(path: string): string {
  const unix = trimTrailing(path.replaceAll('\\', '/'), '/')
  const mounted = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(unix)
  const drive = mounted ? `${mounted[1]}:${mounted[2] ?? ''}` : unix
  return /^[a-zA-Z]:(\/|$)/.test(drive) ? drive.toLowerCase() : drive
}

// A commit is at most a few seconds old in the graph before IstarCI knows it, so a slow answer is not worth waiting for.
const TIMEOUT_MS = 1000
// The most IstarCI answers in one read.
const LIMIT = 200
const SHA = /^[0-9a-f]{40}$/

type Fetch = typeof fetch

async function read(server: IstarciServer, route: string, query: URLSearchParams, fetcher: Fetch): Promise<unknown[]> {
  const search = query.size > 0 ? `?${query}` : ''
  const response = await fetcher(`${server.url}/api/v1/${route}${search}`, {
    headers: { Authorization: `Bearer ${server.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) return []
  const body: unknown = await response.json()
  return Array.isArray(body) ? body : []
}

const runUrl = (server: IstarciServer, id: string): string => `${server.url}/#/run/${encodeURIComponent(id)}`
const repositoryUrl = (server: IstarciServer, path: string): string => `${server.url}/#/repo/${encodeURIComponent(path)}`
// A workflow run by hand on a commit says nothing of the pipeline of that commit.
const byHand = (value: Record<string, unknown>): boolean => value.workflow !== null && value.workflow !== undefined

// The check a run of IstarCI gives its commit, absent for an answer that is not one.
function runCheck(server: IstarciServer, run: Record<string, unknown>): (Check & { sha: string }) | undefined {
  const { commitSha: sha, status, id } = run
  if (typeof sha !== 'string' || !SHA.test(sha) || byHand(run) || typeof id !== 'string') return undefined
  if (typeof status !== 'string' || !CHECK_STATUSES.includes(status as CheckStatus) || status === 'not-run') return undefined
  return { sha, status: status as CheckStatus, ...(typeof run.durationMs === 'number' ? { durationMs: run.durationMs } : {}), url: runUrl(server, id) }
}

// The check of a commit IstarCI did not run, which the page of the repository in IstarCI lists with the reason.
function eventCheck(server: IstarciServer, event: Record<string, unknown>, repoPath: string): (Check & { sha: string }) | undefined {
  const sha = event.commitSha
  if (typeof sha !== 'string' || !SHA.test(sha) || byHand(event)) return undefined
  return { sha, status: 'not-run', ...(typeof event.reason === 'string' ? { reason: event.reason } : {}), url: repositoryUrl(server, repoPath) }
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})

// The repositories IstarCI watches, by the key of their path, each with the path IstarCI knows it by and its latest check.
export async function readRepositories(server: IstarciServer | undefined, fetcher: Fetch = fetch): Promise<Map<string, { path: string; latest?: RepositoryCheck }>> {
  const watched = new Map<string, { path: string; latest?: RepositoryCheck }>()
  if (!server) return watched
  for (const repository of (await read(server, 'repos', new URLSearchParams(), fetcher).catch(() => [])).map(record)) {
    const { path } = repository
    if (typeof path !== 'string' || path === '') continue
    const run = record(repository.latestRun)
    const event = record(repository.latestEvent)
    const ran = runCheck(server, run)
    const skipped = eventCheck(server, event, path)
    // The newer of the two is the latest word, a commit run again after it was left out being known by its run.
    const newer = skipped !== undefined && (ran === undefined || (skipped.sha !== ran.sha && Number(event.at) > Number(run.triggeredAt)))
    const [check, source] = newer ? [skipped, event] : [ran, run]
    const branch = typeof source.branch === 'string' ? { branch: source.branch } : {}
    watched.set(pathKey(path), { path, ...(check ? { latest: { ...check, ...branch } } : {}) })
  }
  return watched
}

// The checks of the commits of one repository by their full hash, empty when IstarCI does not run, does not watch the repository, or answers anything unexpected.
// The repository is named by the path IstarCI knows it by.
export async function readChecks(server: IstarciServer | undefined, repoPath: string, fetcher: Fetch = fetch): Promise<Record<string, Check>> {
  if (!server) return {}
  const query = new URLSearchParams({ repoPath, limit: String(LIMIT) })
  const [runs, events] = await Promise.all([read(server, 'runs', query, fetcher).catch(() => []), read(server, 'events', query, fetcher).catch(() => [])])
  const checks: Record<string, Check> = {}
  // Both lists come newest first, and the newest answer about a commit is the one that holds.
  for (const answer of [...runs.map((run) => runCheck(server, record(run))), ...events.map((event) => eventCheck(server, record(event), repoPath))]) {
    if (!answer || checks[answer.sha]) continue
    const { sha, ...check } = answer
    checks[sha] = check
  }
  return checks
}
