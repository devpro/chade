import type { Repository, Store } from '@chade/daemon'
import { address, get } from './api.js'
import { element, node } from './dom.js'
import { ago, changes, matches, needsAttention, summary, sync, tone, type Badge } from './format.js'

interface State {
  version: string
  machine: string
  scannedAt: string
  repositories: Repository[]
  warnings: string[]
}

const TAB_KEY = 'chade-system'

let state: State | undefined
// The store is read with the list, for the tab that opens it, and the list shows without it when it cannot be read.
let stored: Store | undefined

export function badges(list: Badge[], tag = 'td'): HTMLElement {
  const cell = node(tag)
  for (const badge of list) {
    const created = node('span', badge.text, `badge ${badge.tone}`)
    created.title = badge.title
    cell.append(created)
  }
  return cell
}

function row(repository: Repository, now: number): HTMLElement {
  const line = node('tr', '', tone(repository))
  const name = node('td', '', 'repository')
  const link = node('a', repository.name, 'name') as HTMLAnchorElement
  link.href = address({ system: repository.system, path: repository.path })
  name.append(link, node('div', repository.path, 'path'))
  line.append(name)
  // The whole row opens the repository, and the link stays for the keyboard and for opening in another tab.
  line.addEventListener('click', (event) => {
    if (event.target !== link && !getSelection()?.toString()) location.hash = link.hash
  })
  if (repository.error !== undefined) {
    const error = node('td', repository.error, 'error')
    error.setAttribute('colspan', '5')
    line.append(error)
    return line
  }
  const branch = node('td')
  if (repository.branch) branch.append(node('span', repository.branch, 'branch'))
  else if (repository.head) branch.append(node('span', `detached at ${repository.head}`, 'branch detached'))
  const commit = node('td', '', 'commit')
  if (repository.commit) commit.append(node('div', repository.commit.subject, 'subject'), node('div', ago(repository.commit.date, now), 'age'))
  else commit.append(node('span', 'no commit yet', 'age'))
  line.append(branch, badges(sync(repository)), badges(changes(repository)), commit, node('td', repository.fetchedAt ? ago(repository.fetchedAt, now) : 'never', 'age'))
  return line
}

function systems(current: State): string[] {
  return [...new Set(current.repositories.map((repository) => repository.system))]
}

// The system shown, the one chosen last when the machine still has it.
function selected(current: State): string | undefined {
  const all = systems(current)
  const chosen = sessionStorage.getItem(TAB_KEY)
  return chosen !== null && all.includes(chosen) ? chosen : all[0]
}

function renderTabs(current: State, shown: string | undefined): void {
  const tabs = systems(current).map((system) => {
    const repositories = current.repositories.filter((repository) => repository.system === system)
    const todo = repositories.filter(needsAttention).length
    const tab = node('button', '', 'tab')
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(system === shown))
    tab.append(node('span', system), node('span', String(repositories.length), 'count'))
    if (todo > 0) {
      const mark = node('span', String(todo), 'count todo')
      mark.title = `${todo} with something to do`
      tab.append(mark)
    }
    tab.addEventListener('click', () => {
      sessionStorage.setItem(TAB_KEY, system)
      render()
    })
    return tab
  })
  element('tabs').replaceChildren(...tabs, ...storeTab(), reportTab())
}

// The tab of the store is a link, as it opens another page where the others change what this one lists.
function storeTab(): HTMLElement[] {
  if (!stored) return []
  const tab = node('a', '', 'tab store-tab') as HTMLAnchorElement
  tab.href = address({ page: 'store' })
  const last = stored.machines.flatMap((machine) => machine.snapshots.slice(0, 1).map((snapshot) => snapshot.date)).sort().at(-1)
  tab.append(node('span', 'Store'))
  if (stored.error !== undefined) {
    tab.append(node('span', '!', 'count todo'))
    tab.title = stored.error
  } else {
    tab.append(node('span', String(stored.machines.length), 'count'))
    const machines = `${stored.machines.length} machine${stored.machines.length === 1 ? '' : 's'}`
    tab.title = last ? `${machines}, last snapshot ${ago(last, Date.now())}` : `${machines}, no snapshot yet`
  }
  return [tab]
}

function reportTab(): HTMLElement {
  const tab = node('a', 'Report', 'tab') as HTMLAnchorElement
  tab.href = address({ page: 'report' })
  tab.title = 'What takes disk and memory on this machine, and what to clean'
  return tab
}

function render(): void {
  if (!state) return
  const filter = element<HTMLInputElement>('filter').value
  const attention = element<HTMLInputElement>('attention').checked
  const now = Date.now()
  const shown = selected(state)
  renderTabs(state, shown)
  element('warnings').replaceChildren(...state.warnings.map((warning) => node('li', warning)))
  const ofSystem = state.repositories.filter((repository) => repository.system === shown)
  element('summary').textContent = summary(ofSystem)
  const content = element('content')
  if (state.repositories.length === 0) {
    content.replaceChildren(node('p', 'No repository found. The repos list of each system, in the configuration, names the folders chade looks into.', 'empty'))
    return
  }
  const listed = ofSystem.filter((repository) => matches(repository, filter) && (!attention || needsAttention(repository)))
  if (listed.length === 0) {
    content.replaceChildren(node('p', 'No repository matches.', 'empty'))
    return
  }
  const table = node('table')
  const header = node('thead')
  const head = node('tr')
  for (const title of ['Repository', 'Branch', 'Upstream', 'Working tree', 'Last commit', 'Fetched']) head.append(node('th', title))
  header.append(head)
  const body = node('tbody')
  for (const repository of listed) body.append(row(repository, now))
  table.append(header, body)
  content.replaceChildren(table)
}

for (const id of ['filter', 'attention']) element(id).addEventListener('input', render)

// The list of the repositories of the machine, a tab for each system.
export const list = {
  section: element('list'),
  loaded: (): boolean => state !== undefined,
  clear: (): void => {
    state = undefined
  },
  // What was read before shows at once, and the page then reads again, as a repository left a moment ago may have changed.
  async show(): Promise<{ machine: string; version: string; scannedAt: string } | void> {
    if (!state) return this.reload()
    render()
  },
  async reload(): Promise<{ machine: string; version: string; scannedAt: string }> {
    const [read, readStore] = await Promise.all([get<State>('state'), get<Store>('store', { limit: '1' }).catch(() => undefined)])
    state = read
    stored = readStore
    render()
    return state
  },
}
