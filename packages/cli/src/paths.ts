import { posix } from 'node:path'

export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return posix.join(home, path.slice(2))
  return path
}

// A folder or file name chade creates in the store, which must never climb out of it.
export function isSegment(name: string): boolean {
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..'
}

export function linuxStorePath(path: string, home: string): string {
  const absolute = posix.normalize(expandHome(path, home))
  if (!absolute.startsWith('/')) throw new Error(`${path} is not an absolute path`)
  return absolute.slice(1)
}

export function windowsStorePath(path: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (!match) throw new Error(`${path} is not an absolute Windows path with a drive letter`)
  const rest = posix.normalize(match[2].replaceAll('\\', '/'))
  if (rest.startsWith('..')) throw new Error(`${path} climbs above its drive`)
  return posix.join(match[1].toUpperCase(), rest)
}
