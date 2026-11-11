import type { Repository, RepositoryCheck } from '@chade/daemon'
import { address, get } from './api.js'
import { element, node } from './dom.js'
import { ago, changes, checkOf, matches, needsAttention, summary, sync, tone, type Badge } from './format.js'

interface State {
  version: string
  machine: string
  scannedAt: string
  repositories: Repository[]
  warnings: string[]
}

const TAB_KEY = 'chade-system'

let state: State | undefined
// The latest check of IstarCI on each repository, by its system and its path, read after the list.
let latest = new Map<string, RepositoryCheck>()
const keyOf = (system: string, path: string): string => `${system}\n${path}`

// What IstarCI said last about the repository, grey when it is about another commit than the one checked out.
function checkCell(repository: Repository): HTMLElement {
  const cell = node('td', '', 'ci')
  const check = latest.get(keyOf(repository.system, repository.path))
  if (!check) return cell
  const { mark, tone, text } = checkOf(check)
  const current = repository.head !== undefined && check.sha.startsWith(repository.head)
  const link = node('a', '', `check-link ${current ? tone : 'quiet'}`) as HTMLAnchorElement
  link.href = check.url
  link.target = '_blank'
  link.rel = 'noopener'
  link.title = `${text}, for ${check.sha.slice(0, 7)}${check.branch ? ` on ${check.branch}` : ''}${current ? '' : ', not the commit checked out'}`
  link.setAttribute('aria-label', link.title)
  link.append(node('span', mark, 'check'))
  cell.append(link)
  return cell
}

export function badges(list: Badge[], tag = 'td'): HTMLElement {
  const cell = node(tag)
  for (const badge of list) {
    const created = node('span', badge.text, `badge ${badge.tone}`)
    created.title = badge.title
    cell.append(created)
  }
  return cell
}

function row(repository: Repository, now: number, withChecks: boolean): HTMLElement {
  const line = node('tr', '', tone(repository))
  const name = node('td', '', 'repository')
  const link = node('a', repository.name, 'name') as HTMLAnchorElement
  link.href = address({ system: repository.system, path: repository.path })
  name.append(link, node('div', repository.path, 'path'))
  line.append(name)
  // The whole row opens the repository, and the link stays for the keyboard and for opening in another tab.
  line.addEventListener('click', (event) => {
    if (event.target !== link && !(event.target as HTMLElement).closest('.ci') && !getSelection()?.toString()) location.hash = link.hash
  })
  if (repository.error !== undefined) {
    const error = node('td', repository.error, 'error')
    error.setAttribute('colspan', String(columns(withChecks).length - 1))
    line.append(error)
    return line
  }
  const branch = node('td')
  if (repository.branch) branch.append(node('span', repository.branch, 'branch'))
  else if (repository.head) branch.append(node('span', `detached at ${repository.head}`, 'branch detached'))
  const commit = node('td', '', 'commit')
  if (repository.commit) commit.append(node('div', repository.commit.subject, 'subject'), node('div', ago(repository.commit.date, now), 'age'))
  else commit.append(node('span', 'no commit yet', 'age'))
  line.append(branch, badges(sync(repository)), badges(changes(repository)), commit)
  if (withChecks) line.append(checkCell(repository))
  line.append(node('td', repository.fetchedAt ? ago(repository.fetchedAt, now) : 'never', 'age'))
  return line
}

// The column of IstarCI shows when it has a word on one of the repositories listed, so a list IstarCI says nothing of is as it is without it.
function columns(withChecks: boolean): string[] {
  return ['Repository', 'Branch', 'Upstream', 'Working tree', 'Last commit', ...(withChecks ? ['IstarCI'] : []), 'Fetched']
}

const hasCheck = (repository: Repository): boolean => latest.has(keyOf(repository.system, repository.path))

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
  element('tabs').replaceChildren(...tabs)
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
  const withChecks = listed.some(hasCheck)
  for (const title of columns(withChecks)) head.append(node('th', title))
  header.append(head)
  const body = node('tbody')
  for (const repository of listed) body.append(row(repository, now, withChecks))
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
    state = await get<State>('state')
    render()
    void get<{ checks: { system: string; path: string; check: RepositoryCheck }[] }>('latest-checks')
      .then(({ checks }) => {
        latest = new Map(checks.map(({ system, path, check }) => [keyOf(system, path), check]))
        render()
      })
      // IstarCI is no part of the list, which a read of it that fails leaves as it was.
      .catch(() => undefined)
    return state
  },
}
