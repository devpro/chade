import { execFile, spawn } from 'node:child_process'

export interface Result {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  encoding?: BufferEncoding
  timeoutMs?: number
}

export type Run = (command: string, args: string[], options?: RunOptions) => Promise<Result>

// The exit code a shell gives a command it cannot find, so "not installed" reads the same here as in a script.
export const NOT_FOUND = 127

export const run: Run = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: options.timeoutMs ?? 300_000, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: exitCode(error), stdout: stdout.toString(options.encoding ?? 'utf8'), stderr: stderr.toString('utf8') })
      },
    )
  })

function exitCode(error: (Error & { code?: unknown }) | null): number {
  if (!error) return 0
  if (error.code === 'ENOENT') return NOT_FOUND
  return typeof error.code === 'number' ? error.code : 1
}

export function runInherit(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}
