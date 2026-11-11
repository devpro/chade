import type { Check, Repository } from '@chade/daemon'

const UNITS: [number, string][] = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [30, 'day'],
  [12, 'month'],
  [Infinity, 'year'],
]

export function ago(date: string, now: number): string {
  let value = Math.max(0, Math.floor((now - Date.parse(date)) / 1000))
  if (Number.isNaN(value)) return ''
  if (value < 60) return 'just now'
  for (const [size, unit] of UNITS) {
    if (value < size) return `${value} ${unit}${value === 1 ? '' : 's'} ago`
    value = Math.floor(value / size)
  }
  return ''
}

// A short label of the page, quiet when there is nothing to do about it.
export interface Badge {
  text: string
  tone: 'quiet' | 'info' | 'warn' | 'bad'
  title: string
}

export function sync(repository: Repository): Badge[] {
  if (!repository.branch) return []
  if (!repository.upstream) return [{ text: 'no upstream', tone: 'warn', title: 'The branch was never pushed' }]
  // An upstream without counts is a branch deleted on the remote.
  if (repository.ahead === undefined || repository.behind === undefined) {
    return [{ text: 'upstream gone', tone: 'warn', title: `${repository.upstream} no longer exists` }]
  }
  const badges: Badge[] = []
  if (repository.ahead > 0) badges.push({ text: `↑ ${repository.ahead}`, tone: 'info', title: `${repository.ahead} commit(s) to push to ${repository.upstream}` })
  if (repository.behind > 0) badges.push({ text: `↓ ${repository.behind}`, tone: 'warn', title: `${repository.behind} commit(s) to pull from ${repository.upstream}` })
  return badges.length > 0 ? badges : [{ text: 'in sync', tone: 'quiet', title: `Same commit as ${repository.upstream}, as of the last fetch` }]
}

export function changes(repository: Repository): Badge[] {
  const badges: Badge[] = []
  if (repository.conflicts > 0) badges.push({ text: `${repository.conflicts} in conflict`, tone: 'bad', title: 'Files with a merge conflict' })
  if (repository.changed > 0) badges.push({ text: `${repository.changed} changed`, tone: 'warn', title: 'Files changed, staged or not' })
  if (repository.untracked > 0) badges.push({ text: `${repository.untracked} untracked`, tone: 'warn', title: 'Files git does not track yet' })
  return badges.length > 0 ? badges : [{ text: 'clean', tone: 'quiet', title: 'Nothing to commit' }]
}

// The most pressing thing about a repository: bad to fix, warn to commit or pull, info to push, quiet when there is nothing to do.
export function tone(repository: Repository): Badge['tone'] {
  if (repository.error !== undefined) return 'bad'
  const tones = [...sync(repository), ...changes(repository)].map((badge) => badge.tone)
  return (['bad', 'warn', 'info'] as const).find((candidate) => tones.includes(candidate)) ?? 'quiet'
}

export function needsAttention(repository: Repository): boolean {
  return tone(repository) !== 'quiet'
}

export function matches(repository: Repository, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const text = `${repository.name} ${repository.path} ${repository.branch ?? ''}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

export function summary(repositories: Repository[]): string {
  const count = (test: (repository: Repository) => boolean) => repositories.filter(test).length
  const parts = [`${repositories.length} ${repositories.length === 1 ? 'repository' : 'repositories'}`]
  const add = (number: number, label: string) => {
    if (number > 0) parts.push(`${number} ${label}`)
  }
  add(count((repository) => repository.changed + repository.untracked + repository.conflicts > 0), 'with changes')
  add(count((repository) => (repository.ahead ?? 0) > 0), 'ahead')
  add(count((repository) => (repository.behind ?? 0) > 0), 'behind')
  add(count((repository) => repository.branch !== undefined && !repository.upstream), 'without upstream')
  add(count((repository) => repository.error !== undefined), 'unreadable')
  return parts.join(', ')
}

// A size as chade report prints it, in powers of 1000.
export function bytes(value: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000
    unit++
  }
  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`
}

// A duration as a run is read: in seconds under a minute, in minutes and seconds under an hour.
export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes} min` : `${minutes} min ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

// What IstarCI did with a commit: the mark of its line in the history, and the sentence that tells it.
export function checkOf(check: Check): { mark: string; tone: 'good' | 'bad' | 'info' | 'quiet'; text: string } {
  const took = check.durationMs === undefined ? '' : ` in ${duration(check.durationMs)}`
  switch (check.status) {
    case 'success':
      return { mark: '✓', tone: 'good', text: `Passed on IstarCI${took}` }
    case 'failure':
      return { mark: '✕', tone: 'bad', text: `Failed on IstarCI${check.durationMs === undefined ? '' : ` after ${duration(check.durationMs)}`}` }
    case 'running':
      return { mark: '●', tone: 'info', text: 'Running on IstarCI' }
    case 'queued':
      return { mark: '○', tone: 'info', text: 'Waiting to run on IstarCI' }
    case 'cancelled':
      return { mark: '⊘', tone: 'quiet', text: 'Stopped on IstarCI' }
    case 'skipped':
      return { mark: '◌', tone: 'quiet', text: 'Skipped by IstarCI' }
    case 'not-run':
      return { mark: '◌', tone: 'quiet', text: `Not run by IstarCI${check.reason ? `: ${check.reason}` : ''}` }
  }
}
