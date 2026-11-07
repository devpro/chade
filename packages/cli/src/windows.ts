import { existsSync } from 'node:fs'
import { NOT_FOUND, type Result, type Run, type RunOptions } from './exec.js'

// cmd.exe refuses a Linux working directory and falls back to C:\Windows with a warning on every call.
const WINDOWS_CWD = '/mnt/c'

// cmd.exe reports a command it cannot find with 9009, where a Linux shell says 127.
const CMD_NOT_FOUND = 9009

// Reaches Windows through cmd.exe, from WSL through the interop that runs .exe files from Linux, or directly when chade runs on Windows.
export class Windows {
  private readonly variables = new Map<string, string | undefined>()

  constructor(
    private readonly run: Run,
    private readonly native = false,
  ) {}

  cwd(): string | undefined {
    return !this.native && existsSync(WINDOWS_CWD) ? WINDOWS_CWD : undefined
  }

  async exec(args: string[], options: RunOptions = {}): Promise<Result> {
    const result = await this.run('cmd.exe', ['/d', '/c', ...args], { cwd: this.cwd(), ...options })
    return result.code === CMD_NOT_FOUND ? { ...result, code: NOT_FOUND } : result
  }

  async env(name: string): Promise<string | undefined> {
    if (!this.variables.has(name)) {
      const result = await this.exec(['echo', `%${name}%`])
      const value = result.stdout.trim()
      // cmd.exe echoes an undefined variable back as written.
      this.variables.set(name, result.code === 0 && value !== '' && value !== `%${name}%` ? value : undefined)
    }
    return this.variables.get(name)
  }

  async expand(path: string): Promise<string> {
    let expanded = path
    for (const [match, name] of path.matchAll(/%([^%]+)%/g)) {
      const value = await this.env(name)
      if (value === undefined) throw new Error(`Windows variable ${match} is not defined, in ${path}`)
      expanded = expanded.replace(match, value)
    }
    return expanded
  }

  // The path the files are read through, the Windows path itself when chade runs on Windows.
  async linuxPath(windowsPath: string): Promise<string> {
    if (this.native) return windowsPath
    const result = await this.run('wslpath', ['-u', windowsPath])
    if (result.code !== 0) throw new Error(`wslpath cannot translate ${windowsPath}: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }
}
