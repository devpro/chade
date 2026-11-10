import type { Run } from './exec.js'
import { isNativeWindows, type Host } from './system.js'

// Opens an address in the browser of the desktop, the one of Windows on WSL, and tells whether a browser took it.
export async function openBrowser(url: string, host: Host, run: Run): Promise<boolean> {
  // rundll32 takes the address as one argument, where the start of cmd.exe would parse it as a command line.
  const result = host.windows
    ? await run(isNativeWindows(host) ? 'rundll32' : 'rundll32.exe', ['url.dll,FileProtocolHandler', url], { cwd: host.windows.cwd(), timeoutMs: 10_000 })
    : await run('xdg-open', [url], { timeoutMs: 10_000 })
  return result.code === 0
}
