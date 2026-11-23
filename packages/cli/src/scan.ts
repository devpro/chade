import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, win32 } from 'node:path'
import { countsOf, findRepositories, SEVERITIES, type Finding, type Place, type Scan, type Skipped, type ToolUse } from '@chade/daemon'
import type { Config } from './config.js'
import type { Run } from './exec.js'
import { GRYPE_OFFLINE, grypeListArgs, readGrype } from './grype.js'
import { scanImages } from './images.js'
import { mergeFindings, packageKey } from './merge.js'
import { cycloneDx, OSV_FOUND, osvArgs, purlOf, readOsvOutput, type OsvSource } from './osv.js'
import { linuxSide, machineTargets, repositoryTargets, windowsSide, type Side, type Target } from './places.js'
import { folderSize, formatBytes } from './report.js'
import { repositoryRoots } from './roots.js'
import type { Host } from './system.js'
import { findTool, SCANNERS, type Scanner, type Tool } from './tools.js'
import { readTrivy, trivyDatabaseArgs, trivyFolderArgs, trivyListArgs } from './trivy.js'

export { countsOf, type Scan }

export const SCAN_GUIDE = 'https://github.com/devpro/chade/blob/main/docs/scan.md'

export interface ScanOptions {
  packages: boolean
  images: boolean
  offline: boolean
  unusedDays: number
  previous?: Scan
  now?: number
  log?: (line: string) => void
}

const DAY_MS = 24 * 3600 * 1000
// A command line of Windows holds 32,767 characters, so the folders go to osv-scanner a few dozen at a time.
const FOLDERS_PER_CALL = 40
const TOOL_TIMEOUT_MS = 30 * 60_000
// trivy reads one place per call, a few at a time.
const CONCURRENCY = 4

// The last scan, saved beside the configuration, as a scan takes minutes and the report and the interface read it.
export function scanFile(configFile: string): string {
  return join(dirname(configFile), 'scan.json')
}

export async function readScan(file: string): Promise<Scan | undefined> {
  let value: Scan
  try {
    value = JSON.parse(await readFile(file, 'utf8')) as Scan
  } catch {
    return undefined
  }
  // A scan saved before the scanners were recorded reads as one that names none.
  value.tools ??= []
  for (const place of value.places) {
    place.tools ??= []
    for (const finding of place.findings) finding.tools ??= []
  }
  return value
}

export async function saveScan(file: string, value: Scan): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

// The scanners of a system for a part, each said as found with its version or not installed.
async function scannersOf(host: Host, side: Side, part: ToolUse['part'], uses: ToolUse[]): Promise<Tool[]> {
  const found: Tool[] = []
  for (const name of SCANNERS) {
    const tool = await findTool(host, side, name)
    if (tool) found.push(tool)
    uses.push({ system: side.system.id, part, tool: name, ...(tool ? { version: tool.version } : { problem: 'not installed' }) })
  }
  return found
}

function noScanner(side: Side, part: string): Skipped {
  return { system: side.system.id, part, reason: `none of ${SCANNERS.join(', ')} is installed on ${side.windows ? 'Windows' : 'Linux'}, ${SCAN_GUIDE}#tools` }
}

export async function scan(config: Config | undefined, host: Host, options: ScanOptions): Promise<Scan> {
  const now = options.now ?? Date.now()
  const log = options.log ?? (() => undefined)
  const places: Place[] = []
  const skipped: Skipped[] = []
  const uses: ToolUse[] = []
  const sides: Side[] = []
  for (const system of host.systems) {
    if (system.kind === 'linux') sides.push(linuxSide(system, host.home, process.env))
    else if (host.windows) {
      const side = await windowsSide(system, host.windows)
      if (side) sides.push(side)
      else skipped.push({ system: system.id, part: 'packages', reason: 'USERPROFILE of Windows cannot be read' })
    }
  }
  if (options.packages) {
    const roots = config ? await repositoryRoots(config, host) : []
    for (const side of sides) {
      const tools = await scannersOf(host, side, 'packages', uses)
      if (tools.length === 0) {
        skipped.push(noScanner(side, 'packages'))
        continue
      }
      const targets = await machineTargets(side, process.version)
      for (const root of roots.filter((known) => known.system === side.system.id)) {
        targets.push(...(await repositoryTargets(side, root, await findRepositories(root.folder).catch(() => []), { unusedDays: options.unusedDays, now, run: host.run })))
      }
      log(`${side.system.id}: reading ${targets.length} place(s) with ${tools.map((tool) => tool.name).join(', ')}`)
      const problems = await readTargets(host.run, tools, side, targets, options.offline)
      for (const [name, problem] of problems) {
        const use = uses.find((one) => one.system === side.system.id && one.part === 'packages' && one.tool === name)
        if (use) use.problem = problem
      }
      places.push(...targets.map((one) => one.place).filter((place) => place.packages > 0 || place.findings.length > 0 || place.unused))
    }
  }
  if (options.images) {
    // Docker Desktop shares one engine between Windows and WSL, so the images are read once, by Linux when there is one.
    const side = sides.find((one) => !one.windows) ?? sides[0]
    if (side) {
      const tools = await scannersOf(host, side, 'images', uses)
      log(`${side.system.id}: reading the images of Docker with ${tools.map((tool) => tool.name).join(', ') || 'no scanner'}`)
      const fresh = options.previous && now - Date.parse(options.previous.date) < DAY_MS ? options.previous : undefined
      const result = await scanImages(host.run, {
        system: side.system.id,
        offline: options.offline,
        tools,
        previous: (id) => fresh?.places.find((place) => place.kind === 'image' && place.path === id),
      })
      places.push(...result.places)
      if (result.skipped) skipped.push({ system: side.system.id, part: 'images', reason: result.skipped })
      else if (tools.length === 0) skipped.push({ ...noScanner(side, 'images'), reason: `the images are listed without their vulnerabilities, as ${noScanner(side, 'images').reason}` })
    }
  }
  await measureUnused(host, sides, places)
  return { machine: host.machine, date: new Date(now).toISOString(), places, tools: uses, skipped }
}

// ─── Reading the places ────────────────────────────────────────────────────

// What the scanners found in one place, before the findings of one advisory are merged.
interface Reading {
  packages: Set<string>
  findings: Finding[]
  tools: Set<Scanner>
}

// A path as a key, the case of Windows aside.
function keyOf(side: Side, path: string): string {
  return side.windows ? path.replaceAll('\\', '/').toLowerCase() : path
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await work(items[next++])
  }
  await Promise.all(Array.from({ length: size }, worker))
}

const lastLine = (text: string): string =>
  text
    .trim()
    .split('\n')
    .filter((line) => !/^(Scanned|Scanning|Starting|End status|Loaded)/.test(line))
    .at(-1) ?? ''

// Every place read by each scanner of the system, the problems of a scanner returned by its name.
async function readTargets(run: Run, tools: Tool[], side: Side, targets: Target[], offline: boolean): Promise<Map<Scanner, string>> {
  const problems = new Map<Scanner, string>()
  // The packages of a list are known before any scanner reads them, so grype matches them even alone.
  const readings = new Map<Target, Reading>(targets.map((one) => [one, { packages: new Set((one.list ?? []).map((pkg) => packageKey(purlOf(pkg), '', '', ''))), findings: [], tools: new Set() }]))
  // The lists are written once, where the tools of the system read them, and named by the index of their place.
  const temp = tools[0].temp
  const folder = await mkdtemp(join(temp.local, 'chade-scan-'))
  const systemPath = (name: string) => (side.windows ? win32 : posix).join(temp.system, basename(folder), name)
  try {
    const lists = new Map<string, Target>()
    for (const [index, one] of targets.entries()) {
      if (!one.list || one.list.length === 0) continue
      await writeFile(join(folder, `${index}.cdx.json`), cycloneDx(one.list.map(purlOf)))
      lists.set(systemPath(`${index}.cdx.json`), one)
    }
    for (const tool of tools.filter((one) => one.name !== 'grype')) {
      const problem = tool.name === 'osv-scanner' ? await readWithOsv(run, tool, side, targets, lists, readings, offline) : await readWithTrivy(run, tool, targets, lists, readings, offline)
      if (problem) problems.set(tool.name, problem)
    }
    // grype matches what the others read against a database of its own, all the packages of the system in one list.
    const grype = tools.find((one) => one.name === 'grype')
    if (grype) {
      const problem = await matchWithGrype(run, grype, readings, join(folder, 'all.cdx.json'), systemPath('all.cdx.json'), offline)
      if (problem) problems.set('grype', problem)
    }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
  for (const [one, reading] of readings) {
    one.place.packages = reading.packages.size
    one.place.findings = mergeFindings(reading.findings)
    one.place.tools = SCANNERS.filter((name) => reading.tools.has(name))
  }
  return problems
}

async function readWithOsv(run: Run, tool: Tool, side: Side, targets: Target[], lists: Map<string, Target>, readings: Map<Target, Reading>, offline: boolean): Promise<string | undefined> {
  const folders = targets.filter((one) => one.folder !== undefined)
  const calls: { folders: string[]; lists: string[] }[] = []
  for (let start = 0; start < folders.length; start += FOLDERS_PER_CALL) calls.push({ folders: folders.slice(start, start + FOLDERS_PER_CALL).map((one) => one.folder ?? ''), lists: [] })
  if (lists.size > 0) calls.push({ folders: [], lists: [...lists.keys()] })
  const listKeys = new Map([...lists].map(([path, one]) => [keyOf(side, path), one]))
  for (const call of calls) {
    const result = await run(tool.command, osvArgs({ ...call, offline }), { cwd: tool.cwd, timeoutMs: TOOL_TIMEOUT_MS })
    if (result.code !== 0 && result.code !== OSV_FOUND) return `exited with ${result.code}: ${lastLine(result.stderr)}`
    for (const source of readOsvOutput(result.stdout)) {
      const owner = listKeys.get(keyOf(side, source.path)) ?? ownerOf(side, source, folders)
      const reading = owner && readings.get(owner)
      if (!reading) continue
      for (const pkg of source.packages) reading.packages.add(pkg)
      reading.findings.push(...source.findings)
      reading.tools.add('osv-scanner')
    }
  }
  return undefined
}

// The folder a file osv-scanner read lies under, the deepest when two hold it.
function ownerOf(side: Side, source: OsvSource, folders: Target[]): Target | undefined {
  const key = keyOf(side, source.path)
  return folders
    .filter((one) => {
      const prefix = keyOf(side, one.folder ?? '')
      return key === prefix || key.startsWith(`${prefix}/`)
    })
    .sort((a, b) => (b.folder?.length ?? 0) - (a.folder?.length ?? 0))[0]
}

async function readWithTrivy(run: Run, tool: Tool, targets: Target[], lists: Map<string, Target>, readings: Map<Target, Reading>, offline: boolean): Promise<string | undefined> {
  // A database that cannot be updated still reads, as it was.
  if (!offline) await run(tool.command, trivyDatabaseArgs(), { cwd: tool.cwd, timeoutMs: 90_000 })
  const listOf = new Map([...lists].map(([path, one]) => [one, path]))
  const failures: string[] = []
  await pool(targets, CONCURRENCY, async (one) => {
    const list = listOf.get(one)
    const args = one.folder !== undefined ? trivyFolderArgs(one.folder, offline) : list ? trivyListArgs(list, offline) : undefined
    if (!args) return
    const result = await run(tool.command, args, { cwd: tool.cwd, timeoutMs: TOOL_TIMEOUT_MS })
    if (result.code !== 0) {
      failures.push(lastLine(result.stderr || result.stdout))
      return
    }
    const read = readTrivy(result.stdout)
    const reading = readings.get(one)
    if (!reading) return
    for (const pkg of read.packages) reading.packages.add(pkg)
    reading.findings.push(...read.findings)
    reading.tools.add('trivy')
  })
  return failures.length > 0 ? `${failures.length} place(s) not read: ${failures[0]}` : undefined
}

async function matchWithGrype(run: Run, tool: Tool, readings: Map<Target, Reading>, local: string, system: string, offline: boolean): Promise<string | undefined> {
  // A package lies in every place that holds it, and a list holds it once.
  const holders = new Map<string, Reading[]>()
  for (const reading of readings.values()) {
    for (const pkg of reading.packages) holders.set(pkg, [...(holders.get(pkg) ?? []), reading])
  }
  const purls = [...holders.keys()].filter((key) => key.startsWith('pkg:'))
  if (purls.length === 0) return 'nothing to match, as it matches the packages osv-scanner and trivy read'
  await writeFile(local, cycloneDx(purls))
  const result = await run(tool.command, grypeListArgs(system), { cwd: tool.cwd, timeoutMs: TOOL_TIMEOUT_MS, env: offline ? GRYPE_OFFLINE : undefined })
  if (result.code !== 0) return `exited with ${result.code}: ${lastLine(result.stderr || result.stdout)}`
  for (const { key, finding } of readGrype(result.stdout)) {
    for (const reading of holders.get(key) ?? []) reading.findings.push(finding)
  }
  for (const reading of readings.values()) if ([...reading.packages].some((pkg) => pkg.startsWith('pkg:'))) reading.tools.add('grype')
  return undefined
}

// ─── Sizes ─────────────────────────────────────────────────────────────────

// PowerShell measures a folder of Windows where du through /mnt/c would take minutes, and is given the paths as JSON so that no quoting is needed.
export function sizeScript(paths: string[]): string {
  const json = JSON.stringify(paths).replaceAll("'", "''")
  return [
    `$paths = '${json}' | ConvertFrom-Json`,
    '$sizes = @{}',
    'foreach ($path in $paths) { $sizes[$path] = [int64](Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum }',
    '$sizes | ConvertTo-Json -Compress',
  ].join('\n')
}

async function measureUnused(host: Host, sides: Side[], places: Place[]): Promise<void> {
  const unmeasured = places.filter((place) => place.unused && place.bytes === undefined)
  for (const side of sides) {
    const own = unmeasured.filter((place) => place.system === side.system.id)
    if (own.length === 0) continue
    if (!side.windows) {
      for (const place of own) place.bytes = await folderSize(host, place.path)
      continue
    }
    for (let start = 0; start < own.length; start += FOLDERS_PER_CALL) {
      const batch = own.slice(start, start + FOLDERS_PER_CALL)
      const encoded = Buffer.from(sizeScript(batch.map((place) => place.path)), 'utf16le').toString('base64')
      const result = await host.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd: host.windows?.cwd(), timeoutMs: 600_000 })
      if (result.code !== 0) continue
      const sizes = JSON.parse(result.stdout.trim() || '{}') as Record<string, number>
      for (const place of batch) place.bytes = sizes[place.path]
    }
  }
}

// ─── Reading ───────────────────────────────────────────────────────────────

// The terminal gives the gist, and --json and the Security page of chade ui list every finding.
const PLACES_SHOWN = 10

function levelsOf(findings: Finding[]): string {
  const levels = SEVERITIES.map((level) => [level, findings.filter((finding) => !finding.malicious && finding.severity === level).length] as const)
  return levels
    .filter(([, count]) => count > 0)
    .map(([level, count]) => `${count} ${level}`)
    .join(', ')
}

// The places with the most severe findings first, then the most of them.
function exposure(a: Place, b: Place): number {
  for (const level of SEVERITIES) {
    const difference = b.findings.filter((one) => one.severity === level).length - a.findings.filter((one) => one.severity === level).length
    if (difference !== 0) return difference
  }
  return 0
}

export function renderScan(value: Scan): string {
  const counts = countsOf(value)
  const lines = [
    `${value.machine}, ${value.date.slice(0, 16).replace('T', ' ')} UTC`,
    `${value.places.length} place(s), ${counts.malicious} malicious package(s), ${levelsOf(value.places.flatMap((place) => place.findings)) || 'no known vulnerability'}`,
  ]
  const malicious = value.places.flatMap((place) => place.findings.filter((finding) => finding.malicious).map((finding) => ({ place, finding })))
  if (malicious.length > 0) lines.push('', 'Malicious, removed rather than updated, as they may have run at their install')
  for (const { place, finding } of malicious) lines.push(`  ${finding.package} ${finding.version}  ${finding.ids[0]}  ${finding.summary}`.trimEnd(), `    in ${place.label} (${place.system})`)
  const exposed = value.places.filter((place) => place.findings.some((finding) => !finding.malicious)).toSorted(exposure)
  if (exposed.length > 0) lines.push('', 'Most exposed')
  for (const place of exposed.slice(0, PLACES_SHOWN)) {
    const packages = place.packages > 0 ? ` in ${place.packages} package(s)` : ''
    lines.push(`  ${place.label} (${place.system}): ${levelsOf(place.findings)}${packages}`)
  }
  if (exposed.length > PLACES_SHOWN) lines.push(`  and ${exposed.length - PLACES_SHOWN} more place(s) with a known vulnerability`)
  const noted = value.places.filter((place) => place.notes.length > 0)
  if (noted.length > 0) lines.push('', 'Notes')
  for (const place of noted) lines.push(...place.notes.map((note) => `  ${place.label} (${place.system}): ${note}`))
  const unused = value.places.filter((place) => place.unused).toSorted((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  if (unused.length > 0) lines.push('', `Unused, ${formatBytes(counts.unusedBytes)}`)
  for (const place of unused.slice(0, PLACES_SHOWN)) {
    lines.push(`  ${place.label} (${place.system})${place.bytes === undefined ? '' : `, ${formatBytes(place.bytes)}`}, ${place.unused?.reason}`, `    ${place.unused?.command}`)
  }
  const rest = unused.slice(PLACES_SHOWN)
  if (rest.length > 0) lines.push(`  and ${rest.length} more, ${formatBytes(rest.reduce((sum, place) => sum + (place.bytes ?? 0), 0))}`)
  // Each scanner is a layer, so the scan says which ran on each system, and which is missing or failed.
  if ((value.tools ?? []).length > 0) lines.push('', 'Scanners')
  for (const key of [...new Set((value.tools ?? []).map((use) => `${use.system} ${use.part}`))]) {
    const uses = (value.tools ?? []).filter((use) => `${use.system} ${use.part}` === key)
    lines.push(`  ${key}: ${uses.map((use) => (use.problem ? `${use.tool} ${use.version ?? ''} (${use.problem})`.replace('  ', ' ') : `${use.tool} ${use.version}`)).join(', ')}`)
  }
  if (value.skipped.length > 0) lines.push('', 'Skipped')
  for (const skip of value.skipped) lines.push(`  ${skip.system} ${skip.part}: ${skip.reason}`)
  lines.push('', 'Every finding: chade scan --json, or the Security page of chade ui')
  return lines.join('\n')
}
