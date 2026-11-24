import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import type { Finding, Place } from '@chade/daemon'
import { seconds, type Progress } from './activity.js'
import { NOT_FOUND, type Result, type Run } from './exec.js'
import { GRYPE_OFFLINE, grypeDatabaseArgs, grypeImageArgs, readGrype } from './grype.js'
import { dropLists, keepList, readKept } from './imagelists.js'
import { mergeFindings, packageKey } from './merge.js'
import {
  OSV_FOUND,
  osvDatabase,
  osvFoundNoPackage,
  osvImageArgs,
  osvImageListArgs,
  osvKey,
  osvList,
  osvListArgs,
  osvListPurl,
  osvMissing,
  readOsvListed,
  readOsvMatches,
  readOsvOutput,
  type OsvListed,
} from './osv.js'
import { formatBytes, parseSize } from './report.js'
import type { Scanner, Tool } from './tools.js'
import { readTrivy, trivyDatabaseArgs, trivyImageArgs } from './trivy.js'

export interface DockerImage {
  // The full ID, sha256:…, which every name of the image shares.
  id: string
  names: string[]
  bytes: number
}

// A line of docker image ls --no-trunc --format json is one name of an image, so an image with two tags is two lines.
export function parseImages(output: string): DockerImage[] {
  const images = new Map<string, DockerImage>()
  for (const line of output.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    const row = JSON.parse(line) as Record<string, string>
    const image = images.get(row.ID) ?? { id: row.ID, names: [], bytes: parseSize(row.Size) ?? 0 }
    const name = `${row.Repository}:${row.Tag}`
    if (row.Repository !== '<none>' && row.Tag !== '<none>' && !image.names.includes(name)) image.names.push(name)
    images.set(row.ID, image)
  }
  return [...images.values()]
}

// The IDs of the images a container, running or stopped, was created from.
async function usedImages(run: Run): Promise<Set<string> | undefined> {
  const containers = await run('docker', ['ps', '--all', '--quiet', '--no-trunc'])
  if (containers.code !== 0) return undefined
  const ids = containers.stdout.split('\n').filter(Boolean)
  if (ids.length === 0) return new Set()
  const inspect = await run('docker', ['container', 'inspect', '--format', '{{.Image}}', ...ids])
  return inspect.code === 0 ? new Set(inspect.stdout.split('\n').filter(Boolean)) : undefined
}

export interface ImageOptions {
  log?: Progress
  system: string
  offline: boolean
  // The scanners of the system, each reading every image.
  tools: Tool[]
  // The folder of the kept lists of packages, none kept without it.
  lists?: string
  // The images read at the same time, from the free memory when not given.
  parallel?: number
}

export interface ImageResult {
  places: Place[]
  // Why the images could not be listed at all.
  skipped?: string
  // What went wrong with a scanner for all the images, such as a database that could not be updated.
  problems: Map<Scanner, string>
}

// What one scanner finds in one image.
interface Read {
  findings: Finding[]
  notes: string[]
  packages: string[]
}

// One image with what each scanner read of it, or why it could not.
interface Job {
  image: DockerImage
  place: Place
  step: string
  reads: Map<Scanner, Read | string>
}

interface Work {
  run: Run
  options: ImageOptions
  jobs: Job[]
  // Shared by the scanners, so the memory holds for all of them together.
  limit: <T>(read: () => Promise<T>) => Promise<T>
  problems: Map<Scanner, string>
  // The one folder of the temporary files of the scan and of its scanners, by its name in the folder of each tool.
  folder: string
}

const IMAGE_TIMEOUT_MS = 20 * 60_000
// osv-scanner alone takes up to 0.7 GB to load the databases that are not those of Ubuntu, and grype 0.7 GB for an image of 2 GB.
const MEMORY_PER_IMAGE = 2 * 1024 ** 3
const MAX_PARALLEL = 4

export function parallelImages(freeBytes: number): number {
  return Math.min(MAX_PARALLEL, Math.max(1, Math.floor(freeBytes / MEMORY_PER_IMAGE)))
}

const FOLDER_PREFIX = 'chade-images-'
const DAY_MS = 24 * 3600 * 1000

// A scan that was killed could not delete its folder, which can hold gigabytes of images.
async function dropAbandoned(parent: string): Promise<void> {
  for (const name of await readdir(parent).catch(() => [])) {
    if (!name.startsWith(FOLDER_PREFIX)) continue
    const info = await stat(join(parent, name)).catch(() => undefined)
    if (info && Date.now() - info.mtimeMs > DAY_MS) await rm(join(parent, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

// A scanner that is stopped by its time limit leaves the image it exported, so its temporary files go to the folder of the scan.
// The variables of WSL do not go to a tool of Windows.
function environment(work: Work, tool: Tool, more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return tool.cwd ? more : { ...more, TMPDIR: join(tool.temp.system, work.folder) }
}

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

// Runs at most a number of works at the same time, in the order they come.
function limiter(size: number): <T>(work: () => Promise<T>) => Promise<T> {
  const waiting: (() => void)[] = []
  let running = 0
  return async (work) => {
    if (running >= size) await new Promise<void>((resolve) => waiting.push(resolve))
    else running++
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      // The next work takes the place of this one.
      if (next) next()
      else running--
    }
  }
}

async function all(work: Work, jobs: Job[], read: (job: Job) => Promise<void>): Promise<void> {
  await Promise.all(jobs.map((job) => work.limit(() => read(job))))
}

// Reads one image with one scanner, with its time in the log.
async function timed(work: Work, tool: Tool, job: Job, what: string, read: () => Promise<Read | string>): Promise<Read | string> {
  const start = Date.now()
  const result = await read()
  const outcome = typeof result === 'string' ? `failed, ${result}` : 'done'
  work.options.log?.(`${job.step}: ${job.place.label}: ${tool.name} ${what}${outcome}, ${seconds(start)}`)
  return result
}

async function readWithTrivy(work: Work, tool: Tool): Promise<void> {
  // A database that cannot be updated still reads, as it was.
  if (!work.options.offline) {
    const update = await work.run(tool.command, trivyDatabaseArgs(), { cwd: tool.cwd, timeoutMs: 90_000 })
    if (update.code !== 0) notUpdated(work, tool, update)
  }
  // trivy locks its cache of layers, so it reads one image after the other.
  // With this cache, it reads only the layers that it does not know, and matches all the packages each time.
  for (const job of work.jobs) {
    const result = await timed(work, tool, job, '', async () => {
      const read = await work.run(tool.command, trivyImageArgs(job.image.id, work.options.offline), { cwd: tool.cwd, timeoutMs: IMAGE_TIMEOUT_MS, env: environment(work, tool) })
      return read.code === 0 ? readTrivy(read.stdout) : lastLine(read.stderr || read.stdout)
    })
    job.reads.set(tool.name, result)
  }
}

async function readWithGrype(work: Work, tool: Tool): Promise<void> {
  if (!work.options.offline) {
    const update = await work.run(tool.command, grypeDatabaseArgs(), { cwd: tool.cwd, timeoutMs: 300_000 })
    if (update.code !== 0) notUpdated(work, tool, update)
  }
  await all(work, work.jobs, async (job) => {
    const result = await timed(work, tool, job, '', async () => {
      // The database is updated once, and not again by each image.
      const read = await work.run(tool.command, grypeImageArgs(job.image.id), { cwd: tool.cwd, timeoutMs: IMAGE_TIMEOUT_MS, env: environment(work, tool, GRYPE_OFFLINE) })
      return read.code === 0 ? { findings: readGrype(read.stdout).map((match) => match.finding), notes: [], packages: [] } : lastLine(read.stderr || read.stdout)
    })
    job.reads.set(tool.name, result)
  })
}

// An old database misses the newest CVEs, so the scan says it.
function notUpdated(work: Work, tool: Tool, result: Result): void {
  const problem = `its database was not updated: ${lastLine(result.stderr || result.stdout) || `exited with ${result.code}`}`
  work.problems.set(tool.name, problem)
  work.options.log?.(`${tool.name}: ${problem}`)
}

// ─── osv-scanner ───────────────────────────────────────────────────────────

// osv-scanner exports an image by its name through docker itself, and one without a name is exported here.
async function withSource<T>(work: Work, tool: Tool, image: DockerImage, read: (source: string, archive: boolean) => Promise<T>): Promise<T | string> {
  if (image.names.length > 0) return read(image.names[0], false)
  const archive = join(tool.temp.local, work.folder, `${image.id.replace(/^sha256:/, '')}.tar`)
  try {
    const saved = await work.run('docker', ['save', '--output', archive, image.id], { timeoutMs: IMAGE_TIMEOUT_MS })
    return saved.code === 0 ? await read(archive, true) : lastLine(saved.stderr)
  } finally {
    await rm(archive, { force: true })
  }
}

const RENAMED = 'its name is now that of another image'

// The packages of an image, without their match.
interface Listing {
  packages: OsvListed[]
  // A file that could not be read may be read the next time, so the list is not kept.
  complete: boolean
}

async function listPackages(work: Work, tool: Tool, image: DockerImage): Promise<Listing | string> {
  return withSource(work, tool, image, async (source, archive) => {
    const read = await work.run(tool.command, osvImageListArgs(source, archive), { cwd: tool.cwd, timeoutMs: IMAGE_TIMEOUT_MS, env: environment(work, tool) })
    const empty = osvFoundNoPackage(read.code, read.stderr)
    // A file that a reader of osv-scanner cannot read gives an error, and the packages of the others are still right.
    const partial = !empty && read.code !== 0 && read.stderr.includes('Error during extraction') && read.stdout.trim() !== ''
    if (read.code !== 0 && !partial && !empty) return lastLine(read.stderr || read.stdout)
    if (!archive) {
      // A name can move to another image during the scan, and its packages must not be kept under this ID.
      const named = await work.run('docker', ['image', 'inspect', '--format', '{{.Id}}', source])
      if (named.stdout.trim() !== image.id) return RENAMED
    }
    return { packages: empty ? [] : readOsvListed(read.stdout), complete: !partial }
  })
}

// An image read and matched by the same call, as a list would lose findings.
async function readInFull(work: Work, tool: Tool, image: DockerImage, update: boolean): Promise<Read | string> {
  return withSource(work, tool, image, async (source, archive) => {
    const read = await work.run(tool.command, osvImageArgs(source, archive, !update), { cwd: tool.cwd, timeoutMs: IMAGE_TIMEOUT_MS, env: environment(work, tool) })
    if (osvFoundNoPackage(read.code, read.stderr)) return { findings: [], notes: [], packages: [] }
    const problem = problemOf(read)
    if (problem !== undefined) return problem
    const sources = readOsvOutput(read.stdout)
    return { findings: sources.flatMap((one) => one.findings), notes: [], packages: sources.flatMap((one) => one.packages) }
  })
}

interface Matched {
  // The findings of each package, by its key.
  findings: Map<string, Finding[]>
  // Why an ecosystem was not matched, by the name of its database.
  missing: Map<string, string>
  updated: Set<string>
}

// Matches the packages of one database by one call, so the database is updated and loaded once.
async function matchDatabase(work: Work, tool: Tool, name: string, packages: OsvListed[], matched: Matched): Promise<void> {
  const file = join(work.folder, `${name.replaceAll(/\W/g, '-')}.cdx.json`)
  const path = (tool.cwd ? win32 : posix).join(tool.temp.system, file)
  const match = (update: boolean): Promise<Result> => work.run(tool.command, osvListArgs(path, update), { cwd: tool.cwd, timeoutMs: 2 * IMAGE_TIMEOUT_MS })
  try {
    await writeFile(join(tool.temp.local, file), osvList(packages))
    let updated = !work.options.offline
    let result = await match(updated)
    if (updated && problemOf(result) !== undefined) {
      const failure = result
      updated = false
      result = await match(false)
      // Without a network, the database on the machine still matches.
      if (problemOf(result) === undefined) notUpdated(work, tool, failure)
    }
    const problem = problemOf(result)
    if (problem !== undefined) {
      if (osvMissing(result.stderr).length > 0) matched.missing.set(name, `no database for ${name}`)
      return
    }
    for (const [key, findings] of readOsvMatches(result.stdout)) matched.findings.set(key, findings)
    if (updated) matched.updated.add(name)
  } catch (error) {
    work.options.log?.(`osv-scanner: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// osv-scanner exits with the code of a found vulnerability even when a database is missing.
function problemOf(result: Result): string | undefined {
  const missing = osvMissing(result.stderr)
  if (missing.length > 0) return `no database for ${missing.join(', ')}`
  if (result.code === 0 || result.code === OSV_FOUND) return undefined
  return lastLine(result.stderr || result.stdout) || `exited with ${result.code}`
}

// The packages of no ecosystem have no finding from an image either.
const matchable = (pkg: OsvListed): boolean => pkg.ecosystem !== ''

// The packages of the images by the name of their database, each one once.
function byDatabase(lists: OsvListed[][]): Map<string, OsvListed[]> {
  const unique = new Map<string, OsvListed>()
  for (const list of lists) for (const pkg of list) if (matchable(pkg)) unique.set(osvKey(pkg), pkg)
  const groups = new Map<string, OsvListed[]>()
  for (const pkg of unique.values()) {
    const name = osvDatabase(pkg.ecosystem)
    const group = groups.get(name)
    if (group) group.push(pkg)
    else groups.set(name, [pkg])
  }
  return groups
}

async function readWithOsv(work: Work, tool: Tool): Promise<void> {
  const lists = await imageLists(work, tool)
  const inFull: Job[] = []
  const listed: Job[] = []
  for (const job of work.jobs) {
    if (job.reads.has(tool.name)) continue
    const packages = lists.get(job)
    if (packages?.filter(matchable).every(osvListPurl)) listed.push(job)
    else inFull.push(job)
  }
  const matched: Matched = { findings: new Map(), missing: new Map(), updated: new Set() }
  for (const [name, packages] of byDatabase(listed.map((job) => lists.get(job) ?? []))) {
    const start = Date.now()
    await matchDatabase(work, tool, name, packages, matched)
    work.options.log?.(`osv-scanner: ${packages.length} package(s) of ${name} matched, ${seconds(start)}`)
  }
  for (const job of listed) {
    const result = fromMatches(lists.get(job) ?? [], matched)
    if (result === undefined) inFull.push(job)
    else job.reads.set(tool.name, result)
  }
  await readAllInFull(work, tool, inFull, lists, matched.updated)
}

// The result of an image from the match of all of them, or undefined when a package did not come back as the image names it.
function fromMatches(packages: OsvListed[], matched: Matched): Read | string | undefined {
  const read: Read = { findings: [], notes: [], packages: [] }
  for (const pkg of packages.filter(matchable)) {
    const missing = matched.missing.get(osvDatabase(pkg.ecosystem))
    if (missing) return missing
    const findings = matched.findings.get(osvKey(pkg))
    if (!findings) return undefined
    // The ecosystem as the image names it.
    read.findings.push(...findings.map((finding) => ({ ...finding, ecosystem: pkg.ecosystem })))
    if (findings.length > 0) read.packages.push(packageKey(pkg.purl, pkg.ecosystem, pkg.name, pkg.version))
  }
  return read
}

// The images that a list cannot replace.
// Those that update a database are read one after the other, so that two of them do not write one file.
async function readAllInFull(work: Work, tool: Tool, jobs: Job[], lists: Map<Job, OsvListed[]>, updated: Set<string>): Promise<void> {
  const later: Job[] = []
  const namesOf = (job: Job): string[] | undefined => lists.get(job)?.filter(matchable).map((pkg) => osvDatabase(pkg.ecosystem))
  const read = async (job: Job, update: boolean): Promise<Read | string> => timed(work, tool, job, 'in full, ', () => readInFull(work, tool, job.image, update))
  for (const job of work.jobs.filter((one) => jobs.includes(one))) {
    const names = namesOf(job)
    if (work.options.offline || names?.every((name) => updated.has(name))) {
      later.push(job)
      continue
    }
    const result = await work.limit(() => read(job, true))
    if (typeof result === 'string') {
      // Without a network, the databases on the machine still match.
      const again = await work.limit(() => read(job, false))
      if (typeof again !== 'string') work.problems.set(tool.name, `its databases were not updated: ${result}`)
      job.reads.set(tool.name, again)
      continue
    }
    for (const name of names ?? []) updated.add(name)
    job.reads.set(tool.name, result)
  }
  const keep = async (job: Job): Promise<void> => void job.reads.set(tool.name, await read(job, false))
  // The database of Ubuntu takes more than 2 GB for each image, and an image without a list may need it.
  const heavy = later.filter((job) => namesOf(job)?.includes('Ubuntu') ?? true)
  await all(work, later.filter((job) => !heavy.includes(job)), keep)
  for (const job of heavy) await work.limit(() => keep(job))
}

// The packages of each image, from the kept list or from the image.
// An image without a list here is read in full.
async function imageLists(work: Work, tool: Tool): Promise<Map<Job, OsvListed[]>> {
  const found = new Map<Job, OsvListed[]>()
  await all(work, work.jobs, async (job) => {
    const folder = work.options.lists
    const kept = folder ? await readKept(folder, job.image.id, tool.name, tool.version) : undefined
    if (kept) {
      found.set(job, kept)
      work.options.log?.(`${job.step}: ${job.place.label}: osv-scanner list kept from the last read`)
      return
    }
    const start = Date.now()
    const listing = await listPackages(work, tool, job.image)
    const failure = typeof listing === 'string' ? listing : undefined
    work.options.log?.(`${job.step}: ${job.place.label}, ${formatBytes(job.image.bytes)}: osv-scanner list ${failure ? `failed, ${failure}` : 'done'}, ${seconds(start)}`)
    if (typeof listing === 'string') {
      if (listing === RENAMED) job.reads.set(tool.name, listing)
      return
    }
    found.set(job, listing.packages)
    if (folder && listing.complete) await keepList(folder, job.image.id, tool.name, tool.version, listing.packages)
  })
  return found
}

// ─── The images ────────────────────────────────────────────────────────────

export async function scanImages(run: Run, options: ImageOptions): Promise<ImageResult> {
  const problems = new Map<Scanner, string>()
  const listed = await run('docker', ['image', 'ls', '--no-trunc', '--format', 'json'])
  if (listed.code === NOT_FOUND) return { places: [], skipped: 'docker is not installed', problems }
  if (listed.code !== 0) return { places: [], skipped: `docker cannot list the images: ${(listed.stderr || listed.stdout).trim().split('\n')[0]}`, problems }
  const images = parseImages(listed.stdout)
  const used = await usedImages(run)
  if (options.lists) await dropLists(options.lists, images.map((image) => image.id))
  const jobs = images.map((image, index): Job => ({ image, place: imagePlace(image, options.system, used), step: `image ${index + 1} of ${images.length}`, reads: new Map() }))
  const size = options.parallel ?? parallelImages(freemem())
  const [tool] = options.tools
  if (tool && jobs.length > 0) {
    await dropAbandoned(tool.temp.local)
    const folder = await mkdtemp(join(tool.temp.local, FOLDER_PREFIX))
    try {
      await readJobs({ run, options, jobs, limit: limiter(size), problems, folder: basename(folder) }, size)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }
  for (const job of jobs) fill(job, options.tools)
  return { places: jobs.map((job) => job.place), problems }
}

async function readJobs(work: Work, size: number): Promise<void> {
  const { tools, log } = work.options
  log?.(`reading ${work.jobs.length} image(s), ${size} at a time`)
  const readers: Record<Scanner, (work: Work, tool: Tool) => Promise<void>> = { 'osv-scanner': readWithOsv, trivy: readWithTrivy, grype: readWithGrype }
  // The match of the packages of Ubuntu takes more than 2 GB, so the scanners run together only with the most free memory.
  if (size === MAX_PARALLEL) await Promise.all(tools.map((tool) => readers[tool.name](work, tool)))
  else for (const tool of tools) await readers[tool.name](work, tool)
}

// Puts what the scanners read in the place of the image, in the order of the scanners and not in that of their ends.
function fill(job: Job, tools: Tool[]): void {
  const { place } = job
  const findings: Finding[] = []
  const packages = new Set<string>()
  for (const tool of tools) {
    const read = job.reads.get(tool.name)
    if (read === undefined || typeof read === 'string') {
      place.notes.push(`${tool.name} could not read it: ${read ?? 'no result'}`)
      continue
    }
    findings.push(...read.findings)
    for (const pkg of read.packages) packages.add(pkg)
    for (const note of read.notes) if (!place.notes.includes(note)) place.notes.push(note)
    place.tools.push(tool.name)
  }
  place.findings = mergeFindings(findings)
  place.packages = packages.size
}

function imagePlace(image: DockerImage, system: string, used: Set<string> | undefined): Place {
  const short = image.id.replace(/^sha256:/, '').slice(0, 12)
  const place: Place = { system, kind: 'image', label: image.names.join(', ') || `<none> ${short}`, path: image.id, bytes: image.bytes, packages: 0, findings: [], notes: [], tools: [] }
  // Removing by name leaves an image other names still hold, and an image without a name goes by its ID.
  if (used && !used.has(image.id)) {
    place.unused = { reason: 'no container uses it', command: `docker image rm ${image.names.length > 0 ? image.names.join(' ') : short}` }
  }
  return place
}
