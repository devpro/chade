import { compareVersions } from './scan.js'

// The tools of the machine and the dependencies of its repositories, with the newest version of each one.

export type ToolSource = 'apt' | 'direct' | 'nvm' | 'npm' | 'winget' | 'repository'

export interface InstalledTool {
  system: string
  name: string
  // Absent when neither the file nor its command gives a version.
  version?: string
  source: ToolSource
  // The path of the file, or the name of the package when a package manager owns it.
  path?: string
  package?: string
  latest?: string
  // The page of the release.
  url?: string
  command?: string
  // Another copy comes first on the PATH, so this one does not run.
  shadowed?: boolean
  // Why the newest version is not known, or what to know before an update.
  note?: string
}

export type DependencyKind = 'npm' | 'nuget' | 'image' | 'terraform'

export interface Dependency {
  system: string
  // The path of the repository, as its system writes it.
  repository: string
  repositoryName: string
  // The file that names the dependency, with / on all systems.
  file: string
  kind: DependencyKind
  name: string
  current: string
  latest?: string
  // The date of the newest version.
  date?: string
  // The registry has another image under the same tag.
  rebuilt?: boolean
  url?: string
  // How to update: a command, or a text to put in the file.
  command?: string
  replace?: string
  // The vulnerabilities of the last scan that the newest version fixes.
  fixes?: number
}

// Something that the inventory could not read.
export interface Problem {
  system?: string
  subject: string
  reason: string
}

export interface Inventory {
  machine: string
  date: string
  tools: InstalledTool[]
  dependencies: Dependency[]
  // The packages that apt can upgrade, and the date of the package lists.
  apt: { system: string; upgradable: number; date?: string }[]
  problems: Problem[]
}

const CORE = /^v?(\d+(?:\.\d+)*)/

// True when the candidate is newer. A pre-release comes before its release.
export function isNewer(candidate: string, current: string): boolean {
  const left = CORE.exec(candidate)?.[1]
  const right = CORE.exec(current)?.[1]
  if (left === undefined || right === undefined) return false
  const order = compareVersions(left, right)
  return order !== 0 ? order > 0 : preRelease(current) && !preRelease(candidate)
}

export function preRelease(version: string): boolean {
  return /^v?\d+(?:\.\d+)*-/.test(version.split('+')[0])
}

export type Change = 'major' | 'minor' | 'patch' | 'rebuilt'

export function changeOf(current: string, latest: string): Change {
  // The number before the colon is the epoch of a Debian package, and not a part of the version.
  const parts = (version: string): string[] => (CORE.exec(version.replace(/^\d+:/, ''))?.[1] ?? '').split('.')
  const [left, right] = [parts(current), parts(latest)]
  if (left[0] !== right[0]) return 'major'
  return (left[1] ?? '0') === (right[1] ?? '0') ? 'patch' : 'minor'
}

export function toolOutdated(tool: InstalledTool): boolean {
  if (tool.version === undefined || tool.latest === undefined) return false
  // apt and winget have their own order of versions, and give a newest version only when it differs.
  return tool.source === 'apt' || tool.source === 'winget' ? tool.latest !== tool.version : isNewer(tool.latest, tool.version)
}

export function dependencyOutdated(dependency: Dependency): boolean {
  return dependency.rebuilt === true || (dependency.latest !== undefined && dependency.latest !== dependency.current)
}

// The number of updates of one repository, and how many of them fix a known vulnerability.
export interface UpdateCount {
  system: string
  path: string
  count: number
  fixes: number
}

export function updateCounts(dependencies: Dependency[]): UpdateCount[] {
  const counts = new Map<string, UpdateCount>()
  for (const { system, repository: path, fixes } of dependencies.filter(dependencyOutdated)) {
    const known = counts.get(`${system}\n${path}`) ?? { system, path, count: 0, fixes: 0 }
    known.count++
    if (fixes) known.fixes++
    counts.set(`${system}\n${path}`, known)
  }
  return [...counts.values()]
}

// One package or image with a newer version, and each place that uses it.
export interface Update {
  kind: DependencyKind
  name: string
  latest?: string
  date?: string
  fixes: number
  change: Change
  uses: Dependency[]
}

const CHANGES: Change[] = ['major', 'minor', 'patch', 'rebuilt']

// The updates that fix a vulnerability come first, then the smallest changes, which are the easiest to take.
export function updatesOf(dependencies: Dependency[]): Update[] {
  const grouped = new Map<string, Update>()
  for (const use of dependencies.filter(dependencyOutdated)) {
    const key = `${use.kind}\n${use.name}\n${use.latest ?? ''}`
    const change = use.rebuilt || use.latest === undefined ? 'rebuilt' : changeOf(use.current, use.latest)
    const group = grouped.get(key) ?? { kind: use.kind, name: use.name, latest: use.latest, date: use.date, fixes: 0, change, uses: [] }
    group.uses.push(use)
    group.fixes = Math.max(group.fixes, use.fixes ?? 0)
    if (CHANGES.indexOf(change) < CHANGES.indexOf(group.change)) group.change = change
    grouped.set(key, group)
  }
  return [...grouped.values()].sort(
    (a, b) => b.fixes - a.fixes || CHANGES.indexOf(b.change) - CHANGES.indexOf(a.change) || a.name.localeCompare(b.name),
  )
}
