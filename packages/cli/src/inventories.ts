import { existsSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { NOT_FOUND, type Result, type Run } from './exec.js'
import { expandHome } from './paths.js'
import { redactUrl } from './redact.js'
import type { Windows } from './windows.js'

export type Kind = 'linux' | 'windows'

export interface Context {
  run: Run
  home: string
  windows?: Windows
  repos: string[]
  warn: (message: string) => void
}

export interface Inventory {
  name: string
  file: string
  collect: (context: Context) => Promise<string>
}

// A tool that is not installed skips its inventory, where a tool that fails is a warning.
export class Unavailable extends Error {}

function output(result: Result, command: string): string {
  if (result.code === NOT_FOUND) throw new Unavailable(`${command} is not installed`)
  if (result.code !== 0) throw new Error(`${command} exited with ${result.code}: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

function windowsOf(context: Context): Windows {
  if (!context.windows) throw new Unavailable('Windows is not reachable from this system')
  return context.windows
}

const linux: Inventory[] = [
  {
    name: 'apt-manual',
    file: 'apt-manual.txt',
    collect: async ({ run }) => output(await run('apt-mark', ['showmanual']), 'apt-mark'),
  },
  {
    name: 'snap',
    file: 'snap.txt',
    collect: async ({ run }) => output(await run('snap', ['list']), 'snap'),
  },
  {
    name: 'vscode-extensions',
    file: 'vscode-extensions.txt',
    collect: async ({ run }) => output(await run('code', ['--list-extensions', '--show-versions']), 'code'),
  },
  {
    name: 'npm-global',
    file: 'npm-global.txt',
    collect: async ({ run }) => npmGlobal(output(await run('npm', ['ls', '--global', '--depth=0', '--json']), 'npm')),
  },
  {
    name: 'dotnet-tools',
    file: 'dotnet-tools.txt',
    collect: async ({ run }) => output(await run('dotnet', ['tool', 'list', '--global']), 'dotnet'),
  },
  {
    name: 'git-config',
    file: 'git-config.txt',
    collect: async ({ run }) => gitConfig(await run('git', ['config', '--global', '--list']), 'git'),
  },
  {
    name: 'crontab',
    file: 'crontab.txt',
    collect: async ({ run }) => {
      const result = await run('crontab', ['-l'])
      // crontab exits with 1 and "no crontab for <user>" when the user has none, which is an empty inventory.
      if (result.code === 1 && /no crontab/i.test(result.stderr)) return ''
      return output(result, 'crontab')
    },
  },
  {
    name: 'systemd-services',
    file: 'systemd-services.txt',
    collect: async ({ run }) => systemdUnits(output(await run('systemctl', ['list-unit-files', '--state=enabled', '--no-pager', '--no-legend']), 'systemctl')),
  },
  {
    name: 'systemd-user-services',
    file: 'systemd-user-services.txt',
    collect: async ({ run }) =>
      systemdUnits(output(await run('systemctl', ['--user', 'list-unit-files', '--state=enabled', '--no-pager', '--no-legend']), 'systemctl --user')),
  },
]

const windows: Inventory[] = [
  {
    name: 'winget',
    file: 'winget.json',
    collect: (context) => winget(context),
  },
  {
    name: 'vscode-extensions',
    file: 'vscode-extensions.txt',
    collect: async (context) => output(await windowsOf(context).exec(['code', '--list-extensions', '--show-versions']), 'code'),
  },
  {
    name: 'wsl-distros',
    file: 'wsl-distros.txt',
    // wsl.exe writes UTF-16 whatever the console code page.
    collect: async ({ run }) => output(await run('wsl.exe', ['--list', '--quiet'], { encoding: 'utf16le' }), 'wsl.exe'),
  },
  {
    name: 'git-config',
    file: 'git-config.txt',
    collect: async (context) => gitConfig(await windowsOf(context).exec(['git', 'config', '--global', '--list']), 'git'),
  },
  {
    name: 'scheduled-tasks',
    file: 'scheduled-tasks.txt',
    collect: async (context) => scheduledTasks(output(await windowsOf(context).exec(['schtasks', '/query', '/fo', 'csv', '/nh']), 'schtasks')),
  },
]

export const INVENTORIES: Record<Kind, Inventory[]> = { linux, windows }

// Runs whenever the configuration lists repository folders, so it is never a name to add to the inventories as well.
export function gitReposInventory(kind: Kind): Inventory {
  return { name: 'git-repos', file: 'git-repos.txt', collect: (context) => gitRepos(context, kind) }
}

export function customInventory(kind: Kind, name: string, command: string): Inventory {
  return {
    name,
    file: `${name}.txt`,
    collect: async (context) =>
      output(kind === 'linux' ? await context.run('sh', ['-c', command]) : await windowsOf(context).exec([command]), command),
  }
}

export function npmGlobal(json: string): string {
  const dependencies = (JSON.parse(json) as { dependencies?: Record<string, { version?: string }> }).dependencies ?? {}
  return Object.entries(dependencies)
    .map(([name, { version }]) => `${name}@${version ?? ''}`)
    .sort()
    .join('\n')
}

function gitConfig(result: Result, command: string): string {
  // git config exits with 1 when the global file does not exist, which is an empty inventory.
  if (result.code === 1 && result.stdout === '') return ''
  return output(result, command)
}

// Mounts and sockets come and go with snap refreshes and sessions, where services and timers are what someone enables.
export function systemdUnits(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((unit) => /\.(service|timer)$/.test(unit))
    .sort()
    .join('\n')
}

// The tasks Windows ships live under \Microsoft\, and the next run time changes on every call, so only the names of the others are kept.
export function scheduledTasks(csv: string): string {
  const names = csv
    .split(/\r?\n/)
    .map((line) => /^"([^"]*)"/.exec(line)?.[1])
    .filter((name): name is string => !!name && !name.startsWith('\\Microsoft\\'))
  return [...new Set(names)].sort().join('\n')
}

interface WingetExport {
  CreationDate?: string
  Sources?: { SourceDetails?: { Name?: string }; Packages?: { PackageIdentifier?: string }[] }[]
}

// The export date and the package order change on every run, which would make every snapshot a change.
export function normalizeWinget(json: string): string {
  const data = JSON.parse(json) as WingetExport
  delete data.CreationDate
  for (const source of data.Sources ?? []) {
    source.Packages?.sort((a, b) => (a.PackageIdentifier ?? '').localeCompare(b.PackageIdentifier ?? ''))
  }
  data.Sources?.sort((a, b) => (a.SourceDetails?.Name ?? '').localeCompare(b.SourceDetails?.Name ?? ''))
  return JSON.stringify(data, null, 2)
}

async function winget(context: Context): Promise<string> {
  const windows = windowsOf(context)
  const temp = await windows.env('TEMP')
  if (!temp) throw new Error('the Windows TEMP variable is not defined')
  // winget.exe is a Windows program, so the export file has to be on the Windows side, then read through its WSL path.
  const exportPath = `${temp}\\chade-winget-${process.pid}.json`
  const result = await context.run('winget.exe', ['export', '--output', exportPath, '--accept-source-agreements', '--disable-interactivity'], {
    cwd: windows.cwd(),
  })
  if (result.code === NOT_FOUND) throw new Unavailable('winget.exe is not installed')
  const file = await windows.linuxPath(exportPath)
  try {
    if (!existsSync(file)) throw new Error(`winget export exited with ${result.code} without writing ${exportPath}: ${result.stdout.trim()}`)
    return normalizeWinget(await readFile(file, 'utf8'))
  } finally {
    await rm(file, { force: true })
  }
}

const SKIPPED_FOLDERS = new Set(['node_modules', 'bin', 'obj', 'dist'])
const REPOSITORY_DEPTH = 3

async function gitRepos(context: Context, kind: Kind): Promise<string> {
  const lines: string[] = []
  for (const root of context.repos) {
    const folder = kind === 'linux' ? expandHome(root, context.home) : await windowsOf(context).linuxPath(await windowsOf(context).expand(root))
    if (!existsSync(folder)) {
      context.warn(`repository folder ${root} does not exist`)
      continue
    }
    const separator = kind === 'linux' ? '/' : '\\'
    for (const relative of await findRepositories(folder, [], REPOSITORY_DEPTH)) {
      const display = [root.replace(/[\\/]+$/, ''), ...relative].join(separator)
      const remotes = await context.run('git', ['-C', join(folder, ...relative), 'remote', '-v'])
      const fetches = remotes.stdout
        .split('\n')
        .map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim()))
        .filter((match): match is RegExpExecArray => match !== null)
      if (fetches.length === 0) lines.push(`${display}\t-`)
      for (const [, name, url] of fetches) lines.push(`${display}\t${name}\t${redactUrl(url)}`)
    }
  }
  return lines.join('\n')
}

async function findRepositories(folder: string, relative: string[], depth: number): Promise<string[][]> {
  const entries = await readdir(join(folder, ...relative), { withFileTypes: true }).catch(() => [])
  if (entries.some((entry) => entry.name === '.git')) return [relative]
  if (depth === 0) return []
  const found: string[][] = []
  const children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_FOLDERS.has(entry.name))
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    found.push(...(await findRepositories(folder, [...relative, child.name], depth - 1)))
  }
  return found
}
