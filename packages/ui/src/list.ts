import type { Repository, RepositoryCheck } from '@chade/daemon'
import { TECHNOLOGIES } from '@chade/daemon/technologies'
import { address, get, keepAddress, post, route } from './api.js'
import { element, node } from './dom.js'
import { forgeIcon } from './forge.js'
import { ago, changes, checkOf, matches, needsAttention, summary, sync, tone, type Badge } from './format.js'
import { CHANGED_EVENT, notify, reason, refused } from './notice.js'
import { chooseSystem, chosenSystem, systemTabs } from './systems.js'

export interface State {
  version: string
  machine: string
  scannedAt: string
  repositories: Repository[]
  warnings: string[]
}

let state: State | undefined
// The latest check of IstarCI on each repository, by its system and its path, read after the list.
let latest = new Map<string, RepositoryCheck>()
// The technologies to show, none of them for all the repositories.
let wanted = new Set<string>()
const keyOf = (system: string, path: string): string => `${system}\n${path}`

type Sync = 'pull' | 'push'
// The pull or push running, one at a time, kept apart from the rows so that a list drawn again meanwhile still shows it turning.
let running: { key: string; action: Sync } | undefined

// What the list offers in one click, only when git would do it: a pull when the branch is behind,
// a push when it is ahead and not behind, or never pushed while the repository has a remote.
export function syncActions(repository: Repository): Sync[] {
  if (repository.error !== undefined || !repository.branch) return []
  if (!repository.upstream) return repository.remote ? ['push'] : []
  if ((repository.behind ?? 0) > 0) return ['pull']
  if ((repository.ahead ?? 0) > 0) return ['push']
  return []
}

async function runSync(repository: Repository, action: Sync): Promise<void> {
  if (running) return
  const { system, path, name } = repository
  const key = keyOf(system, path)
  running = { key, action }
  render()
  notify(`${action === 'pull' ? 'Pulling' : 'Pushing'} ${name}…`, '', 'running')
  try {
    const { output } = await post<{ output: string }>('action', { system, path, action })
    notify(`${action === 'pull' ? 'Pulled' : 'Pushed'} ${name}`, output, 'done')
  } catch (error) {
    notify(`${refused(action)} for ${name}`, reason(error), 'failed')
  }
  running = undefined
  document.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: key }))
  await list.reload().catch(() => render())
}

function syncButton(repository: Repository, action: Sync): HTMLButtonElement {
  const busy = running?.key === keyOf(repository.system, repository.path) && running.action === action
  const text = action === 'pull' ? 'Pull' : 'Push'
  const button = node('button', text, `action small sync${busy ? ' running' : ''}`) as HTMLButtonElement
  button.type = 'button'
  button.disabled = running !== undefined
  const target = repository.upstream ?? 'its remote'
  button.title = action === 'pull' ? `Pull ${repository.branch} from ${target}` : `Push ${repository.branch} to ${target}`
  button.setAttribute('aria-label', `${text} ${repository.name}`)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    void runSync(repository, action)
  })
  return button
}

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
  const branch = check.branch ? ` on ${check.branch}` : ''
  link.title = `${text}, for ${check.sha.slice(0, 7)}${branch}${current ? '' : ', not the commit checked out'}`
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

// What the list read last, which the inventory shows without a wait.
export const listState = (): State | undefined => state

// Reads the repositories for any page, and leaves the list as it is drawn.
export async function readState(): Promise<State> {
  state = await get<State>('state')
  return state
}

// The address of the list with its filter, which the page of a repository returns to.
export function listAddress(): string {
  return address(addressValues())
}

function addressValues(): Record<string, string | undefined> {
  if (wanted.size === 0) return {}
  return { system: state && chosenSystem(systems(state)), technology: [...wanted].join(',') }
}

// The chips of the technologies that the repositories of the system have.
// A repository shows when it has each technology that is pressed.
function renderTechnologies(repositories: Repository[]): void {
  const counts = new Map<string, number>()
  for (const id of repositories.flatMap((repository) => repository.technologies ?? [])) counts.set(id, (counts.get(id) ?? 0) + 1)
  wanted = new Set([...wanted].filter((id) => counts.has(id)))
  const chips = TECHNOLOGIES.filter(({ id }) => counts.has(id)).map(({ id, name }) => {
    const chip = node('button', name, 'chip quiet') as HTMLButtonElement
    chip.type = 'button'
    chip.setAttribute('aria-pressed', String(wanted.has(id)))
    chip.append(node('span', String(counts.get(id)), 'chip-count'))
    chip.addEventListener('click', () => {
      if (!wanted.delete(id)) wanted.add(id)
      render()
    })
    return chip
  })
  element('technologies').replaceChildren(...chips)
  element('technologies').hidden = chips.length === 0
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
    if (event.target !== link && !(event.target as HTMLElement).closest('.ci, .sync') && !getSelection()?.toString()) location.hash = link.hash
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
  const remote = node('td', '', 'remote')
  remote.append(forgeIcon(repository.remote))
  const upstream = badges(sync(repository))
  upstream.classList.add('upstream')
  upstream.append(...syncActions(repository).map((action) => syncButton(repository, action)))
  line.append(remote, branch, upstream, badges(changes(repository)), commit)
  if (withChecks) line.append(checkCell(repository))
  line.append(node('td', repository.fetchedAt ? ago(repository.fetchedAt, now) : 'never', 'age'))
  return line
}

// The column of IstarCI shows when it has a word on one of the repositories listed, so a list IstarCI says nothing of is as it is without it.
function columns(withChecks: boolean): string[] {
  return ['Repository', 'Remote', 'Branch', 'Upstream', 'Working tree', 'Last commit', ...(withChecks ? ['IstarCI'] : []), 'Fetched']
}

const hasCheck = (repository: Repository): boolean => latest.has(keyOf(repository.system, repository.path))

function systems(current: State): string[] {
  return [...new Set(current.repositories.map((repository) => repository.system))]
}

function renderTabs(current: State, shown: string | undefined): void {
  const tabs = systems(current).map((system) => {
    const repositories = current.repositories.filter((repository) => repository.system === system)
    return { system, count: repositories.length, todo: repositories.filter(needsAttention).length }
  })
  element('tabs').replaceChildren(...systemTabs(tabs, shown, render))
}

function render(): void {
  if (!state) return
  const filter = element<HTMLInputElement>('filter').value
  const attention = element<HTMLInputElement>('attention').checked
  const now = Date.now()
  const shown = chosenSystem(systems(state))
  renderTabs(state, shown)
  element('warnings').replaceChildren(...state.warnings.map((warning) => node('li', warning)))
  const ofSystem = state.repositories.filter((repository) => repository.system === shown)
  element('summary').textContent = summary(ofSystem)
  renderTechnologies(ofSystem)
  // A read that ends after the list was left must not change the address of another page.
  if (!route().has('page') && !route().has('path')) keepAddress(addressValues())
  const content = element('content')
  if (state.repositories.length === 0) {
    content.replaceChildren(node('p', 'No repository found. The repos list of each system, in the configuration, names the folders chade looks into.', 'empty'))
    return
  }
  const listed = ofSystem.filter((repository) => matches(repository, filter) && (!attention || needsAttention(repository)) && [...wanted].every((id) => repository.technologies?.includes(id)))
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
  title: (): string => 'Repositories',
  loaded: (): boolean => state !== undefined,
  clear: (): void => {
    state = undefined
  },
  // What was read before shows at once, and the page then reads again, as a repository left a moment ago may have changed.
  async show(params: URLSearchParams): Promise<{ machine: string; version: string; scannedAt: string } | void> {
    // The address gives the filter: none in the address is none on the page.
    wanted = new Set(params.get('technology')?.split(',').filter(Boolean))
    const system = params.get('system')
    if (system) chooseSystem(system)
    if (!state) return this.reload()
    render()
  },
  async reload(): Promise<{ machine: string; version: string; scannedAt: string }> {
    const read = await readState()
    render()
    void get<{ checks: { system: string; path: string; check: RepositoryCheck }[] }>('latest-checks')
      .then(({ checks }) => {
        latest = new Map(checks.map(({ system, path, check }) => [keyOf(system, path), check]))
        render()
      })
      // IstarCI is no part of the list, which a read of it that fails leaves as it was.
      .catch(() => undefined)
    return read
  },
}
