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

export async function detectHost(options: { machine?: string; run?: Run; env?: NodeJS.ProcessEnv } = {}): Promise<Host> {
  if (process.platform !== 'linux') throw new Error('chade runs on Linux, and on WSL for the Windows host')
  const run = options.run ?? defaultRun
  const env = options.env ?? process.env
  const home = env.HOME ?? homedir()
  if (!isWsl(env)) {
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
