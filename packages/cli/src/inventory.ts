import { lstat, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  dependencyOutdated,
  findRepositories,
  isNewer,
  repositoryPath,
  toolOutdated,
  trackedFiles,
  updatesOf,
  type Dependency,
  type Inventory,
  type Problem,
  type Root,
  type Scan,
} from '@chade/daemon'
import type { Config } from './config.js'
import { environmentOf, linuxTools, windowsTools, type Environment, type ExtraTools } from './installed.js'
import { accepts, dependenciesOf, npmRegistries, usesNugetOrg, type Declared, type ReadText } from './manifests.js'
import { expandHome } from './paths.js'
import { newestTag, parseImage, Registries, VERSION, type Fetch, type ImageReference } from './registries.js'
import { repositoryRoots } from './roots.js'
import { pool } from './scan.js'
import type { Host } from './system.js'

export interface InventoryOptions {
  scan?: Scan
  fetch?: Fetch
  environment?: Environment
  now?: number
  log?: (line: string) => void
}

// A lock file can be large. A larger file is not one that a person or a tool keeps by hand.
const MAX_FILE = 20 * 1024 * 1024
// A registry answers several questions at once, and npm starts a process for each one.
const CONCURRENCY = 6

export function inventoryFile(configFile: string): string {
  return join(dirname(configFile), 'inventory.json')
}

export async function readInventory(file: string): Promise<Inventory | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Inventory
  } catch {
    return undefined
  }
}

export async function saveInventory(file: string, value: Inventory): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

interface Job {
  root: Root
  path: string
  name: string
  declared: Declared
}

// A link can lead out of the repository, so only a file itself is read.
function reader(folder: string): ReadText {
  return async (file) => {
    const path = join(folder, file)
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isFile() || info.size > MAX_FILE) return undefined
    return readFile(path, 'utf8').catch(() => undefined)
  }
}

const trimmed = (address: string): string => address.replace(/\/$/, '')

// A repository can give its own registry. Its private names must not go to another registry.
// Thus, chade asks for them only when the user has the same setting.
async function npmRefused(tracked: string[], read: ReadText, registries: Registries): Promise<(name: string) => boolean> {
  const other = new Set<string>()
  for (const file of tracked.filter((one) => /(?:^|\/)\.npmrc$/.test(one))) {
    for (const [key, address] of npmRegistries((await read(file)) ?? '')) {
      const own = await registries.npmSetting(key)
      if (own === undefined || trimmed(own) !== trimmed(address)) other.add(key)
    }
  }
  return (name) => other.has(name.startsWith('@') ? `${name.split('/')[0]}:registry` : 'registry')
}

// The dependencies of a repository that chade can ask for.
async function repositoryJobs(root: Root, relative: string[], host: Host, registries: Registries, problems: Problem[]): Promise<Job[]> {
  const path = repositoryPath(root, relative)
  const name = relative.length > 0 ? relative.join('/') : path
  const tracked = await trackedFiles(root, relative, host.run)
  if (!tracked) {
    problems.push({ system: root.system, subject: path, reason: 'git cannot list the files' })
    return []
  }
  const read = reader(join(root.folder, ...relative))
  const declared = await dependenciesOf(tracked, read)
  const refused = await npmRefused(tracked, read, registries)
  const configs = await Promise.all(tracked.filter((file) => /(?:^|\/)nuget\.config$/i.test(file)).map(read))
  const nugetOrg = configs.every((text) => text === undefined || usesNugetOrg(text))
  const kept = declared.filter((one) => (one.kind === 'npm' ? !refused(one.name) : one.kind !== 'nuget' || nugetOrg))
  if (kept.length < declared.length) {
    problems.push({ system: root.system, subject: path, reason: `${declared.length - kept.length} package(s) not read, as the repository has a registry of its own that the settings of the user do not have` })
  }
  return kept.map((one) => ({ root, path, name, declared: one }))
}

// The digests of an image of the machine, absent when Docker does not hold it.
async function localDigests(host: Host, reference: string): Promise<string[] | undefined> {
  const result = await host.run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', reference], { timeoutMs: 30_000 })
  if (result.code !== 0) return undefined
  const digests = JSON.parse(result.stdout) as string[] | null
  return (digests ?? []).map((one) => one.split('@')[1])
}

const withTag = (image: ImageReference, tag: string): string => `${image.name}:${tag}`

async function readImage(job: Job, host: Host, registries: Registries, dependency: Dependency): Promise<boolean> {
  const image = parseImage(job.declared.name)
  if (!image) return false
  Object.assign(dependency, { name: image.name, current: image.tag })
  const tags = await registries.imageTags(image)
  const newer = newestTag(image.tag, tags)
  if (newer) {
    Object.assign(dependency, { latest: newer, replace: withTag(image, newer) })
    return true
  }
  dependency.latest = image.tag
  // The same tag can have a new image, which most often has the security fixes of its system.
  const held = image.digest ? [image.digest] : await localDigests(host, job.declared.name)
  if (!held || held.length === 0) return true
  const digest = await registries.imageDigest(image)
  if (digest === undefined || held.includes(digest)) return true
  dependency.rebuilt = true
  if (image.digest) dependency.replace = `${withTag(image, image.tag)}@${digest}`
  else dependency.command = `docker pull ${withTag(image, image.tag)}`
  return true
}

async function readPackage(job: Job, registries: Registries, dependency: Dependency): Promise<void> {
  const { kind, name, range, current, command, replace } = job.declared
  const ask = { npm: () => registries.npm(name), nuget: () => registries.nuget(name), terraform: () => registries.terraform(name) }
  if (kind === 'image') return
  const latest = await ask[kind]()
  if (!VERSION.test(latest.version)) throw new Error('the registry gave no version')
  // Without a lock file, an install takes each version that the range accepts.
  if (!isNewer(latest.version, current) || (range !== undefined && accepts(range, latest.version))) {
    dependency.latest = current
    return
  }
  Object.assign(dependency, { latest: latest.version, url: latest.url, ...(latest.date ? { date: latest.date } : {}) })
  const line = command?.(latest.version)
  const text = replace?.(latest.version)
  if (line !== undefined) dependency.command = line
  if (text !== undefined) dependency.replace = text
}

// The ecosystem that the scanners give to each kind.
const ECOSYSTEMS: Partial<Record<Dependency['kind'], string>> = { npm: 'npm', nuget: 'nuget' }

// The vulnerabilities that the scan found in the repository and that the newest version fixes.
function fixesOf(dependency: Dependency, scan: Scan | undefined): number {
  const ecosystem = ECOSYSTEMS[dependency.kind]
  const { latest } = dependency
  if (!scan || !ecosystem || latest === undefined || latest === dependency.current) return 0
  const inside = (path: string): boolean => path.startsWith(`${dependency.repository}/`) || path.startsWith(`${dependency.repository}\\`)
  const findings = scan.places.filter((place) => place.system === dependency.system && place.kind === 'repository' && inside(place.path)).flatMap((place) => place.findings)
  const fixed = findings.filter(
    (finding) =>
      finding.ecosystem.toLowerCase() === ecosystem &&
      finding.package.toLowerCase() === dependency.name.toLowerCase() &&
      finding.version === dependency.current &&
      !finding.malicious &&
      finding.fixed !== undefined &&
      !isNewer(finding.fixed, latest),
  )
  return new Set(fixed.map((finding) => finding.ids[0])).size
}

async function readDependency(job: Job, host: Host, registries: Registries, scan: Scan | undefined): Promise<{ dependency?: Dependency; problem?: Problem }> {
  const { root, path, name, declared } = job
  const dependency: Dependency = { system: root.system, repository: path, repositoryName: name, file: declared.file, kind: declared.kind, name: declared.name, current: declared.current }
  try {
    if (declared.kind === 'image') {
      if (!(await readImage(job, host, registries, dependency))) return {}
    } else await readPackage(job, registries, dependency)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { dependency, problem: { system: root.system, subject: `${declared.name} in ${path}`, reason } }
  }
  const fixes = fixesOf(dependency, scan)
  if (fixes > 0) dependency.fixes = fixes
  return { dependency }
}

export async function inventory(config: Config | undefined, host: Host, options: InventoryOptions = {}): Promise<Inventory> {
  const registries = new Registries(host, options.fetch)
  const result: Inventory = { machine: host.machine, date: new Date(options.now ?? Date.now()).toISOString(), tools: [], dependencies: [], apt: [], problems: [] }
  const extra: ExtraTools = Object.fromEntries((config?.inventory?.tools ?? []).map((tool) => [tool.name, { github: tool.github }]))
  for (const system of host.systems) {
    options.log?.(`${system.id}: reading the tools`)
    const found = system.kind === 'linux' ? await linuxTools(host, system, options.environment ?? environmentOf(host.home, process.env), extra, registries) : await windowsTools(host, system)
    result.tools.push(...found.tools)
    result.problems.push(...found.problems)
    if (found.apt) result.apt.push(found.apt)
  }
  const skipped = (config?.inventory?.skip ?? []).map((path) => trimmed(expandHome(path, host.home)))
  const jobs: Job[] = []
  for (const root of config ? await repositoryRoots(config, host) : []) {
    for (const relative of await findRepositories(root.folder)) {
      const path = repositoryPath(root, relative)
      if (skipped.some((one) => path === one || path.startsWith(`${one}${root.separator}`))) continue
      jobs.push(...(await repositoryJobs(root, relative, host, registries, result.problems)))
    }
  }
  options.log?.(`asking the registries for ${jobs.length} dependencies`)
  const read = new Array<Awaited<ReturnType<typeof readDependency>>>(jobs.length)
  await pool([...jobs.entries()], CONCURRENCY, async ([index, job]) => {
    read[index] = await readDependency(job, host, registries, options.scan)
  })
  for (const { dependency, problem } of read) {
    if (dependency) result.dependencies.push(dependency)
    if (problem) result.problems.push(problem)
  }
  // Without a network, the last inventory saved stays.
  if (jobs.length > 0 && result.dependencies.every((dependency) => dependency.latest === undefined)) throw new Error(`no registry answered: ${result.problems.at(-1)?.reason ?? 'no version was given'}`)
  return result
}

export function renderInventory(value: Inventory): string {
  const lines = [`Inventory of ${value.machine}`]
  const tools = value.tools.filter(toolOutdated)
  lines.push('', `Tools: ${value.tools.length}, ${tools.length} with a newer version`)
  for (const tool of tools) lines.push(`  ${tool.name} ${tool.version} -> ${tool.latest} (${tool.source}, ${tool.system})`)
  for (const apt of value.apt) if (apt.upgradable > 0) lines.push(`  ${apt.upgradable} apt package(s) to upgrade on ${apt.system}`)
  const updates = updatesOf(value.dependencies)
  lines.push('', `Dependencies: ${value.dependencies.length}, ${value.dependencies.filter(dependencyOutdated).length} with a newer version`)
  for (const update of updates) {
    const from = [...new Set(update.uses.map((use) => use.current))].join(', ')
    const to = update.change === 'rebuilt' ? 'a new image under the same tag' : update.latest
    const fixes = update.fixes > 0 ? `, fixes ${update.fixes} known vulnerabilities` : ''
    const repositories = [...new Set(update.uses.map((use) => use.repositoryName))].join(', ')
    lines.push(`  ${update.kind} ${update.name} ${from} -> ${to}${fixes}, in ${repositories}`)
  }
  if (value.problems.length > 0) lines.push('', 'Unknown:', ...value.problems.map((problem) => `  ${problem.subject}: ${problem.reason}`))
  return lines.join('\n')
}
