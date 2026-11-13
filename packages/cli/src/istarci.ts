import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IstarciServer } from '@chade/daemon'
import { parse } from 'yaml'

const DEFAULT_PORT = 7842

// Where IstarCI answers, read from its own configuration, so chade keeps no copy of its token.
// IstarCI is asked on the loopback address whatever host it listens on, so its token never leaves the machine.
export function parseIstarciConfig(text: string): IstarciServer | undefined {
  const raw: unknown = parse(text)
  const server: unknown = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).server : undefined
  if (typeof server !== 'object' || server === null) return undefined
  const { port = DEFAULT_PORT, webhookToken } = server as Record<string, unknown>
  if (typeof webhookToken !== 'string' || webhookToken === '' || typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { url: `http://127.0.0.1:${port}`, token: webhookToken }
}

// Absent when IstarCI is not set up on this machine, or its configuration cannot be read.
export async function istarciServer(home: string): Promise<IstarciServer | undefined> {
  const text = await readFile(join(home, '.istarci', 'config.yml'), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return parseIstarciConfig(text)
  } catch {
    return undefined
  }
}
