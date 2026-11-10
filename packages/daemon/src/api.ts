import { runAction, type ActionRequest } from './actions.js'
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

// The one route that changes a repository, at the request of the person at the interface.
export function createActions(options: ApiOptions): NonNullable<ServerOptions['actions']> {
  // Two commands in one repository at the same time would fight over its index.
  const busy = new Set<string>()
  return {
    action: async (body) => {
      if (typeof body !== 'object' || body === null) throw new RequestError(400, 'the request names a repository and an action')
      const { system, path, ...request } = body as { system?: unknown; path?: unknown } & ActionRequest
      if (typeof system !== 'string' || typeof path !== 'string' || typeof request.action !== 'string') {
        throw new RequestError(400, 'the request names a repository, by its system and its path, and an action')
      }
      const found = await findRepository(await options.roots(), system, path)
      if (!found) throw new RequestError(404, `${path} is not a repository under the repos folders of ${system}`)
      const key = `${system}\n${path}`
      if (busy.has(key)) throw new RequestError(409, 'another action is running in this repository')
      busy.add(key)
      try {
        return await runAction(found.root, found.relative, options.run, request)
      } finally {
        busy.delete(key)
      }
    },
  }
}

// The routes of the interface that read: everything it shows comes from one of them.
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
