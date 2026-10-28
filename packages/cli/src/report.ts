import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import { NOT_FOUND } from './exec.js'
import { findRepositories } from './inventories.js'
import { expandHome } from './paths.js'
import type { Host } from './system.js'

export interface Measure {
  label: string
  bytes?: number
  detail?: string
}

export interface Section {
  title: string
  measures: Measure[]
  // What to do about a measure, each the command or setting the machine documentation gives.
  hints: string[]
  // Section of docs/cleanup.md that explains the hints.
  guide?: string
}

export interface Report {
  machine: string
  date: string
  sections: Section[]
}

export const GUIDE = 'https://github.com/devpro/chade/blob/main/docs/cleanup.md'

const GB = 1e9

// A size the cleanup is worth running for, below which a hint would be noise.
const WORTH = 5 * GB

export async function report(config: Config | undefined, host: Host): Promise<Report> {
  const sections: Section[] = []
  const add = (section: Section | undefined) => {
    if (section && (section.measures.length > 0 || section.hints.length > 0)) sections.push(section)
  }
  const linuxRoot = await diskUsage(host, '/')
  if (host.windows) {
    add(await windowsDisk(host, linuxRoot))
    add(await wslConfig(host))
  }
  add(await memory(host))
  add(await linuxDisk(host, linuxRoot))
  add(await docker(host))
  add(await journal(host))
  add(await snaps(host))
  add(await caches(host))
  add(await agentSessions(host))
  add(await repositories(config, host))
  return { machine: host.machine, date: new Date().toISOString(), sections }
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
    if (/^HKEY_/.test(line)) current = {}
    const value = /^\s+(DistributionName|BasePath)\s+REG_\w+\s+(.+)$/.exec(line)
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
    const line = raw.replace(/[#;].*$/, '').trim()
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
    .map((tokens) => tokens[tokens.length - 2])
}

export function topProcesses(psOutput: string, count: number): Measure[] {
  const totals = new Map<string, number>()
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match) totals.set(match[2].trim(), (totals.get(match[2].trim()) ?? 0) + Number(match[1]) * 1024)
  }
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

async function diskUsage(host: Host, path: string): Promise<Usage | undefined> {
  const result = await host.run('df', ['-B1', '--output=size,used,avail', path])
  const [size, used, available] = (result.stdout.trim().split('\n')[1] ?? '').trim().split(/\s+/).map(Number)
  return result.code === 0 && Number.isFinite(size) ? { size, used, available } : undefined
}

// du exits with 1 for a single unreadable folder, while its total of the rest is still right.
async function folderSize(host: Host, path: string): Promise<number | undefined> {
  if (!existsSync(path)) return undefined
  const result = await host.run('du', ['-sb', path], { timeoutMs: 600_000 })
  const size = Number(result.stdout.trim().split(/\s+/)[0])
  return result.stdout.trim() !== '' && Number.isFinite(size) ? size : undefined
}

function usageDetail(usage: Usage): string {
  return `${formatBytes(usage.used)} used of ${formatBytes(usage.size)}, ${formatBytes(usage.available)} free`
}

async function windowsDisk(host: Host, linuxRoot: Usage | undefined): Promise<Section> {
  const section: Section = { title: 'Windows disk', measures: [], hints: [], guide: 'disk-image-compaction' }
  const drive = await diskUsage(host, '/mnt/c')
  if (drive) section.measures.push({ label: 'C:', detail: usageDetail(drive) })
  const windows = host.windows!
  const lxss = await windows.exec(['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss', '/s'])
  const current = process.env.WSL_DISTRO_NAME
  for (const distribution of parseLxss(lxss.stdout)) {
    const image = `${distribution.basePath}\\ext4.vhdx`
    const info = await stat(await windows.linuxPath(image)).catch(() => undefined)
    if (!info) continue
    section.measures.push({ label: `${distribution.name} disk image`, bytes: info.size, detail: image })
    if (distribution.name === current && linuxRoot && info.size - linuxRoot.used > WORTH) {
      section.hints.push(
        `${distribution.name} uses ${formatBytes(linuxRoot.used)} of an image of ${formatBytes(info.size)} on C:, so ${formatBytes(info.size - linuxRoot.used)} come back once trimmed and compacted:`,
        '  sudo fstrim -av',
        '  then from an administrator prompt on Windows: wsl --shutdown, diskpart,',
        `  select vdisk file="${image}", attach vdisk readonly, compact vdisk, detach vdisk, exit`,
      )
    }
  }
  return section
}

async function wslConfig(host: Host): Promise<Section> {
  const section: Section = { title: 'WSL settings', measures: [], hints: [], guide: 'wsl-memory' }
  const windows = host.windows!
  const profile = await windows.env('USERPROFILE')
  if (!profile) return section
  const file = await windows.linuxPath(`${profile}\\.wslconfig`)
  const values = parseIni(await readFile(file, 'utf8').catch(() => ''))
  for (const key of ['wsl2.memory', 'wsl2.swap', 'experimental.automemoryreclaim']) {
    section.measures.push({ label: key, detail: values[key] ?? 'not set' })
  }
  if (!values['wsl2.memory']) section.hints.push('Without memory in [wsl2] of %USERPROFILE%\\.wslconfig, WSL may take half of the RAM of Windows, a limit applied with wsl --shutdown.')
  if (!values['experimental.automemoryreclaim']) section.hints.push('autoMemoryReclaim=gradual in [experimental] of %USERPROFILE%\\.wslconfig gives the cache memory of Linux back to Windows.')
  return section
}

// Services that hold memory as long as they run, and that a development machine starts for a while and forgets.
const SERVICES = [{ process: 'kubelite', hint: 'MicroK8s is running, sudo microk8s stop frees its memory until the next sudo microk8s start.' }]

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
  const ps = await host.run('ps', ['-eo', 'rss=,comm='])
  for (const process of topProcesses(ps.stdout, 8)) section.measures.push({ ...process, label: `process ${process.label}` })
  for (const service of SERVICES) {
    if (ps.stdout.split('\n').some((line) => line.trim().endsWith(` ${service.process}`))) section.hints.push(service.hint)
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

async function docker(host: Host): Promise<Section | undefined> {
  const result = await host.run('docker', ['system', 'df', '--format', 'json'])
  if (result.code === NOT_FOUND || result.code !== 0) return undefined
  const section: Section = { title: 'Docker', measures: [], hints: [], guide: 'weekly-prune-and-trim' }
  for (const usage of parseDockerDf(result.stdout)) {
    section.measures.push({ label: usage.type, bytes: usage.size, detail: `${formatBytes(usage.reclaimable)} reclaimable, ${usage.active} of ${usage.total} in use` })
    if (usage.reclaimable > WORTH && PRUNES[usage.type]) section.hints.push(`${formatBytes(usage.reclaimable)} of ${usage.type.toLowerCase()} unused: ${PRUNES[usage.type]}`)
  }
  const daemon = await readFile('/etc/docker/daemon.json', 'utf8').catch(() => '{}')
  let cap: string | undefined
  try {
    cap = (JSON.parse(daemon) as { builder?: { gc?: { enabled?: boolean; defaultMaxUsedSpace?: string } } }).builder?.gc?.defaultMaxUsedSpace
  } catch {
    cap = undefined
  }
  section.measures.push({ label: 'build cache cap', detail: cap ?? 'none' })
  if (!cap) section.hints.push('Docker collects no build cache below 750 GiB, {"builder": {"gc": {"enabled": true, "defaultMaxUsedSpace": "30GB"}}} in /etc/docker/daemon.json caps it.')
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
    .filter((tokens) => tokens.length >= 6 && tokens[tokens.length - 1].split(',').includes('disabled'))
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
    hints: disabled.map((snap) => `sudo snap remove ${snap.name} --revision=${snap.revision}`),
  }
}

const CACHES: { path: string; clear: string }[] = [
  { path: '~/.npm', clear: 'npm cache clean --force' },
  { path: '~/.nuget/packages', clear: 'dotnet nuget locals all --clear' },
  { path: '~/.local/share/pnpm/store', clear: 'pnpm store prune' },
  { path: '~/.cache/JetBrains', clear: 'rm -rf ~/.cache/JetBrains, IDE backends and indexes rebuilt on demand' },
  { path: '~/.cache/ms-playwright', clear: 'npx playwright uninstall --all, then an install of the browsers the projects use' },
  { path: '~/.vscode-server', clear: 'old versions under ~/.vscode-server/bin and extensions removed from VS Code' },
  { path: '~/.cache', clear: 'the largest folders of ~/.cache, each rebuilt by its tool' },
]

async function caches(host: Host): Promise<Section> {
  const section: Section = { title: 'Caches', measures: [], hints: [], guide: 'caches' }
  for (const cache of CACHES) {
    const bytes = await folderSize(host, expandHome(cache.path, host.home))
    if (bytes === undefined) continue
    section.measures.push({ label: cache.path, bytes })
    if (bytes > WORTH) section.hints.push(`${cache.path} holds ${formatBytes(bytes)}: ${cache.clear}`)
  }
  // ~/.cache gathers the caches of every tool, and only its largest folders say which one to clear.
  const cache = join(host.home, '.cache')
  const children: Measure[] = []
  for (const entry of await readdir(cache, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue
    const bytes = await folderSize(host, join(cache, entry.name))
    if (bytes !== undefined && bytes > GB / 10) children.push({ label: `~/.cache/${entry.name}`, bytes })
  }
  section.measures.push(...children.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 5).filter((child) => !CACHES.some((known) => known.path === child.label)))
  return section
}

// Transcripts of Claude Code sessions, kept for cleanupPeriodDays, 30 by default.
async function agentSessions(host: Host): Promise<Section | undefined> {
  const folder = join(host.home, '.claude', 'projects')
  if (!existsSync(folder)) return undefined
  const monthAgo = Date.now() - 30 * 24 * 3600 * 1000
  let count = 0
  let old = 0
  let oldBytes = 0
  for (const project of await readdir(folder, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const file of await readdir(join(folder, project.name)).catch(() => [])) {
      if (!file.endsWith('.jsonl')) continue
      const info = await stat(join(folder, project.name, file)).catch(() => undefined)
      if (!info) continue
      count++
      if (info.mtimeMs < monthAgo) {
        old++
        oldBytes += info.size
      }
    }
  }
  const section: Section = {
    title: 'Agent sessions',
    guide: 'agent-sessions',
    measures: [
      { label: '~/.claude/projects', bytes: await folderSize(host, folder), detail: `${count} session(s), ${old} older than 30 days` },
    ],
    hints: [],
  }
  if (oldBytes > GB) section.hints.push(`${formatBytes(oldBytes)} of sessions are older than 30 days, cleanupPeriodDays in ~/.claude/settings.json sets how long Claude Code keeps them.`)
  return section
}

async function repositories(config: Config | undefined, host: Host): Promise<Section | undefined> {
  const roots = config?.linux?.repos ?? []
  if (roots.length === 0) return undefined
  const sizes: Measure[] = []
  for (const root of roots) {
    const folder = expandHome(root, host.home)
    if (!existsSync(folder)) continue
    for (const relative of await findRepositories(folder, [], 3)) {
      const bytes = await folderSize(host, join(folder, ...relative))
      if (bytes !== undefined) sizes.push({ label: [root.replace(/\/+$/, ''), ...relative].join('/'), bytes })
    }
  }
  sizes.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
  const total = sizes.reduce((sum, measure) => sum + (measure.bytes ?? 0), 0)
  return {
    title: 'Repositories',
    measures: [{ label: `${sizes.length} repositories`, bytes: total }, ...sizes.slice(0, 10)],
    hints: [],
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────

export function renderReport(value: Report): string {
  const lines = [`${value.machine}, ${value.date.slice(0, 16).replace('T', ' ')} UTC`]
  for (const section of value.sections) {
    lines.push('', section.title)
    const width = Math.max(...section.measures.map((measure) => measure.label.length), 0)
    for (const measure of section.measures) {
      const parts = [measure.bytes !== undefined ? formatBytes(measure.bytes) : undefined, measure.detail].filter(Boolean)
      lines.push(`  ${measure.label.padEnd(width)}  ${parts.join(', ')}`)
    }
    for (const hint of section.hints) lines.push(hint.startsWith('  ') ? `    ${hint.trimStart()}` : `  → ${hint}`)
    if (section.hints.length > 0 && section.guide) lines.push(`    ${GUIDE}#${section.guide}`)
  }
  return lines.join('\n')
}
