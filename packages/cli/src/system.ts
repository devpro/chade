import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { run as defaultRun, type Run } from './exec.js'
import type { Kind } from './inventories.js'
import { isSegment } from './paths.js'
import { Windows } from './windows.js'

export interface System {
  kind: Kind
  // Folder of the system under the machine folder of the store.
  id: string
}

export interface Host {
  machine: string
  home: string
  systems: System[]
  run: Run
  windows?: Windows
}

// A run from Windows itself, where the Linux tools are missing and commands go through cmd.exe.
export function isNativeWindows(host: Host): boolean {
  return !host.systems.some((system) => system.kind === 'linux')
}

export function isWsl(env: NodeJS.ProcessEnv): boolean {
  if (env.WSL_DISTRO_NAME) return true
  try {
    return /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'))
  } catch {
    return false
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-')
}

export interface DetectOptions {
  machine?: string
  run?: Run
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

// The systems one run captures: Windows alone on Windows, the distribution and its Windows host on WSL, Linux alone otherwise.
export function systemKinds(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Kind[] {
  if (platform === 'win32') return ['windows']
  if (platform !== 'linux') throw new Error('chade runs on Linux, on WSL and on Windows')
  return isWsl(env) ? ['windows', 'linux'] : ['linux']
}

export async function detectHost(options: DetectOptions = {}): Promise<Host> {
  const run = options.run ?? defaultRun
  const env = options.env ?? process.env
  const home = env.HOME ?? homedir()
  const kinds = systemKinds(options.platform, env)
  if (!kinds.includes('linux')) {
    // The computer name is the one WSL gives the same machine, so a run from Windows and a run from WSL share its folder.
    const machine = options.machine ?? env.COMPUTERNAME ?? hostname()
    return { machine: machineName(machine), home, run, windows: new Windows(run, true), systems: [{ kind: 'windows', id: 'windows' }] }
  }
  if (!kinds.includes('windows')) {
    return { machine: machineName(options.machine ?? hostname()), home, run, systems: [{ kind: 'linux', id: 'linux' }] }
  }
  const windows = new Windows(run)
  // The Windows computer name names the physical machine, which a hostname set in wsl.conf would hide.
  const machine = options.machine ?? (await windows.env('COMPUTERNAME')) ?? hostname()
  return {
    machine: machineName(machine),
    home,
    run,
    windows,
    systems: [
      { kind: 'windows', id: 'windows' },
      { kind: 'linux', id: `wsl-${slug(env.WSL_DISTRO_NAME ?? 'linux')}` },
    ],
  }
}

function machineName(name: string): string {
  if (isSegment(name)) return name
  const slugged = slug(name)
  if (!isSegment(slugged)) throw new Error(`the machine name ${name} cannot be a folder name, set machine in the configuration`)
  return slugged
}
