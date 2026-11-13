import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Run } from './exec.js'

// The store is any folder of a git repository, the root of a dedicated one or a subfolder of a repository holding other things.
export async function repositoryRoot(run: Run, store: string): Promise<string | undefined> {
  let folder = store
  // A store not created yet belongs to the repository of its closest existing parent.
  while (!existsSync(folder) && dirname(folder) !== folder) folder = dirname(folder)
  const result = await run('git', ['-C', folder, 'rev-parse', '--show-toplevel'])
  return result.code === 0 ? result.stdout.trim() : undefined
}

export async function git(run: Run, store: string, args: string[]): Promise<string> {
  const result = await run('git', ['-C', store, ...args])
  if (result.code !== 0) throw new Error(`git ${args[0]} failed in ${store}: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout
}

export async function requireRepository(run: Run, store: string): Promise<string> {
  const root = existsSync(store) ? await repositoryRoot(run, store) : undefined
  if (!root) throw new Error(`the store ${store} is not a folder of a git repository, chade init creates it`)
  return root
}
