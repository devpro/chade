import type { Root } from '@chade/daemon'
import type { Config } from './config.js'
import { expandHome } from './paths.js'
import { isNativeWindows, type Host, type System } from './system.js'

// A repos folder of a system, with the path this process reads it through and the git of its system.
export async function resolveRoot(system: System, root: string, host: Host): Promise<Root | undefined> {
  if (system.kind === 'linux') {
    const folder = expandHome(root, host.home)
    return { system: system.id, folder, path: folder, separator: '/', git: 'git' }
  }
  if (!host.windows) return undefined
  const path = await host.windows.expand(root)
  return {
    system: system.id,
    folder: await host.windows.linuxPath(path),
    path,
    separator: '\\',
    // From WSL, the interop runs the git of Windows by its file name.
    git: isNativeWindows(host) ? 'git' : 'git.exe',
    cwd: host.windows.cwd(),
  }
}

// The repos folders of the configuration.
export async function repositoryRoots(config: Config, host: Host): Promise<Root[]> {
  const roots: Root[] = []
  for (const system of host.systems) {
    for (const root of config[system.kind]?.repos ?? []) {
      const resolved = await resolveRoot(system, root, host)
      if (resolved) roots.push(resolved)
    }
  }
  return roots
}
