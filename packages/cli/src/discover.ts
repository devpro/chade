import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import { expandHome } from './paths.js'
import type { Host, System } from './system.js'

// Files a person creates or edits, which no package owns, so dpkg --verify never reports them.
export const LINUX_CANDIDATES = [
  '/etc/wsl.conf',
  '/etc/docker/daemon.json',
  '/etc/environment',
  '/etc/hosts',
  '/etc/fstab',
  '/etc/apt/sources.list.d',
  '/etc/cron.d',
  '~/.bashrc',
  '~/.bash_aliases',
  '~/.profile',
  '~/.zshrc',
  '~/.gitconfig',
  '~/.ssh/config',
  '~/.npmrc',
  '~/.docker/config.json',
  '~/.config/gh/config.yml',
  '~/.vscode-server/data/Machine/settings.json',
]

export const WINDOWS_CANDIDATES = [
  '%USERPROFILE%\\.wslconfig',
  '%USERPROFILE%\\.gitconfig',
  '%USERPROFILE%\\.ssh\\config',
  '%APPDATA%\\Code\\User\\settings.json',
  '%APPDATA%\\Code\\User\\keybindings.json',
  '%LOCALAPPDATA%\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json',
  '%USERPROFILE%\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1',
]

export interface Discovery {
  system: System
  files: string[]
}

// Lines of dpkg --verify are a status like "??5??????", a "c" for a configuration file, then the path, and the 5 says its checksum changed.
export function changedConffiles(output: string): string[] {
  return output
    .split('\n')
    .map((line) => /^(\S{9})\s+c\s+(\/.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null && match[1][2] === '5')
    .map((match) => match[2])
}

export async function discover(config: Config, host: Host): Promise<Discovery[]> {
  const discoveries: Discovery[] = []
  for (const system of host.systems) {
    const configured = config[system.kind]?.files ?? []
    const files = system.kind === 'linux' ? await discoverLinux(configured, host) : await discoverWindows(configured, host)
    discoveries.push({ system, files })
  }
  return discoveries
}

async function discoverLinux(configured: string[], host: Host): Promise<string[]> {
  const verified = await host.run('dpkg', ['--verify'])
  const candidates = [...new Set([...LINUX_CANDIDATES, ...changedConffiles(verified.stdout)])]
  const taken = configured.map((file) => expandHome(file, host.home))
  const found: string[] = []
  for (const candidate of candidates) {
    const path = expandHome(candidate, host.home)
    if (isCovered(path, taken, '/') || !(await hasReadableFile(path))) continue
    found.push(candidate)
  }
  return found
}

async function discoverWindows(configured: string[], host: Host): Promise<string[]> {
  const windows = host.windows
  if (!windows) return []
  const taken: string[] = []
  for (const file of configured) taken.push((await windows.expand(file).catch(() => file)).toLowerCase())
  const found: string[] = []
  for (const candidate of WINDOWS_CANDIDATES) {
    const expanded = await windows.expand(candidate).catch(() => undefined)
    if (!expanded || isCovered(expanded.toLowerCase(), taken, '\\')) continue
    if (await hasReadableFile(await windows.linuxPath(expanded))) found.push(candidate)
  }
  return found
}

function isCovered(path: string, taken: string[], separator: string): boolean {
  return taken.some((file) => path === file || path.startsWith(file.endsWith(separator) ? file : file + separator))
}

// A folder counts when it holds at least one file, since an empty one has nothing to snapshot.
async function hasReadableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    if (!(await stat(path)).isDirectory()) return true
    const entries = await readdir(path, { withFileTypes: true })
    return entries.some((entry) => entry.isFile()) || (await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => hasReadableFile(join(path, e.name))))).some(Boolean)
  } catch {
    return false
  }
}
