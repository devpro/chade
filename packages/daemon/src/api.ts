import { repositoryDetail, repositoryDiff } from './history.js'
import { findRepository, listRepositories, type Root, type Run } from './repositories.js'
import { RequestError, type ServerOptions } from './server.js'

export interface ApiOptions {
  version: string
  machine: string
  // The folders to look into, asked at each call, so a change of the configuration shows without a restart.
  roots: () => Promise<Root[]>
  run: Run
}

// The routes of the interface: everything it shows comes from one of them.
export function createApi(options: ApiOptions): ServerOptions['api'] {
  const repository = async (query: URLSearchParams) => {
    const system = query.get('system')
    const path = query.get('path')
    if (!system || !path) throw new RequestError(400, 'a repository is named by its system and its path')
    const found = await findRepository(await options.roots(), system, path)
    if (!found) throw new RequestError(404, `${path} is not a repository under the repos folders of ${system}`)
    return found
  }
  return {
    ping: async () => ({ version: options.version }),
    state: async () => ({
      version: options.version,
      machine: options.machine,
      scannedAt: new Date().toISOString(),
      ...(await listRepositories(await options.roots(), options.run)),
    }),
    repository: async (query) => {
      const { root, relative } = await repository(query)
      const limit = Number(query.get('limit') ?? undefined)
      return { version: options.version, machine: options.machine, scannedAt: new Date().toISOString(), ...(await repositoryDetail(root, relative, options.run, Number.isFinite(limit) ? limit : undefined)) }
    },
    diff: async (query) => {
      const { root, relative } = await repository(query)
      const target = query.get('target') ?? ''
      if (!/^(staged|unstaged|untracked|[0-9a-f]{40})$/.test(target)) throw new RequestError(400, 'the target of a diff is staged, unstaged, untracked or the full hash of a commit')
      return repositoryDiff(root, relative, options.run, target)
    },
  }
}
