import type { Config } from './config.js'
import { runInherit, type Run } from './exec.js'
import { requireRepository } from './store.js'

// The tree of a repository with no file, which git accepts as the base of the first snapshot.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export interface DiffOptions {
  since?: string
  stat?: boolean
}

export async function diffArgs(config: Config, machine: string, run: Run, rev: string | undefined, options: DiffOptions): Promise<string[]> {
  await requireRepository(run, config.store)
  let base = rev
  if (options.since) {
    const found = await run('git', ['-C', config.store, 'rev-list', '-1', `--before=${options.since}`, 'HEAD', '--', machine])
    base = found.stdout.trim() || EMPTY_TREE
  }
  if (!base) {
    const previous = await run('git', ['-C', config.store, 'rev-list', '-1', '--skip=1', 'HEAD', '--', machine])
    base = previous.stdout.trim() || EMPTY_TREE
  }
  return ['-C', config.store, 'diff', ...(options.stat ? ['--stat'] : []), base, 'HEAD', '--', machine]
}

export async function diff(config: Config, machine: string, run: Run, rev: string | undefined, options: DiffOptions): Promise<number> {
  return runInherit('git', await diffArgs(config, machine, run, rev, options))
}
