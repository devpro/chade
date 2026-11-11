import { ApiError, route } from './api.js'
import { element } from './dom.js'
import { ago } from './format.js'
import { docs } from './docs.js'
import { list } from './list.js'
import { reportPage } from './report.js'
import { repository } from './repository.js'
import { store } from './store.js'

// A read costs a few git commands per repository, so the page reads again twice a minute, and only while it is looked at.
const REFRESH_MS = 30_000

let scannedAt: string | undefined
let failed = false
let loading = false
// What was asked while a read was running, done when it ends: a commit chosen during a refresh is not lost.
let queued: (() => Promise<void>) | undefined

type Read = { machine: string; version: string; scannedAt?: string } | void

interface View {
  section: HTMLElement
  loaded: () => boolean
  clear: () => void
  show: (params: URLSearchParams) => Promise<Read>
  // Asked by the Refresh button, or by the page reading itself again.
  reload: (asked?: boolean) => Promise<Read>
  age?: () => string | undefined
}

const views: View[] = [list, repository, store, reportPage, docs]
// The link of the top of the page each view is reached by, a repository being one of the repositories.
const links = new Map<View, string>([
  [list, 'repositories'],
  [repository, 'repositories'],
  [store, 'store'],
  [reportPage, 'report'],
  [docs, 'docs'],
])

// The view the address names: the store, the report, a repository when it gives one, the list otherwise.
function current(): View {
  const page = route().get('page')
  if (page === 'store') return store
  if (page === 'report') return reportPage
  if (page === 'docs') return docs
  return route().has('path') ? repository : list
}

function renderAge(): void {
  const scanned = element('scanned')
  const own = current().age?.()
  scanned.textContent = own !== undefined ? own : scannedAt ? (failed ? `No answer, last read ${ago(scannedAt, Date.now())}` : `Read ${ago(scannedAt, Date.now())}`) : ''
  scanned.className = failed ? 'stale' : ''
}

function message(text: string): void {
  for (const view of views) view.section.hidden = true
  element('message').hidden = false
  element('message').textContent = text
}

function loaded(result: Read): void {
  failed = false
  if (!result) return renderAge()
  if (result.scannedAt !== undefined) scannedAt = result.scannedAt
  element('machine').textContent = result.machine
  element('version').textContent = `v${result.version}`
  renderAge()
}

function fail(error: unknown): void {
  const view = current()
  if (!(error instanceof ApiError)) return message(error instanceof Error ? error.message : String(error))
  if (error.kind === 'signed-out' || error.kind === 'ended') {
    for (const each of views) each.clear()
    scannedAt = undefined
    renderAge()
    return message(error.message)
  }
  // A page that already shows something keeps it when a read gets no answer, and says the read failed.
  if (error.kind === 'offline' && view.loaded()) {
    failed = true
    return renderAge()
  }
  message(error.message)
}

function mark(): void {
  const name = links.get(current())
  for (const link of element('pages').querySelectorAll<HTMLElement>('a')) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
}

async function run(action: () => Promise<Read>): Promise<boolean> {
  mark()
  if (loading) {
    queued = async () => void (await run(action))
    return true
  }
  let read = false
  loading = true
  const button = element<HTMLButtonElement>('refresh')
  button.disabled = true
  try {
    const view = current()
    const result = await action()
    read = result !== undefined
    element('message').hidden = true
    for (const each of views) each.section.hidden = each !== view
    document.body.classList.toggle('wide', view === repository || view === store || view === reportPage)
    loaded(result)
  } catch (error) {
    // A read that failed has said why, and is not tried again behind the message.
    read = true
    fail(error)
  } finally {
    loading = false
    button.disabled = false
    const next = queued
    queued = undefined
    if (next) await next()
  }
  return read
}

const reload = async (asked = false): Promise<void> => void (await run(() => current().reload(asked)))
// A list shown from what was read before is read again behind it, so a repository just left shows as it is now.
const show = async (): Promise<void> => {
  const read = await run(() => current().show(route()))
  if (!read && current() === list) await reload()
}

element('refresh').addEventListener('click', () => void reload(true))
// A report measured behind the page says so when it is done.
document.addEventListener('chade-measured', (event) => {
  if (current() !== reportPage) return
  const { read, error } = (event as CustomEvent<{ read?: Read; error?: unknown }>).detail
  if (error === undefined) loaded(read)
  else fail(error)
})
window.addEventListener('hashchange', () => void show())
setInterval(() => {
  if (document.visibilityState === 'visible') void reload()
}, REFRESH_MS)
// A tab that comes back to the front shows the present, not what it read before it was left.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void reload()
})
setInterval(renderAge, 5000)
void show()
