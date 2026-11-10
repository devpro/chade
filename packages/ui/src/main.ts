import { ApiError, route } from './api.js'
import { element } from './dom.js'
import { ago } from './format.js'
import { list } from './list.js'
import { repository } from './repository.js'

// A read costs a few git commands per repository, so the page reads again twice a minute, and only while it is looked at.
const REFRESH_MS = 30_000

let scannedAt: string | undefined
let failed = false
let loading = false
// What was asked while a read was running, done when it ends: a commit chosen during a refresh is not lost.
let queued: (() => Promise<void>) | undefined

// The view the address names: a repository when it gives one, the list otherwise.
const current = () => (route().has('path') ? repository : list)

function renderAge(): void {
  const scanned = element('scanned')
  scanned.textContent = scannedAt ? (failed ? `No answer, last read ${ago(scannedAt, Date.now())}` : `Read ${ago(scannedAt, Date.now())}`) : ''
  scanned.className = failed ? 'stale' : ''
}

function message(text: string): void {
  list.section.hidden = true
  repository.section.hidden = true
  element('message').hidden = false
  element('message').textContent = text
}

function loaded(result: { machine: string; version: string; scannedAt: string } | void): void {
  failed = false
  if (!result) return renderAge()
  scannedAt = result.scannedAt
  element('machine').textContent = result.machine
  element('version').textContent = `v${result.version}`
  renderAge()
}

function fail(error: unknown): void {
  const view = current()
  if (!(error instanceof ApiError)) return message(error instanceof Error ? error.message : String(error))
  if (error.kind === 'signed-out' || error.kind === 'ended') {
    list.clear()
    repository.clear()
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

async function run(action: () => Promise<{ machine: string; version: string; scannedAt: string } | void>): Promise<boolean> {
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
    list.section.hidden = view !== list
    repository.section.hidden = view !== repository
    document.body.classList.toggle('wide', view === repository)
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

const reload = async (): Promise<void> => void (await run(() => current().reload()))
// A list shown from what was read before is read again behind it, so a repository just left shows as it is now.
const show = async (): Promise<void> => {
  const read = await run(() => current().show(route()))
  if (!read && current() === list) await reload()
}

element('refresh').addEventListener('click', () => void reload())
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
