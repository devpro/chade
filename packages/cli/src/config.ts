import { isAbsolute, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { STEP_NAMES } from './clean.js'
import { INVENTORIES, type Kind } from './inventories.js'
import { expandHome, isSegment } from './paths.js'

export interface CustomInventory {
  name: string
  command: string
}

export interface CustomStep {
  name: string
  command: string
}

export interface SystemConfig {
  files: string[]
  inventories: (string | CustomInventory)[]
  repos: string[]
}

export interface Config {
  store: string
  machine?: string
  linux?: SystemConfig
  windows?: SystemConfig
  redact: string[]
  cleanup: (string | CustomStep)[]
}

export function configPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.CHADE_CONFIG ?? join(home, '.chade', 'config.yml')
}

export function parseConfig(text: string, home: string): Config {
  const raw: unknown = parse(text) ?? {}
  if (!isObject(raw)) throw new Error('the configuration is not a YAML mapping')
  checkKeys(raw, ['store', 'machine', 'linux', 'windows', 'redact', 'cleanup'], 'the configuration')
  if (typeof raw.store !== 'string' || raw.store === '') throw new Error('store is required, the path of the git repository snapshots are written to')
  const store = expandHome(raw.store, home)
  if (!isAbsolute(store)) throw new Error(`store ${raw.store} is not an absolute path`)
  if (raw.machine !== undefined && (typeof raw.machine !== 'string' || !isSegment(raw.machine))) {
    throw new Error('machine is a folder name made of letters, digits, dots, dashes and underscores')
  }
  const redact = stringList(raw.redact, 'redact')
  for (const key of redact) {
    try {
      new RegExp(key)
    } catch {
      throw new Error(`redact key ${key} is not a valid regular expression`)
    }
  }
  return {
    store: resolve(store),
    machine: raw.machine as string | undefined,
    linux: parseSystem(raw.linux, 'linux'),
    windows: parseSystem(raw.windows, 'windows'),
    redact,
    cleanup: parseCleanup(raw.cleanup),
  }
}

function parseCleanup(raw: unknown): (string | CustomStep)[] {
  const names = new Set<string>()
  return list(raw, 'cleanup').map((entry): string | CustomStep => {
    const name = typeof entry === 'string' ? entry : isObject(entry) ? entry.name : undefined
    if (typeof name !== 'string') throw new Error('cleanup: a custom step is a mapping with a name and a command')
    if (names.has(name)) throw new Error(`cleanup: ${name} is listed twice`)
    names.add(name)
    if (typeof entry === 'string') {
      if (!STEP_NAMES.includes(entry)) throw new Error(`cleanup: ${entry} is not one of ${STEP_NAMES.join(', ')}, and a custom one needs a name and a command`)
      return entry
    }
    const step = entry as Record<string, unknown>
    if (typeof step.command !== 'string' || STEP_NAMES.includes(name)) {
      throw new Error(`cleanup: ${name} must have a command and a name different from the built-in ones`)
    }
    return { name, command: step.command }
  })
}

function parseSystem(raw: unknown, kind: Kind): SystemConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isObject(raw)) throw new Error(`${kind} is a mapping of files, inventories and repos`)
  checkKeys(raw, ['files', 'inventories', 'repos'], kind)
  const files = stringList(raw.files, `${kind}.files`)
  for (const file of files) {
    const valid = kind === 'linux' ? /^[/~]/.test(file) : /^([A-Za-z]:[\\/]|%[^%]+%)/.test(file)
    if (!valid) throw new Error(`${kind}.files: ${file} is not an absolute path`)
  }
  const known = INVENTORIES[kind].map((inventory) => inventory.name)
  const names = new Set<string>()
  const inventories = list(raw.inventories, `${kind}.inventories`).map((entry): string | CustomInventory => {
    if (typeof entry === 'string') {
      if (!known.includes(entry)) throw new Error(`${kind}.inventories: ${entry} is not one of ${known.join(', ')}, and a custom one needs a name and a command`)
      names.add(entry)
      return entry
    }
    if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.command !== 'string') {
      throw new Error(`${kind}.inventories: a custom inventory is a mapping with a name and a command`)
    }
    if (!isSegment(entry.name) || [...known, 'git-repos'].includes(entry.name) || names.has(entry.name)) {
      throw new Error(`${kind}.inventories: ${entry.name} must be a unique file name, different from the built-in ones`)
    }
    names.add(entry.name)
    return { name: entry.name, command: entry.command }
  })
  return { files, inventories, repos: stringList(raw.repos, `${kind}.repos`) }
}

export function initialConfig(store: string, wsl: boolean): string {
  const lines = [
    '# chade configuration, documented at https://github.com/devpro/chade#configuration',
    `store: ${store}`,
    'linux:',
    '  # chade discover suggests the files changed on this system',
    '  files: []',
    `  inventories: [${INVENTORIES.linux.map((inventory) => inventory.name).join(', ')}]`,
    '  repos: []',
  ]
  if (wsl) {
    lines.push(
      'windows:',
      '  files: []',
      `  inventories: [${INVENTORIES.windows.map((inventory) => inventory.name).join(', ')}]`,
      '  repos: []',
    )
  }
  lines.push('redact: []', `# chade clean runs the steps listed here, among ${STEP_NAMES.join(', ')}`, 'cleanup: []', '')
  return lines.join('\n')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkKeys(raw: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new Error(`${where} has an unknown key ${key}, expected one of ${allowed.join(', ')}`)
  }
}

function list(raw: unknown, where: string): unknown[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error(`${where} is a list`)
  return raw
}

function stringList(raw: unknown, where: string): string[] {
  const items = list(raw, where)
  if (items.some((item) => typeof item !== 'string')) throw new Error(`${where} is a list of strings`)
  return items as string[]
}
