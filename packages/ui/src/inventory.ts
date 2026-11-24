// This module alone, as the rest of the daemon is for Node and not for the page.
import { TECHNOLOGIES } from '@chade/daemon/technologies'
import { address, get } from './api.js'
import { element, node } from './dom.js'
import { listState, type State } from './list.js'
import { chosenSystem, systemTabs } from './systems.js'

let read: State | undefined

function technologiesOf(system: string | undefined): { id: string; name: string; count: number }[] {
  const own = (read?.repositories ?? []).filter((one) => one.system === system)
  return TECHNOLOGIES.map(({ id, name }) => ({ id, name, count: own.filter((one) => one.technologies?.includes(id)).length }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function row(id: string, name: string, count: number, system: string | undefined): HTMLElement {
  const line = node('tr')
  const link = node('a', 'Show the repositories') as HTMLAnchorElement
  link.href = address({ technology: id, system })
  link.setAttribute('aria-label', `Show the ${name} repositories`)
  const last = node('td')
  last.append(link)
  line.append(node('td', name, 'technology-name'), node('td', String(count)), last)
  return line
}

function render(): void {
  if (!read) return
  const systems = [...new Set(read.repositories.map((one) => one.system))]
  const shown = chosenSystem(systems)
  const tabs = systems.map((system) => ({ system, count: technologiesOf(system).length, todo: 0 }))
  element('inventory-tabs').replaceChildren(...systemTabs(tabs, shown, render))
  const found = technologiesOf(shown)
  if (found.length === 0) return element('inventory-content').replaceChildren(node('p', 'No technology found', 'empty'))
  const table = node('table')
  const head = node('thead')
  const titles = node('tr')
  titles.append(...['Technology', 'Repositories', ''].map((title) => node('th', title)))
  head.append(titles)
  const body = node('tbody')
  body.append(...found.map(({ id, name, count }) => row(id, name, count, shown)))
  table.append(head, body)
  element('inventory-content').replaceChildren(table)
}

// The technologies of the repositories.
export const inventoryPage = {
  section: element('inventory'),
  title: (): string => 'Inventory',
  loaded: (): boolean => read !== undefined,
  clear: (): void => {
    read = undefined
  },
  // What was read before shows at once, and the page then reads again behind it.
  async show(): Promise<State | void> {
    read ??= listState()
    if (!read) return this.reload()
    render()
  },
  async reload(): Promise<State> {
    read = await get<State>('state')
    render()
    return read
  },
}
