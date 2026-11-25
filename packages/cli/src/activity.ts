import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseLog, type LogLine } from '@chade/daemon'

// What the scan, the inventory and the report do, from a terminal and from the server, in one file that the Logs page shows.

const MAX_BYTES = 1024 * 1024
const KEPT_LINES = 2000

export function activityFile(configFile: string): string {
  return join(dirname(configFile), 'activity.log')
}

export async function readActivity(file: string): Promise<LogLine[]> {
  const text = await readFile(file, 'utf8').catch(() => '')
  return parseLog(text).slice(-KEPT_LINES)
}

async function shorten(file: string): Promise<void> {
  const info = await stat(file).catch(() => undefined)
  if (!info || info.size < MAX_BYTES) return
  const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
  await writeFile(file, `${lines.slice(-KEPT_LINES).join('\n')}\n`, { mode: 0o600 })
}

export function seconds(from: number, to = Date.now()): string {
  const total = Math.round((to - from) / 1000)
  return total < 60 ? `${total} s` : `${Math.floor(total / 60)} min ${total % 60} s`
}

export type Progress = (line: string) => void

// Runs a job and writes its progress to the file, and to the terminal when there is one.
export async function logged<T>(file: string, job: string, work: (progress: Progress) => Promise<T>, terminal?: Progress): Promise<T> {
  // A log that cannot be written must not stop the job.
  await mkdir(dirname(file), { recursive: true }).catch(() => undefined)
  await shorten(file).catch(() => undefined)
  let written: Promise<unknown> = Promise.resolve()
  const progress: Progress = (line) => {
    terminal?.(line)
    const text = `${new Date().toISOString()} ${job} ${line.replace(/\s+/g, ' ')}\n`
    // One write after the other keeps the lines in order.
    written = written.then(() => appendFile(file, text, { mode: 0o600 })).catch(() => undefined)
  }
  const start = Date.now()
  progress('started')
  try {
    const result = await work(progress)
    progress(`done in ${seconds(start)}`)
    return result
  } catch (error) {
    progress(`failed after ${seconds(start)}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally {
    await written
  }
}
