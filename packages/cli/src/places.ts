import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { readRepository, repositoryPath, type Place, type Root } from '@chade/daemon'
import type { Listed } from './osv.js'
import type { System } from './system.js'
import type { Windows } from './windows.js'

// ─── A system as the scan reads it ─────────────────────────────────────────
// The paths of a place are those of its system, which reads them with its own osv-scanner,
// as reading C: through /mnt/c from WSL takes minutes where Windows takes seconds.

export interface Side {
  system: System
  windows: boolean
  // The home folder as the system writes it.
  home: string
  join: (...parts: string[]) => string
  // The path this process reads a path of the system through.
  local: (path: string) => Promise<string>
  env: (name: string) => Promise<string | undefined>
}

export function linuxSide(system: System, home: string, env: NodeJS.ProcessEnv): Side {
  return { system, windows: false, home, join: posix.join, local: (path) => Promise.resolve(path), env: (name) => Promise.resolve(env[name]) }
}

export async function windowsSide(system: System, windows: Windows): Promise<Side | undefined> {
  const home = await windows.env('USERPROFILE')
  if (!home) return undefined
  return { system, windows: true, home, join: win32.join, local: (path) => windows.linuxPath(path), env: (name) => windows.env(name) }
}

// The command that removes a folder, in the shell of its system.
export function removeCommand(side: Pick<Side, 'windows'>, path: string): string {
  if (side.windows) return `rmdir /s /q "${path}"`
  if (/^[\w./~-]+$/.test(path)) return `rm -rf ${path}`
  const quoted = path.replaceAll("'", String.raw`'\''`)
  return `rm -rf '${quoted}'`
}

// The home folder as ~, or %USERPROFILE% on Windows, so that a label reads the same on every machine.
export function labelOf(side: Pick<Side, 'windows' | 'home'>, path: string): string {
  const same = side.windows ? path.toLowerCase().startsWith(side.home.toLowerCase()) : path === side.home || path.startsWith(`${side.home}/`)
  if (!same) return path
  return `${side.windows ? '%USERPROFILE%' : '~'}${path.slice(side.home.length)}`
}

// ─── What is to be read ────────────────────────────────────────────────────

export interface Target {
  place: Place
  // A folder osv-scanner reads, as its system writes it.
  folder?: string
  // Packages that only their folder names tell, handed to osv-scanner as a list.
  list?: Listed[]
}

function target(side: Side, kind: Place['kind'], path: string, read: { folder?: string; list?: Listed[] }, unused?: Place['unused']): Target {
  const place: Place = { system: side.system.id, kind, label: labelOf(side, path), path, packages: 0, findings: [], notes: [], tools: [], ...(unused ? { unused } : {}) }
  return { place, ...read }
}

async function children(local: string): Promise<string[]> {
  return (await readdir(local, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function exists(side: Side, path: string): Promise<boolean> {
  return existsSync(await side.local(path).catch(() => ''))
}

// A folder of name/version folders, as the NuGet cache and the dotnet tools keep their packages.
async function versionFolders(side: Side, path: string, ecosystem: Listed['ecosystem']): Promise<Listed[]> {
  const local = await side.local(path)
  const listed: Listed[] = []
  for (const name of await children(local)) {
    for (const version of await children(posix.join(local, name))) listed.push({ ecosystem, name, version })
  }
  return listed
}

// ─── Node.js under nvm ─────────────────────────────────────────────────────

// The version an alias of nvm names, following an alias to another, lts/* for instance, as far as the files go.
async function nvmAlias(nvm: string, name: string, depth = 3): Promise<string | undefined> {
  const value = (await readFile(posix.join(nvm, 'alias', name), 'utf8').catch(() => '')).trim()
  if (value === '' || depth === 0) return value || undefined
  return /^v?\d/.test(value) ? value : ((await nvmAlias(nvm, value, depth - 1)) ?? value)
}

// The installed version an alias such as 24, v24.1 or v24.22.1 resolves to, the highest that matches.
export function resolveNvm(alias: string | undefined, versions: string[]): string | undefined {
  if (!alias) return undefined
  const wanted = alias.replace(/^v/, '')
  const matching = versions.filter((version) => {
    const plain = version.replace(/^v/, '')
    return plain === wanted || plain.startsWith(`${wanted}.`)
  })
  return matching.toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
}

async function nvmTargets(side: Side, current: string): Promise<Target[]> {
  const nvm = side.join(side.home, '.nvm')
  const versions = await children(side.join(nvm, 'versions', 'node'))
  const kept = new Set([resolveNvm(await nvmAlias(nvm, 'default'), versions), current].filter(Boolean))
  return versions.map((version) => {
    const lib = side.join(nvm, 'versions', 'node', version, 'lib', 'node_modules')
    const unused = kept.has(version) ? undefined : { reason: 'neither the default version of nvm nor the one running', command: `nvm uninstall ${version}` }
    return target(side, 'machine', lib, { folder: lib }, unused)
  })
}

// ─── The places of a system ────────────────────────────────────────────────

type Read = Pick<Target, 'folder' | 'list'>

// Adds a place that exists, once, as two variables can name the same folder.
type Add = (kind: Place['kind'], path: string | undefined, read: (path: string) => Read | Promise<Read>, unused?: Place['unused']) => Promise<void>

const folder = (path: string): Read => ({ folder: path })

async function addWindows(side: Side, add: Add): Promise<void> {
  const { home, join } = side
  const appData = await side.env('APPDATA')
  const localAppData = await side.env('LOCALAPPDATA')
  if (appData) await add('machine', join(appData, 'npm', 'node_modules'), folder)
  // nvm for Windows keeps each version in a folder of its own, vX.Y.Z.
  const nvm = (await side.env('NVM_HOME')) ?? (appData ? join(appData, 'nvm') : undefined)
  if (nvm && (await exists(side, nvm))) {
    for (const version of (await children(await side.local(nvm))).filter((name) => /^v\d/.test(name))) await add('machine', join(nvm, version, 'node_modules'), folder)
  }
  if (localAppData) {
    const npx = join(localAppData, 'npm-cache', '_npx')
    await add('cache', npx, folder, { reason: 'the packages npx fetched, which it fetches again when asked', command: removeCommand(side, npx) })
  }
  await add('machine', join(home, 'pipx', 'venvs'), folder)
  if (appData) await add('cache', join(appData, 'terraform.d', 'plugin-cache'), folder)
}

async function addLinux(side: Side, add: Add): Promise<void> {
  const { home, join } = side
  const prefix = await side.env('NPM_CONFIG_PREFIX')
  for (const lib of [join(home, '.npm-global'), join(home, '.local'), prefix, '/usr/local', '/usr']) {
    if (lib) await add('machine', join(lib, 'lib', 'node_modules'), folder)
  }
  const npx = join(home, '.npm', '_npx')
  await add('cache', npx, folder, { reason: 'the packages npx fetched, which it fetches again when asked', command: removeCommand(side, npx) })
  const pnpmHome = await side.env('PNPM_HOME')
  await add('machine', join(home, '.local', 'share', 'pnpm', 'global'), folder)
  if (pnpmHome) await add('machine', join(pnpmHome, 'global'), folder)
  const pipxHome = await side.env('PIPX_HOME')
  await add('machine', join(home, '.local', 'share', 'pipx', 'venvs'), folder)
  await add('machine', join(home, '.local', 'pipx', 'venvs'), folder)
  if (pipxHome) await add('machine', join(pipxHome, 'venvs'), folder)
  await add('cache', (await side.env('TF_PLUGIN_CACHE_DIR')) ?? join(home, '.terraform.d', 'plugin-cache'), folder)
}

// What tools installed for the whole user, which belongs to no repository, found by looking as IstarCI does, nvm needing a shell to answer.
export async function machineTargets(side: Side, current: string): Promise<Target[]> {
  const { home, join } = side
  const targets: Target[] = []
  const add: Add = async (kind, path, read, unused) => {
    if (path && !targets.some((known) => known.place.path === path) && (await exists(side, path))) targets.push(target(side, kind, path, await read(path), unused))
  }
  const nuget = async (path: string): Promise<Read> => ({ list: await versionFolders(side, path, 'NuGet') })
  if (side.windows) {
    await addWindows(side, add)
  } else {
    targets.push(...(await nvmTargets(side, current)))
    await addLinux(side, add)
  }
  await add('machine', join(home, '.dotnet', 'tools', '.store'), nuget)
  const goPath = await side.env('GOPATH')
  await add('machine', join(goPath ?? join(home, 'go'), 'bin'), folder)
  const gobin = await side.env('GOBIN')
  if (gobin) await add('machine', gobin, folder)
  await add('cache', join(home, '.nuget', 'packages'), nuget, { reason: 'the cache of NuGet, which a restore fills again', command: 'dotnet nuget locals global-packages --clear' })
  return targets
}

// What an install leaves in a working tree, each read for itself, and not the lock files, which are the code.
const INSTALLED = new Set(['node_modules', '.terraform', '.venv'])
const SKIPPED = new Set(['.git', 'bin', 'dist'])
const DEPTH = 4

// The packages of a restored .NET project, which osv-scanner does not read, as `libraries` names them: Name/Version.
export function parseProjectAssets(text: string): Listed[] {
  const assets = JSON.parse(text) as { libraries?: Record<string, { type?: string }> }
  return Object.entries(assets.libraries ?? {})
    .filter(([, library]) => library.type === 'package')
    .map(([key]) => {
      const [name, version] = key.split('/')
      return { ecosystem: 'NuGet' as const, name, version }
    })
}

interface Installed {
  relative: string[]
  kind: 'folder' | 'assets'
  modified: number
}

async function installedIn(local: string, relative: string[] = [], depth = DEPTH): Promise<Installed[]> {
  const found: Installed[] = []
  for (const name of await children(posix.join(local, ...relative))) {
    const path = [...relative, name]
    if (INSTALLED.has(name)) {
      const info = await stat(posix.join(local, ...path)).catch(() => undefined)
      found.push({ relative: path, kind: 'folder', modified: info?.mtimeMs ?? 0 })
    } else if (name === 'obj') {
      const info = await stat(posix.join(local, ...path, 'project.assets.json')).catch(() => undefined)
      if (info) found.push({ relative: [...path, 'project.assets.json'], kind: 'assets', modified: info.mtimeMs })
    } else if (!SKIPPED.has(name) && depth > 1) found.push(...(await installedIn(local, path, depth - 1)))
  }
  return found
}

export interface RepositoryOptions {
  unusedDays: number
  now: number
  run: Parameters<typeof readRepository>[2]
}

const DAY_MS = 24 * 3600 * 1000

// A repository nothing happened in for a while: no commit, nothing changed, and the install itself as old.
export function unusedReason(commitDate: string | undefined, changes: number, modified: number, options: Pick<RepositoryOptions, 'unusedDays' | 'now'>): string | undefined {
  const limit = options.now - options.unusedDays * DAY_MS
  const committed = commitDate ? Date.parse(commitDate) : 0
  if (changes > 0 || committed > limit || modified > limit) return undefined
  const days = Math.floor((options.now - Math.max(committed, modified)) / DAY_MS)
  return `no commit, no change and no install for ${days} days`
}

export async function repositoryTargets(side: Side, root: Root, relatives: string[][], options: RepositoryOptions): Promise<Target[]> {
  const targets: Target[] = []
  for (const relative of relatives) {
    const local = posix.join(root.folder, ...relative)
    const installed = await installedIn(local)
    if (installed.length === 0) continue
    const repository = await readRepository(root, relative, options.run)
    const base = repositoryPath(root, relative)
    for (const found of installed) {
      const path = [base, ...found.relative].join(root.separator)
      if (found.kind === 'assets') {
        const list = await readFile(posix.join(local, ...found.relative), 'utf8').then(parseProjectAssets, () => [])
        targets.push(target(side, 'repository', path, { list }))
        continue
      }
      const reason = repository.error ? undefined : unusedReason(repository.commit?.date, repository.changed + repository.untracked, found.modified, options)
      targets.push(target(side, 'repository', path, { folder: path }, reason ? { reason, command: removeCommand(side, path) } : undefined))
    }
  }
  return targets
}
