import { existsSync } from 'node:fs'
import { readdir, readFile, stat, statfs } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { countsOf, findRepositories, SEVERITIES, trimTrailing, type Measure, type Report, type Scan, type Section } from '@chade/daemon'
import type { Config } from './config.js'
import { docsPointer } from './docs.js'
import { NOT_FOUND } from './exec.js'
import { expandHome } from './paths.js'
import { resolveRoot } from './roots.js'
import { isNativeWindows, type Host, type System } from './system.js'
import type { Windows } from './windows.js'

export type { Measure, Report, Section }

// The last report, saved beside the configuration, which the interface shows at once.
export function reportFile(configFile: string): string {
  return join(dirname(configFile), 'report.json')
}

export async function readReport(file: string): Promise<Report | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Report
  } catch {
    return undefined
  }
}

const GB = 1e9

// A size the cleanup is worth running for, below which a hint would be noise.
const WORTH = 5 * GB

export async function report(config: Config | undefined, host: Host, scanned?: Scan): Promise<Report> {
  const sections: Section[] = []
  for (const system of host.systems) {
    const measured = system.kind === 'windows' ? await windowsSections(config, host, system) : await linuxSections(config, host, system)
    const places = scanned?.places.filter((place) => place.system === system.id) ?? []
    measured.push(security(scanned && { ...scanned, places }))
    for (const section of measured) {
      if (section && (section.measures.length > 0 || section.hints.length > 0)) sections.push({ ...section, system: system.id })
    }
  }
  return { machine: host.machine, date: new Date().toISOString(), sections }
}

async function windowsSections(config: Config | undefined, host: Host, system: System): Promise<(Section | undefined)[]> {
  const windows = host.windows
  if (!windows) return []
  const native = isNativeWindows(host)
  const lxss = await windows.exec(['reg', 'query', String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss`, '/s'])
  const distributions = parseLxss(lxss.stdout)
  return [
    await windowsDisk(windows, native ? undefined : await diskUsage('/'), native, distributions),
    // A Windows without a distribution has no use for the settings of WSL.
    distributions.length > 0 ? await wslConfig(windows) : undefined,
    await windowsMemory(host, windows, native),
    // On WSL, the Docker that answers is the one of the distribution.
    native ? await docker(host, native) : undefined,
    await windowsCaches(host, windows),
    await windowsAgentSessions(host, windows),
    await repositories(config, host, system),
  ]
}

async function linuxSections(config: Config | undefined, host: Host, system: System): Promise<(Section | undefined)[]> {
  return [
    await memory(host),
    await linuxDisk(host, await diskUsage('/')),
    await docker(host, false),
    await journal(host),
    await snaps(host),
    await caches(host),
    await agentSessions(host),
    await repositories(config, host, system),
  ]
}

// ── Parsing ────────────────────────────────────────────────────────────────

// Docker writes sizes in powers of 1000 (kB, MB, GB) and journalctl in powers of 1024 (K, M, G).
export function parseSize(text: string, base = 1000): number | undefined {
  const match = /^([\d.]+)\s*([kKMGTP]?)i?B?$/.exec(text.trim())
  if (!match) return undefined
  const power = ['', 'K', 'M', 'G', 'T', 'P'].indexOf(match[2].toUpperCase())
  return Math.round(Number(match[1]) * base ** power)
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

export interface DockerUsage {
  type: string
  size: number
  reclaimable: number
  total: number
  active: number
}

export function parseDockerDf(output: string): DockerUsage[] {
  return output
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      const row = JSON.parse(line) as Record<string, string>
      return {
        type: row.Type,
        size: parseSize(row.Size) ?? 0,
        reclaimable: parseSize(row.Reclaimable.split(' ')[0]) ?? 0,
        total: Number(row.TotalCount),
        active: Number(row.Active),
      }
    })
}

export interface Distribution {
  name: string
  basePath: string
}

export function parseLxss(output: string): Distribution[] {
  const distributions: Distribution[] = []
  let current: Partial<Distribution> = {}
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) current = {}
    const value = /^\s+(DistributionName|BasePath)\s+REG_\w+\s+(\S.*)$/.exec(line)
    if (value?.[1] === 'DistributionName') current.name = value[2].trim()
    // A distribution moved or imported keeps its path in the \\?\ form of long Windows paths.
    if (value?.[1] === 'BasePath') current.basePath = value[2].trim().replace(/^\\\\\?\\/, '')
    if (current.name && current.basePath && !distributions.includes(current as Distribution)) distributions.push(current as Distribution)
  }
  return distributions
}

export function parseIni(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(/[#;]/, 1)[0].trim()
    const header = /^\[(.+)\]$/.exec(line)
    if (header) section = header[1].trim().toLowerCase()
    const pair = /^([^=]+)=(.*)$/.exec(line)
    if (pair) values[`${section}.${pair[1].trim().toLowerCase()}`] = pair[2].trim()
  }
  return values
}

export function parseMeminfo(text: string): Record<string, number> {
  const values: Record<string, number> = {}
  for (const match of text.matchAll(/^(\w+):\s+(\d+) kB$/gm)) values[match[1]] = Number(match[2]) * 1024
  return values
}

// A timer line is NEXT LEFT LAST PASSED UNIT ACTIVATES, the dates holding spaces, and NEXT a dash when it is never scheduled.
export function scheduledTimers(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((tokens) => tokens.length >= 2 && tokens[0] !== '-' && tokens[0] !== '')
    .map((tokens) => tokens.at(-2) ?? '')
}

export interface Process {
  name: string
  bytes: number
}

// A line of ps -eo rss=,comm= is the resident memory in kB, then the command.
export function parsePs(output: string): Process[] {
  return [...output.matchAll(/^[ \t]*(\d+)[ \t]+(\S.*)$/gm)].map((match) => ({ name: match[2].trim(), bytes: Number(match[1]) * 1024 }))
}

// A line of tasklist /fo csv /nh is image, PID, session, session number and memory in kB, written with the digit grouping of the locale.
export function parseTasklist(output: string): Process[] {
  return [...output.matchAll(/^"([^"]+)","[^"]*","[^"]*","[^"]*","([^"]*)"/gm)]
    .filter((match) => /\d/.test(match[2]))
    .map((match) => ({ name: match[1], bytes: Number(match[2].replace(/\D/g, '')) * 1024 }))
}

export function topProcesses(processes: Process[], count: number): Measure[] {
  const totals = new Map<string, number>()
  for (const { name, bytes } of processes) totals.set(name, (totals.get(name) ?? 0) + bytes)
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([label, bytes]) => ({ label, bytes }))
}

// ── Measures ───────────────────────────────────────────────────────────────

interface Usage {
  size: number
  used: number
  available: number
}

// The figures of df, which reads them the same way, and a drive letter works as well as a mount point.
export async function diskUsage(path: string): Promise<Usage | undefined> {
  const info = await statfs(path).catch(() => undefined)
  if (!info || info.blocks === 0) return undefined
  return { size: info.blocks * info.bsize, used: (info.blocks - info.bfree) * info.bsize, available: info.bavail * info.bsize }
}

// du exits with 1 for a single unreadable folder, while its total of the rest is still right.
export async function folderSize(host: Host, path: string): Promise<number | undefined> {
  if (!existsSync(path)) return undefined
  const result = await host.run('du', ['-sb', path], { timeoutMs: 600_000 })
  const size = Number(result.stdout.trim().split(/\s+/)[0])
  return result.stdout.trim() !== '' && Number.isFinite(size) ? size : undefined
}

// The labels of the robocopy summary depend on the language of Windows, and their order does not: folders, files, then bytes.
export function parseRobocopy(output: string): number | undefined {
  const totals = output
    .split('\n')
    .map((line) => line.slice(line.indexOf(':') + 1).trim().split(/\s+/))
    .filter((values) => values.length === 6 && values.every((value) => /^\d+$/.test(value)))
  return totals.length === 3 ? Number(totals[2][0]) : undefined
}

// Through /mnt/c, du takes minutes where robocopy takes seconds.
// /L makes robocopy list the files without a copy, and /XJ keeps it out of the junctions.
async function windowsFolderSize(host: Host, windows: Windows, path: string): Promise<number | undefined> {
  if (!(await windowsFolderExists(windows, path))) return undefined
  const args = [path, 'NUL', '/L', '/E', '/XJ', '/NFL', '/NDL', '/NJH', '/NP', '/BYTES', '/R:0', '/W:0']
  const result = await host.run('robocopy.exe', args, { cwd: windows.cwd(), timeoutMs: 600_000 })
  return parseRobocopy(result.stdout)
}

async function windowsFolderExists(windows: Windows, path: string): Promise<boolean> {
  return existsSync(await windows.linuxPath(path).catch(() => ''))
}

function usageDetail(usage: Usage): string {
  return `${formatBytes(usage.used)} used of ${formatBytes(usage.size)}, ${formatBytes(usage.available)} free`
}

async function windowsDisk(windows: Windows, linuxRoot: Usage | undefined, native: boolean, distributions: Distribution[]): Promise<Section> {
  const section: Section = { title: 'Windows disk', measures: [], hints: [], guide: 'disk-image-compaction' }
  const drive = await diskUsage(native ? 'C:\\' : '/mnt/c')
  if (drive) section.measures.push({ label: 'C:', detail: usageDetail(drive) })
  const current = process.env.WSL_DISTRO_NAME
  for (const distribution of distributions) {
    const image = String.raw`${distribution.basePath}\ext4.vhdx`
    const info = await stat(await windows.linuxPath(image)).catch(() => undefined)
    if (!info) continue
    section.measures.push({ label: `${distribution.name} disk image`, bytes: info.size, detail: image })
    if (distribution.name === current && linuxRoot && info.size - linuxRoot.used > WORTH) {
      section.hints.push(
        `${distribution.name} uses ${formatBytes(linuxRoot.used)} of an image of ${formatBytes(info.size)} on C:, so ${formatBytes(info.size - linuxRoot.used)} come back once trimmed and compacted:`,
        '  sudo fstrim -av',
        'Then, from an administrator prompt on Windows:',
        '  wsl --shutdown',
        '  diskpart',
        `  select vdisk file="${image}"`,
        '  attach vdisk readonly',
        '  compact vdisk',
        '  detach vdisk',
        '  exit',
      )
    }
  }
  return section
}

async function wslConfig(windows: Windows): Promise<Section> {
  const section: Section = { title: 'WSL settings', measures: [], hints: [], guide: 'wsl-memory' }
  const profile = await windows.env('USERPROFILE')
  if (!profile) return section
  const file = await windows.linuxPath(String.raw`${profile}\.wslconfig`)
  const values = parseIni(await readFile(file, 'utf8').catch(() => ''))
  for (const key of ['wsl2.memory', 'wsl2.swap', 'experimental.automemoryreclaim']) {
    section.measures.push({ label: key, detail: values[key] ?? 'not set' })
  }
  if (!values['wsl2.memory']) section.hints.push(String.raw`Without memory in [wsl2] of %USERPROFILE%\.wslconfig, WSL may take half of the RAM of Windows, a limit applied with wsl --shutdown.`)
  if (!values['experimental.automemoryreclaim']) section.hints.push(String.raw`autoMemoryReclaim=gradual in [experimental] of %USERPROFILE%\.wslconfig gives the cache memory of Linux back to Windows.`)
  return section
}

// Services that hold memory as long as they run, and that a development machine starts for a while and forgets.
const SERVICES = [{ process: 'kubelite', hint: 'MicroK8s is running, and stopping it frees its memory until it is started again:', command: 'sudo microk8s stop' }]

// Total and free memory in kB, one on each line. Windows counts its standby cache as free, as MemAvailable does on Linux.
const WINDOWS_MEMORY = 'Get-CimInstance Win32_OperatingSystem | ForEach-Object { $_.TotalVisibleMemorySize; $_.FreePhysicalMemory }'

async function windowsRam(host: Host, windows: Windows, native: boolean): Promise<{ total: number; free: number } | undefined> {
  if (native) return { total: totalmem(), free: freemem() }
  const result = await host.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_MEMORY], { cwd: windows.cwd(), timeoutMs: 60_000 })
  const [total, free] = result.stdout.trim().split(/\s+/).map((value) => Number(value) * 1024)
  return total > 0 && free >= 0 ? { total, free } : undefined
}

async function windowsMemory(host: Host, windows: Windows, native: boolean): Promise<Section> {
  const section: Section = { title: 'Memory', measures: [], hints: [] }
  const ram = await windowsRam(host, windows, native)
  if (ram) section.measures.push({ label: 'RAM', detail: `${formatBytes(ram.total - ram.free)} used of ${formatBytes(ram.total)}` })
  const tasklist = await host.run('tasklist.exe', ['/fo', 'csv', '/nh'], { cwd: windows.cwd() })
  for (const process of topProcesses(parseTasklist(tasklist.stdout), 8)) section.measures.push({ ...process, label: `process ${process.label}` })
  return section
}

async function memory(host: Host): Promise<Section> {
  const section: Section = { title: 'Memory', measures: [], hints: [], guide: 'running-services' }
  const info = parseMeminfo(await readFile('/proc/meminfo', 'utf8').catch(() => ''))
  if (info.MemTotal) {
    section.measures.push({ label: 'RAM', detail: `${formatBytes(info.MemTotal - info.MemAvailable)} used of ${formatBytes(info.MemTotal)}` })
  }
  if (info.SwapTotal) {
    const swapUsed = info.SwapTotal - info.SwapFree
    section.measures.push({ label: 'Swap', detail: `${formatBytes(swapUsed)} used of ${formatBytes(info.SwapTotal)}` })
    if (swapUsed > info.SwapTotal / 4) section.hints.push('A quarter of the swap is in use, the processes below are the first to stop.')
  }
  const processes = parsePs((await host.run('ps', ['-eo', 'rss=,comm='])).stdout)
  for (const process of topProcesses(processes, 8)) section.measures.push({ ...process, label: `process ${process.label}` })
  for (const service of SERVICES) {
    if (processes.some((process) => process.name === service.process)) section.hints.push(service.hint, `  ${service.command}`)
  }
  return section
}

async function linuxDisk(host: Host, root: Usage | undefined): Promise<Section> {
  const section: Section = { title: 'Linux disk', measures: [], hints: [], guide: 'weekly-prune-and-trim' }
  if (root) section.measures.push({ label: '/', detail: usageDetail(root) })
  const tmp = await folderSize(host, '/tmp')
  if (tmp !== undefined) section.measures.push({ label: '/tmp', bytes: tmp })
  if (host.windows) {
    const timers = await host.run('systemctl', ['list-timers', '--all', '--no-legend'])
    const trims = scheduledTimers(timers.stdout).filter((unit) => /trim|prune/.test(unit))
    section.measures.push({ label: 'scheduled trim or prune', detail: trims.length > 0 ? trims.join(', ') : 'none' })
    // fstrim.timer is enabled on Ubuntu, and never scheduled under WSL.
    if (trims.length === 0) section.hints.push('No timer trims the disk, so space freed in Linux never reaches C:, a weekly docker-prune.timer running fstrim -av gives it back.')
  }
  return section
}

const PRUNES: Record<string, string> = {
  Images: 'docker image prune -a --filter until=168h -f',
  'Local Volumes': 'docker volume prune -f',
  'Build Cache': 'docker builder prune -f',
}

async function docker(host: Host, native: boolean): Promise<Section | undefined> {
  const result = await host.run('docker', ['system', 'df', '--format', 'json'])
  if (result.code === NOT_FOUND || result.code !== 0) return undefined
  const section: Section = { title: 'Docker', measures: [], hints: [], guide: 'weekly-prune-and-trim' }
  for (const usage of parseDockerDf(result.stdout)) {
    section.measures.push({ label: usage.type, bytes: usage.size, detail: `${formatBytes(usage.reclaimable)} reclaimable, ${usage.active} of ${usage.total} in use` })
    if (usage.reclaimable > WORTH && PRUNES[usage.type]) section.hints.push(`${formatBytes(usage.reclaimable)} of ${usage.type.toLowerCase()} are unused, and removed with:`, `  ${PRUNES[usage.type]}`)
  }
  // Docker Desktop keeps the settings of its engine in the profile of the user.
  const daemonFile = native ? join(host.home, '.docker', 'daemon.json') : '/etc/docker/daemon.json'
  const daemon = await readFile(daemonFile, 'utf8').catch(() => '{}')
  let cap: string | undefined
  try {
    cap = (JSON.parse(daemon) as { builder?: { gc?: { enabled?: boolean; defaultMaxUsedSpace?: string } } }).builder?.gc?.defaultMaxUsedSpace
  } catch {
    cap = undefined
  }
  section.measures.push({ label: 'build cache cap', detail: cap ?? 'none' })
  if (!cap) section.hints.push(`Docker collects no build cache below 750 GiB, and this setting in ${daemonFile} caps it:`, '  {"builder": {"gc": {"enabled": true, "defaultMaxUsedSpace": "30GB"}}}')
  return section
}

async function journal(host: Host): Promise<Section | undefined> {
  const result = await host.run('journalctl', ['--disk-usage'])
  const size = /take up ([\d.]+[KMGT]?)/.exec(result.stdout)?.[1]
  const bytes = size ? parseSize(size, 1024) : undefined
  if (bytes === undefined) return undefined
  return {
    title: 'Journal',
    guide: 'journal',
    measures: [{ label: 'systemd journal', bytes }],
    hints: bytes > GB ? ['sudo journalctl --vacuum-size=500M keeps the last 500 MB of logs'] : [],
  }
}

// Lines of snap list --all are Name Version Rev Tracking Publisher Notes, the notes saying disabled for a revision kept for a rollback.
export function disabledSnaps(output: string): { name: string; revision: string }[] {
  return output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((tokens) => tokens.length >= 6 && tokens.at(-1)?.split(',').includes('disabled'))
    .map((tokens) => ({ name: tokens[0], revision: tokens[2] }))
}

async function snaps(host: Host): Promise<Section | undefined> {
  const result = await host.run('snap', ['list', '--all'])
  if (result.code !== 0) return undefined
  const disabled = disabledSnaps(result.stdout)
  return {
    title: 'Snap',
    guide: 'snap-revisions',
    measures: [{ label: 'disabled revisions', detail: disabled.length > 0 ? disabled.map((snap) => `${snap.name} ${snap.revision}`).join(', ') : 'none' }],
    hints:
      disabled.length > 0
        ? ['Disabled revisions are kept for a rollback, and removed one by one:', ...disabled.map((snap) => `  sudo snap remove ${snap.name} --revision=${snap.revision}`)]
        : [],
  }
}

interface Cache {
  path: string
  // The command that clears the cache, when one command does.
  command?: string
  // What clearing it costs, or what to clear when no command does.
  note?: string
}

const CACHES: Cache[] = [
  { path: '~/.npm', command: 'npm cache clean --force' },
  { path: '~/.nuget/packages', command: 'dotnet nuget locals all --clear' },
  { path: '~/.local/share/pnpm/store', command: 'pnpm store prune' },
  { path: '~/.cache/JetBrains', command: 'rm -rf ~/.cache/JetBrains', note: 'the IDE backends and indexes are rebuilt on demand' },
  { path: '~/.cache/ms-playwright', command: 'npx playwright uninstall --all', note: 'the browsers the projects use are installed again after it' },
  { path: '~/.vscode-server', note: 'the old versions under ~/.vscode-server/bin and the extensions removed from VS Code can go' },
  { path: '~/.cache', note: 'its largest folders are each rebuilt by their tool' },
]

// The same tools on Windows, which keep most of their caches under %LOCALAPPDATA%.
const WINDOWS_CACHES: Cache[] = [
  { path: String.raw`%LOCALAPPDATA%\npm-cache`, command: 'npm cache clean --force' },
  { path: String.raw`%USERPROFILE%\.nuget\packages`, command: 'dotnet nuget locals all --clear' },
  { path: String.raw`%LOCALAPPDATA%\pnpm\store`, command: 'pnpm store prune' },
  { path: String.raw`%LOCALAPPDATA%\ms-playwright`, command: 'npx playwright uninstall --all', note: 'the browsers the projects use are installed again after it' },
  { path: String.raw`%LOCALAPPDATA%\Temp`, note: 'and Storage Sense or Disk Cleanup removes the temporary files no program uses' },
]

function cacheHints(cache: Cache, bytes: number, prompt = ''): string[] {
  if (bytes <= WORTH) return []
  const note = cache.note ? `, ${cache.note}` : ''
  const end = cache.command ? `${prompt}:` : '.'
  const hint = `${cache.path} holds ${formatBytes(bytes)}${note}${end}`
  return cache.command ? [hint, `  ${cache.command}`] : [hint]
}

// ~/.cache gathers the caches of every tool, and only its largest folders say which one to clear.
async function largestCaches(host: Host): Promise<Measure[]> {
  const cache = join(host.home, '.cache')
  const children: Measure[] = []
  for (const entry of await readdir(cache, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const bytes = await folderSize(host, join(cache, entry.name))
    if (bytes !== undefined && bytes > GB / 10) children.push({ label: `~/.cache/${entry.name}`, bytes })
  }
  return children
    .toSorted((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    .slice(0, 5)
    .filter((child) => !CACHES.some((known) => known.path === child.label))
}

async function caches(host: Host): Promise<Section> {
  const section: Section = { title: 'Caches', measures: [], hints: [], guide: 'caches' }
  for (const cache of CACHES) {
    const bytes = await folderSize(host, expandHome(cache.path, host.home))
    if (bytes === undefined) continue
    section.measures.push({ label: cache.path, bytes })
    section.hints.push(...cacheHints(cache, bytes))
  }
  section.measures.push(...(await largestCaches(host)))
  return section
}

async function windowsCaches(host: Host, windows: Windows): Promise<Section> {
  const section: Section = { title: 'Caches', measures: [], hints: [], guide: 'caches' }
  for (const cache of WINDOWS_CACHES) {
    const path = await windows.expand(cache.path).catch(() => undefined)
    const bytes = path && (await windowsFolderSize(host, windows, path))
    if (!bytes) continue
    section.measures.push({ label: cache.path, bytes })
    // In a terminal of WSL, the same command clears the cache of Linux.
    section.hints.push(...cacheHints(cache, bytes, ', cleared from a Windows prompt with'))
  }
  return section
}

interface Sessions {
  count: number
  old: number
  oldBytes: number
}

async function countSessions(folder: string, before: number): Promise<Sessions> {
  const sessions: Sessions = { count: 0, old: 0, oldBytes: 0 }
  for (const project of await readdir(folder, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const file of await readdir(join(folder, project.name)).catch(() => [])) {
      if (!file.endsWith('.jsonl')) continue
      const info = await stat(join(folder, project.name, file)).catch(() => undefined)
      if (!info) continue
      sessions.count++
      if (info.mtimeMs < before) {
        sessions.old++
        sessions.oldBytes += info.size
      }
    }
  }
  return sessions
}

// Transcripts of Claude Code sessions, kept for cleanupPeriodDays, 30 by default.
async function sessionsSection(folder: string, home: string, bytes: number | undefined): Promise<Section> {
  const { count, old, oldBytes } = await countSessions(folder, Date.now() - 30 * 24 * 3600 * 1000)
  const separator = home === '~' ? '/' : '\\'
  const section: Section = {
    title: 'Agent sessions',
    guide: 'agent-sessions',
    measures: [{ label: [home, '.claude', 'projects'].join(separator), bytes, detail: `${count} session(s), ${old} older than 30 days` }],
    hints: [],
  }
  const settings = [home, '.claude', 'settings.json'].join(separator)
  if (oldBytes > GB) section.hints.push(`${formatBytes(oldBytes)} of sessions are older than 30 days, cleanupPeriodDays in ${settings} sets how long Claude Code keeps them.`)
  return section
}

async function agentSessions(host: Host): Promise<Section | undefined> {
  const folder = join(host.home, '.claude', 'projects')
  return existsSync(folder) ? sessionsSection(folder, '~', await folderSize(host, folder)) : undefined
}

async function windowsAgentSessions(host: Host, windows: Windows): Promise<Section | undefined> {
  const profile = await windows.env('USERPROFILE')
  if (!profile) return undefined
  const path = String.raw`${profile}\.claude\projects`
  if (!(await windowsFolderExists(windows, path))) return undefined
  return sessionsSection(await windows.linuxPath(path), '%USERPROFILE%', await windowsFolderSize(host, windows, path))
}

async function repositories(config: Config | undefined, host: Host, system: System): Promise<Section | undefined> {
  const sizes: Measure[] = []
  let found = false
  for (const root of config?.[system.kind]?.repos ?? []) {
    // A folder that cannot be resolved stays out of the report, and the others are measured.
    const resolved = await resolveRoot(system, root, host).catch(() => undefined)
    if (!resolved) continue
    found = true
    if (!existsSync(resolved.folder)) continue
    const { separator, path } = resolved
    for (const relative of await findRepositories(resolved.folder)) {
      const full = [trimTrailing(path, separator), ...relative].join(separator)
      const bytes = system.kind === 'windows' ? await windowsFolderSize(host, host.windows!, full) : await folderSize(host, full)
      if (bytes !== undefined) sizes.push({ label: [trimTrailing(root, separator), ...relative].join(separator), bytes })
    }
  }
  if (!found) return undefined
  sizes.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  const total = sizes.reduce((sum, measure) => sum + (measure.bytes ?? 0), 0)
  return {
    title: 'Repositories',
    measures: [{ label: `${sizes.length} repositories`, bytes: total }, ...sizes.slice(0, 10)],
    hints: [],
  }
}

// A scan takes minutes, so the report reads the last one chade scan saved rather than scanning.
const SCAN_STALE_DAYS = 7
const UNUSED_SHOWN = 3

export function security(scanned: Scan | undefined, now = Date.now()): Section {
  const section: Section = { title: 'Security', measures: [], hints: [], guide: 'packages-and-images' }
  if (!scanned) {
    section.measures.push({ label: 'last scan', detail: 'never' })
    section.hints.push('chade scan reads the packages and the images on the disk, for vulnerabilities, malicious packages and what nothing uses.')
    return section
  }
  const counts = countsOf(scanned)
  const levels = SEVERITIES.filter((level) => counts.severities[level] > 0).map((level) => `${counts.severities[level]} ${level}`)
  section.measures.push(
    { label: 'last scan', detail: scanned.date.slice(0, 16).replace('T', ' ') },
    { label: 'malicious packages', detail: String(counts.malicious) },
    { label: 'vulnerabilities', detail: levels.length > 0 ? levels.join(', ') : 'none known' },
    { label: `${counts.unused} unused`, bytes: counts.unusedBytes },
  )
  if (counts.malicious > 0) section.hints.push(`${counts.malicious} malicious package(s) are on the disk, and may have run at their install: chade scan says where, and they are removed rather than updated.`)
  const days = Math.floor((now - Date.parse(scanned.date)) / (24 * 3600 * 1000))
  if (days >= SCAN_STALE_DAYS) section.hints.push(`The last scan is ${days} days old, and chade scan reads the disk again.`)
  const unused = scanned.places.filter((place) => place.unused && (place.bytes ?? 0) > GB / 10).toSorted((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  if (unused.length > 0) {
    section.hints.push(`${formatBytes(counts.unusedBytes)} of folders and images nothing uses, the largest removed with:`)
    // Several places clear with the same command, given once.
    const commands = [...new Set(unused.map((place) => place.unused?.command ?? ''))]
    section.hints.push(...commands.slice(0, UNUSED_SHOWN).map((command) => `  ${command}`))
  }
  return section
}

// ── Rendering ──────────────────────────────────────────────────────────────

export function renderReport(value: Report): string {
  const lines = [`${value.machine}, ${value.date.slice(0, 16).replace('T', ' ')} UTC`]
  const several = new Set(value.sections.map((section) => section.system)).size > 1
  let system: string | undefined
  for (const section of value.sections) {
    if (several && section.system && section.system !== system) lines.push('', `=== ${section.system} ===`)
    system = section.system
    lines.push(...sectionLines(section))
  }
  return lines.join('\n')
}

function sectionLines(section: Section): string[] {
  const lines = ['', section.title]
  const width = Math.max(...section.measures.map((measure) => measure.label.length), 0)
  for (const measure of section.measures) {
    const parts = [measure.bytes !== undefined ? formatBytes(measure.bytes) : undefined, measure.detail].filter(Boolean)
    lines.push(`  ${measure.label.padEnd(width)}  ${parts.join(', ')}`)
  }
  for (const hint of section.hints) lines.push(hint.startsWith('  ') ? `    ${hint.trimStart()}` : `  → ${hint}`)
  if (section.hints.length > 0 && section.guide) lines.push(`    ${docsPointer('cleanup', section.guide)}`)
  return lines
}
