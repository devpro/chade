import type { Root } from '@chade/daemon'
import type { Config } from './config.js'
import { expandHome } from './paths.js'
import { isNativeWindows, type Host } from './system.js'

// The repos folders of the configuration, each one with the path this process reads it through and the git of its system.
export async function repositoryRoots(config: Config, host: Host): Promise<Root[]> {
  const roots: Root[] = []
  for (const system of host.systems) {
    for (const root of config[system.kind]?.repos ?? []) {
      if (system.kind === 'linux') {
        const folder = expandHome(root, host.home)
        roots.push({ system: system.id, folder, path: folder, separator: '/', git: 'git' })
      } else if (host.windows) {
        const path = await host.windows.expand(root)
        roots.push({
          system: system.id,
          folder: await host.windows.linuxPath(path),
          path,
          separator: '\\',
          // From WSL, the interop runs the git of Windows by its file name.
          git: isNativeWindows(host) ? 'git' : 'git.exe',
          cwd: host.windows.cwd(),
        })
      }
    }
  }
  return roots
}
