import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// What a running server leaves beside the configuration, for the next command to find it and sign in.
export interface DaemonState {
  pid: number
  address: string
  token: string
  version: string
  startedAt: string
}

export const DEFAULT_PORT = 7843

const START_TIMEOUT_MS = 15_000

export function statePath(configFile: string): string {
  return join(dirname(configFile), 'daemon.json')
}

export function logPath(configFile: string): string {
  return join(dirname(configFile), 'daemon.log')
}

export function signInUrl(state: DaemonState): string {
  return `${state.address}/#token=${state.token}`
}

export async function writeState(configFile: string, state: DaemonState): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true })
  // The token opens the interface, so the file is the user's alone, where the system knows file modes.
  await writeFile(statePath(configFile), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

export async function removeState(configFile: string): Promise<void> {
  await rm(statePath(configFile), { force: true })
}

// The server the state file names, when it answers its token: a file left by a server that was killed names a process that is gone, or another one.
export async function runningDaemon(configFile: string): Promise<DaemonState | undefined> {
  let state: DaemonState
  try {
    state = JSON.parse(await readFile(statePath(configFile), 'utf8')) as DaemonState
  } catch {
    return undefined
  }
  try {
    const response = await fetch(`${state.address}/api/ping`, { headers: { Authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(3000) })
    return response.ok ? state : undefined
  } catch {
    return undefined
  }
}

export async function stopDaemon(configFile: string): Promise<DaemonState | undefined> {
  const state = await runningDaemon(configFile)
  if (state) {
    try {
      process.kill(state.pid)
    } catch {
      // Gone between the answer and the signal.
    }
  }
  // Windows ends a process without letting it clean up.
  await removeState(configFile)
  return state
}

// Starts the server as a process of its own, which outlives this command and its terminal, and waits for it to answer.
export async function startDaemon(configFile: string, port: number): Promise<DaemonState> {
  await mkdir(dirname(configFile), { recursive: true })
  const log = openSync(logPath(configFile), 'w')
  // The same Node.js, flags and script as this command, so a run from the sources starts a server from the sources.
  const args = [...process.execArgv, process.argv[1], '--config', configFile, 'daemon', 'run', '--port', String(port)]
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true })
  let exited = false
  child.once('exit', () => (exited = true))
  child.once('error', () => (exited = true))
  child.unref()
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline && !exited) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const state = await runningDaemon(configFile)
    if (state && state.pid === child.pid) return state
  }
  const output = (await readFile(logPath(configFile), 'utf8').catch(() => '')).trim()
  throw new Error(`the server did not start${output ? `: ${output.replace(/^chade: /, '')}` : `, ${logPath(configFile)} may say why`}`)
}
