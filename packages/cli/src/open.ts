import type { Run } from './exec.js'
import { isNativeWindows, type Host } from './system.js'

// Opens an address in the browser of the desktop, the one of Windows on WSL, and tells whether a browser took it.
export async function openBrowser(url: string, host: Host, run: Run): Promise<boolean> {
  // rundll32 takes the address as one argument, where the start of cmd.exe would parse it as a command line.
  if (!host.windows) return (await run('xdg-open', [url], { timeoutMs: 10_000 })).code === 0
  const rundll32 = isNativeWindows(host) ? 'rundll32' : 'rundll32.exe'
  return (await run(rundll32, ['url.dll,FileProtocolHandler', url], { cwd: host.windows.cwd(), timeoutMs: 10_000 })).code === 0
}
