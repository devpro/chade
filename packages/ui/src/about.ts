import type { Repository, UpdateCount } from '@chade/daemon'
// This module alone, as the rest of the daemon is for Node and not for the page.
import { TECHNOLOGIES } from '@chade/daemon/technologies'
import { address, get } from './api.js'
import { node } from './dom.js'

// The updates of the last inventory for each repository, by its system and its path.
let updates = new Map<string, UpdateCount>()

export async function readUpdates(): Promise<void> {
  const read = await get<{ updates: UpdateCount[] }>('updates')
  updates = new Map(read.updates.map((one) => [`${one.system}\n${one.path}`, one]))
}

function updatesLink(found: UpdateCount): HTMLElement {
  const link = node('a', found.count === 1 ? '1 update' : `${found.count} updates`, found.fixes > 0 ? 'updates fixes' : 'updates') as HTMLAnchorElement
  link.href = address({ page: 'updates', system: found.system, repository: found.path })
  link.title = found.fixes > 0 ? `${found.fixes} of them fix a known vulnerability` : 'Newer versions of the dependencies'
  return link
}

// The technologies of a repository and the link to its updates, at the end of its left pane.
export function aboutSection(repository: Repository): HTMLElement {
  const section = node('section', '', 'about')
  const names = TECHNOLOGIES.filter(({ id }) => repository.technologies?.includes(id)).map(({ name }) => name)
  if (names.length > 0) {
    const badges = node('div', '', 'technology-badges')
    badges.append(...names.map((name) => node('span', name, 'technology')))
    section.append(node('h3', 'Technologies'), badges)
  }
  const found = updates.get(`${repository.system}\n${repository.path}`)
  if (found) section.append(node('h3', 'Dependencies'), updatesLink(found))
  return section
}
