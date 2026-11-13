import type { CustomStep } from './config.js'
import type { Run } from './exec.js'
import { disabledSnaps } from './report.js'
import { isNativeWindows, type Host } from './system.js'

export interface Step {
  name: string
  description: string
  // The commands of the step, a list since snap removes one revision per call.
  commands: (host: Host) => Promise<string[][]>
  sudo?: boolean
  // A step for a Linux system, skipped by a run from Windows.
  linux?: boolean
}

const fixed = (...commands: string[][]) => async () => commands

// In the order they run: what frees space first, the trim last, so the space just freed reaches the disk image.
export const STEPS: Step[] = [
  { name: 'docker-images', description: 'Docker images no container uses, older than a week', commands: fixed(['docker', 'image', 'prune', '-a', '--filter', 'until=168h', '-f']) },
  { name: 'docker-volumes', description: 'anonymous Docker volumes no container uses', commands: fixed(['docker', 'volume', 'prune', '-f']) },
  { name: 'docker-build-cache', description: 'Docker build cache no build uses', commands: fixed(['docker', 'builder', 'prune', '-f']) },
  { name: 'npm-cache', description: 'npm cache, downloaded again on the next install', commands: fixed(['npm', 'cache', 'clean', '--force']) },
  { name: 'nuget-cache', description: 'NuGet caches, restored again on the next build', commands: fixed(['dotnet', 'nuget', 'locals', 'all', '--clear']) },
  { name: 'pnpm-store', description: 'pnpm store packages no project references', commands: fixed(['pnpm', 'store', 'prune']) },
  { name: 'journal', description: 'systemd journal beyond its last 500 MB', sudo: true, linux: true, commands: fixed(['journalctl', '--vacuum-size=500M']) },
  {
    name: 'snap-revisions',
    description: 'snap revisions kept for a rollback',
    sudo: true,
    linux: true,
    commands: async (host) =>
      disabledSnaps((await host.run('snap', ['list', '--all'])).stdout).map((snap) => ['snap', 'remove', snap.name, `--revision=${snap.revision}`]),
  },
  { name: 'fstrim', description: 'trim of the free blocks, which a compaction of the WSL disk image then gives back to Windows', sudo: true, linux: true, commands: fixed(['fstrim', '-av']) },
]

export const STEP_NAMES = STEPS.map((step) => step.name)

export interface Planned {
  name: string
  description: string
  commands: string[][]
  // Why the step does not run, a tool not installed or nothing to remove.
  skipped?: string
}

async function installed(run: Run, program: string, native: boolean): Promise<boolean> {
  if (native) return (await run('where', ['/q', program])).code === 0
  return (await run('sh', ['-c', 'command -v "$1"', 'sh', program])).code === 0
}

// npm and pnpm are .cmd scripts on Windows, which only cmd.exe starts, and it reads its command line as written, quotes included.
function cmd(line: string): string[] {
  return ['cmd.exe', '/d', '/s', '/c', `"${line}"`]
}

export async function planCleanup(entries: (string | CustomStep)[], host: Host, root: boolean): Promise<Planned[]> {
  const custom = entries.filter((entry): entry is CustomStep => typeof entry !== 'string')
  // Custom steps run after the built-in ones, and before the trim, whatever the order of the configuration.
  const ordered: (Step | CustomStep)[] = [
    ...STEPS.filter((step) => step.name !== 'fstrim' && entries.includes(step.name)),
    ...custom,
    ...STEPS.filter((step) => step.name === 'fstrim' && entries.includes(step.name)),
  ]
  const native = isNativeWindows(host)
  const planned: Planned[] = []
  for (const step of ordered) planned.push(await planStep(step, host, native, root))
  return planned
}

// The commands as they run: through cmd.exe on Windows, and through sudo for a step that needs root when chade is not.
function runnable(commands: string[][], native: boolean, sudo: boolean): string[][] {
  if (native) return commands.map((command) => cmd(command.join(' ')))
  return sudo ? commands.map((command) => ['sudo', ...command]) : commands
}

async function planStep(step: Step | CustomStep, host: Host, native: boolean, root: boolean): Promise<Planned> {
  if ('command' in step) return { name: step.name, description: 'custom step', commands: [native ? cmd(step.command) : ['sh', '-c', step.command]] }
  if (native && step.linux) return { name: step.name, description: step.description, commands: [], skipped: 'for Linux only' }
  const commands = await step.commands(host)
  const program = commands[0]?.[0] ?? (step.name === 'snap-revisions' ? 'snap' : '')
  let skipped: string | undefined
  if (!(await installed(host.run, program, native))) skipped = `${program} is not installed`
  else if (commands.length === 0) skipped = 'nothing to remove'
  return { name: step.name, description: step.description, commands: runnable(commands, native, !!step.sudo && !root), skipped }
}

export type Inherit = (command: string, args: string[]) => Promise<number>

export interface CleanResult {
  ran: string[]
  failed: string[]
}

export async function runCleanup(planned: Planned[], inherit: Inherit, log: (message: string) => void): Promise<CleanResult> {
  const result: CleanResult = { ran: [], failed: [] }
  for (const step of planned) {
    if (step.skipped) continue
    log(`\n${step.name}: ${step.description}`)
    let failed = false
    for (const [command, ...args] of step.commands) {
      log(`$ ${shown([command, ...args])}`)
      // A failed step stops its own commands only, the next steps still run.
      const code = await inherit(command, args).catch(() => 1)
      if (code !== 0) {
        failed = true
        break
      }
    }
    ;(failed ? result.failed : result.ran).push(step.name)
  }
  return result
}

// A command run through a shell reads best as its line as written.
function shown(command: string[]): string {
  if (command[0] === 'sh' && command[1] === '-c') return command[2]
  if (command[0] === 'cmd.exe') return command[4].slice(1, -1)
  return command.join(' ')
}

export function renderPlan(planned: Planned[]): string {
  const width = Math.max(...planned.map((step) => step.name.length), 0)
  return planned
    .map((step) => {
      const what = step.skipped ? `skipped, ${step.skipped}` : step.description
      const head = `  ${step.name.padEnd(width)}  ${what}`
      return step.skipped ? head : [head, ...step.commands.map((command) => `  ${' '.repeat(width)}  $ ${shown(command)}`)].join('\n')
    })
    .join('\n')
}
