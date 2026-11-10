import type { Repository } from '@chade/daemon'
import { ago, changes, matches, needsAttention, summary, sync, tone, type Badge } from './format.js'

interface State {
  version: string
  machine: string
  scannedAt: string
  repositories: Repository[]
  warnings: string[]
}

const TOKEN_KEY = 'chade-token'
const TAB_KEY = 'chade-system'
// A read costs a few git commands per repository, so the page reads again twice a minute, and only while it is looked at.
const REFRESH_MS = 30_000

// The token arrives in the fragment of the address chade ui opens, and leaves the address bar and the history at once.
function takeToken(): string | null {
  const given = new URLSearchParams(location.hash.slice(1)).get('token')
  if (given) {
    sessionStorage.setItem(TOKEN_KEY, given)
    history.replaceState(null, '', location.pathname)
  }
  return sessionStorage.getItem(TOKEN_KEY)
}

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

// Every text reaches the page as text, never as markup, as a branch name or a commit subject can hold anything.
function node(tag: string, text = '', className = ''): HTMLElement {
  const created = document.createElement(tag)
  created.textContent = text
  if (className) created.className = className
  return created
}

function badges(list: Badge[]): HTMLElement {
  const cell = node('td')
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
  name.append(node('div', repository.name, 'name'), node('div', repository.path, 'path'))
  line.append(name)
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

let state: State | undefined
let failed = false

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
  element('machine').textContent = state.machine
  element('version').textContent = `v${state.version}`
  renderTabs(state, shown)
  renderAge()
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

function renderAge(): void {
  if (!state) return
  const scanned = element('scanned')
  scanned.textContent = failed ? `No answer, last read ${ago(state.scannedAt, Date.now())}` : `Read ${ago(state.scannedAt, Date.now())}`
  scanned.className = failed ? 'stale' : ''
}

// A page that already shows the repositories keeps them when a read fails, and says the read failed.
function fail(message: string): void {
  failed = true
  if (state) return renderAge()
  element('summary').textContent = ''
  element('content').replaceChildren(node('p', message, 'error'))
}

let loading = false

async function load(): Promise<void> {
  const token = takeToken()
  if (!token) {
    state = undefined
    return fail('Not signed in. The chade ui command opens this page with the address that signs in.')
  }
  if (loading) return
  loading = true
  const button = element<HTMLButtonElement>('refresh')
  button.disabled = true
  if (!state) element('summary').textContent = 'Reading the repositories…'
  try {
    const response = await fetch('api/state', { headers: { Authorization: `Bearer ${token}` } })
    if (response.status === 401) {
      // The token of a server that was stopped since: the next chade ui gives a new one.
      sessionStorage.removeItem(TOKEN_KEY)
      state = undefined
      element('tabs').replaceChildren()
      return fail('The session ended with the server it came from. The chade ui command opens a new one.')
    }
    const body = (await response.json()) as State & { error?: string }
    if (!response.ok) return fail(body.error ?? `The server answered ${response.status}.`)
    state = body
    failed = false
    render()
  } catch {
    fail('The server does not answer. The chade ui command starts it.')
  } finally {
    loading = false
    button.disabled = false
  }
}

element('refresh').addEventListener('click', () => void load())
for (const id of ['filter', 'attention']) element(id).addEventListener('input', render)
setInterval(() => {
  if (document.visibilityState === 'visible') void load()
}, REFRESH_MS)
// A tab that comes back to the front shows the present, not what it read before it was left.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load()
})
setInterval(renderAge, 5000)
void load()
