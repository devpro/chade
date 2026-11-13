import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Config, SystemConfig } from './config.js'
import { NOT_FOUND } from './exec.js'
import { customInventory, gitReposInventory, INVENTORIES, Unavailable, type Context, type Inventory } from './inventories.js'
import { expandHome, linuxStorePath, windowsStorePath } from './paths.js'
import { redact } from './redact.js'
import { git, requireRepository } from './store.js'
import type { Host, System } from './system.js'

export interface Logger {
  info: (message: string) => void
  warn: (message: string) => void
}

export interface Entry {
  // Path under the system folder, files/... or inventories/...
  path: string
  content: string
}

export interface SnapshotOptions {
  dryRun?: boolean
  push?: boolean
  secretScan?: boolean
}

export interface SnapshotResult {
  commit?: string
  entries: Map<System, Entry[]>
}

export function configuredSystems(config: Config, host: Host): System[] {
  return host.systems.filter((system) => config[system.kind] !== undefined)
}

export async function snapshot(config: Config, host: Host, log: Logger, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const repository = await requireRepository(host.run, config.store)
  const systems = configuredSystems(config, host)
  if (systems.length === 0) throw new Error(`the configuration has no section for ${host.systems.map((system) => system.kind).join(' or ')}`)
  const entries = new Map<System, Entry[]>()
  for (const system of systems) {
    entries.set(system, await collectSystem(system, config[system.kind] as SystemConfig, config, host, log))
  }
  if (options.dryRun) return { entries }

  for (const [system, systemEntries] of entries) {
    const folder = join(config.store, host.machine, system.id)
    // The folder is written from scratch, so a file left out of the configuration disappears from the snapshot too.
    await rm(folder, { recursive: true, force: true })
    for (const entry of systemEntries) {
      const target = join(folder, entry.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.content.endsWith('\n') || entry.content === '' ? entry.content : `${entry.content}\n`)
    }
  }

  // git -C resolves the machine path from the store folder, and the commit takes only that path, whatever else the repository has staged.
  await git(host.run, config.store, ['add', '--all', '--', host.machine])
  const staged = await host.run('git', ['-C', config.store, 'diff', '--cached', '--quiet', '--', host.machine])
  if (staged.code === 0) return { entries }
  if (options.secretScan !== false) await scanSecrets(repository, config, host, log)
  const message = `${host.machine}: snapshot of ${systems.map((system) => system.id).join(', ')}, ${timestamp(new Date())}`
  await git(host.run, config.store, ['commit', '--quiet', '--message', message, '--', host.machine])
  const commit = (await git(host.run, config.store, ['rev-parse', '--short', 'HEAD'])).trim()
  if (options.push) await git(host.run, config.store, ['push', '--quiet'])
  return { commit, entries }
}

async function scanSecrets(repository: string, config: Config, host: Host, log: Logger): Promise<void> {
  const result = await host.run('gitleaks', ['git', '--staged', '--no-banner', '--redact', repository])
  if (result.code === NOT_FOUND) {
    log.warn('gitleaks is not installed, the snapshot is committed without a secret scan')
    return
  }
  if (result.code === 0) return
  await git(host.run, config.store, ['reset', '--quiet', '--', host.machine])
  throw new Error(
    [
      'gitleaks found a secret in the snapshot, nothing was committed.',
      'A redact key in the configuration masks it, or the file comes out of the configuration.',
      (result.stdout + result.stderr).trim(),
    ].join('\n'),
  )
}

async function collectSystem(system: System, systemConfig: SystemConfig, config: Config, host: Host, log: Logger): Promise<Entry[]> {
  const warn = (message: string) => log.warn(`${system.id}: ${message}`)
  const files = await collectFiles(system, systemConfig, config, host, log, warn)
  return [...files, ...(await collectInventories(system, systemConfig, config, host, log, warn))]
}

async function collectFiles(system: System, systemConfig: SystemConfig, config: Config, host: Host, log: Logger, warn: (message: string) => void): Promise<Entry[]> {
  const entries: Entry[] = []
  for (const file of systemConfig.files) {
    try {
      for (const found of await resolveFile(system, file, host)) {
        const content = await readText(found.source)
        if (content === undefined) {
          warn(`${found.display} is binary, it is left out`)
          continue
        }
        const redacted = redact(content, config.redact)
        if (redacted.count > 0) log.info(`${system.id}: ${found.display}, ${redacted.count} line(s) redacted`)
        entries.push({ path: `files/${found.storePath}`, content: redacted.text })
      }
    } catch (error) {
      warn(`${file}: ${describe(error)}`)
    }
  }
  return entries
}

async function collectInventories(system: System, systemConfig: SystemConfig, config: Config, host: Host, log: Logger, warn: (message: string) => void): Promise<Entry[]> {
  const inventories: Inventory[] = systemConfig.inventories.map((entry) =>
    typeof entry === 'string'
      ? (INVENTORIES[system.kind].find((inventory) => inventory.name === entry) as Inventory)
      : customInventory(system.kind, entry.name, entry.command),
  )
  if (systemConfig.repos.length > 0) inventories.push(gitReposInventory(system.kind))
  const context: Context = { run: host.run, home: host.home, windows: host.windows, repos: systemConfig.repos, warn }
  const entries: Entry[] = []
  for (const inventory of inventories) {
    try {
      const content = redact((await inventory.collect(context)).replaceAll('\r', ''), config.redact).text
      entries.push({ path: `inventories/${inventory.file}`, content })
    } catch (error) {
      if (error instanceof Unavailable) log.info(`${system.id}: ${inventory.name} skipped, ${error.message}`)
      else warn(`${inventory.name}: ${describe(error)}`)
    }
  }
  return entries
}

interface FoundFile {
  source: string
  display: string
  storePath: string
}

async function resolveFile(system: System, file: string, host: Host): Promise<FoundFile[]> {
  if (system.kind === 'linux') {
    const source = expandHome(file, host.home)
    return (await walk(source)).map((path) => ({ source: path, display: path, storePath: linuxStorePath(path, host.home) }))
  }
  if (!host.windows) throw new Error('Windows is not reachable from this system')
  const windowsPath = await host.windows.expand(file)
  const root = await host.windows.linuxPath(windowsPath)
  return (await walk(root)).map((path) => {
    const display = windowsPath + path.slice(root.length).replaceAll('/', '\\')
    return { source: path, display, storePath: windowsStorePath(display) }
  })
}

const UNREADABLE: Record<string, string> = { ENOENT: 'does not exist', EACCES: 'is not readable by this user' }

// A folder in the configuration stands for every file under it.
async function walk(path: string): Promise<string[]> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(UNREADABLE[error.code ?? ''] ?? error.message)
  })
  if (!info.isDirectory()) return [path]
  const files: string[] = []
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() || entry.isFile()) files.push(...(await walk(join(path, entry.name))))
  }
  return files
}

async function readText(path: string): Promise<string | undefined> {
  const buffer = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    throw new Error(error.code === 'EACCES' ? `${path} is not readable by this user` : error.message)
  })
  return buffer.includes(0) ? undefined : buffer.toString('utf8')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The local date and minute of a snapshot, which tell the commits of one machine apart in a log of subjects.
export function timestamp(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
