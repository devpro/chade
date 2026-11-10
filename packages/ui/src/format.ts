import type { Repository } from '@chade/daemon'

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
