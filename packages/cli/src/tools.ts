import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import { NOT_FOUND } from './exec.js'
import type { Side } from './places.js'
import { isNativeWindows, type Host } from './system.js'

// The scanners chade runs, each one a layer: what one misses, another may find, and a missing one only takes its layer away.
export const SCANNERS = ['osv-scanner', 'trivy', 'grype'] as const

export type Scanner = (typeof SCANNERS)[number]

// The folder winget installs each one in, under %LOCALAPPDATA%\Microsoft\WinGet\Packages.
const WINGET: Record<Scanner, string> = { 'osv-scanner': 'Google.OSVScanner_', trivy: 'AquaSecurity.Trivy_', grype: 'Anchore.Grype_' }

export interface Tool {
  name: Scanner
  command: string
  version: string
  cwd?: string
  // Where the files given to the tool are written, as this process reads the folder and as the system of the tool writes it.
  temp: { local: string; system: string }
}

// The first version number a --version prints, each tool printing it its own way.
export function versionOf(output: string): string {
  return /\d+\.\d+\.\d+/.exec(output)?.[0] ?? 'unknown'
}

// The tool of the system, on the PATH or where winget put it, whose links a WSL started before the install does not see.
export async function findTool(host: Host, side: Side, name: Scanner): Promise<Tool | undefined> {
  const versionArgs = name === 'grype' ? ['version'] : ['--version']
  if (!side.windows) {
    const found = await host.run(name, versionArgs)
    if (found.code === NOT_FOUND) return undefined
    return { name, command: name, version: versionOf(found.stdout), temp: { local: tmpdir(), system: tmpdir() } }
  }
  const windows = host.windows
  if (!windows) return undefined
  const native = isNativeWindows(host)
  const where = await windows.exec(['where', name])
  let path = where.code === 0 ? where.stdout.split(/\r?\n/)[0].trim() : undefined
  const localAppData = await windows.env('LOCALAPPDATA')
  if (!path && localAppData) {
    const packages = win32.join(localAppData, 'Microsoft', 'WinGet', 'Packages')
    const folder = (await readdir(await windows.linuxPath(packages).catch(() => '')).catch(() => [])).find((entry) => entry.startsWith(WINGET[name]))
    if (folder) path = win32.join(packages, folder, `${name}.exe`)
  }
  const temp = await windows.env('TEMP')
  if (!path || !temp) return undefined
  const command = native ? path : await windows.linuxPath(path)
  const version = await host.run(command, versionArgs, { cwd: windows.cwd() })
  if (version.code === NOT_FOUND) return undefined
  return { name, command, version: versionOf(version.stdout), cwd: windows.cwd(), temp: { local: native ? temp : await windows.linuxPath(temp), system: temp } }
}
