import type { LogLine } from '@chade/daemon'
import { get, keepAddress, route } from './api.js'
import { element, node } from './dom.js'

interface Read {
  version: string
  machine: string
  scannedAt: string
  lines: LogLine[]
}

// A job writes a line every few seconds, so the page reads often while it is looked at.
const FOLLOW_MS = 3000

let read: Read | undefined
let job: string | undefined

function chip(name: string, count: number): HTMLElement {
  const created = node('button', name, 'chip quiet') as HTMLButtonElement
  created.type = 'button'
  created.setAttribute('aria-pressed', String(job === name))
  created.append(node('span', String(count), 'chip-count'))
  created.addEventListener('click', () => {
    job = job === name ? undefined : name
    render()
  })
  return created
}

function tone(text: string): string {
  if (/\bfailed\b/.test(text)) return 'bad'
  return /^(?:started|done in)\b/.test(text) ? 'mark' : ''
}

function row(line: LogLine): HTMLElement {
  const created = node('tr', '', tone(line.text))
  created.append(node('td', new Date(line.date).toLocaleString(), 'log-date'), node('td', line.job, 'log-job'), node('td', line.text, 'log-text'))
  return created
}

function render(): void {
  if (!read) return
  const { lines } = read
  if (route().get('page') === 'logs') keepAddress({ page: 'logs', job })
  const jobs = [...new Set(lines.map((line) => line.job))].sort((a, b) => a.localeCompare(b))
  element('logs-jobs').replaceChildren(...jobs.map((name) => chip(name, lines.filter((line) => line.job === name).length)))
  const shown = lines.filter((line) => job === undefined || line.job === job)
  if (shown.length === 0) return element('logs-content').replaceChildren(node('p', 'No job ran yet', 'empty'))
  const table = node('table', '', 'log')
  const body = node('tbody')
  // The newest line is the one to see, so it comes first.
  body.append(...shown.toReversed().map(row))
  table.append(body)
  element('logs-content').replaceChildren(table)
}

async function follow(): Promise<void> {
  if (logsPage.section.hidden || document.visibilityState !== 'visible' || getSelection()?.toString()) return
  const last = read?.lines.at(-1)?.date
  const count = read?.lines.length
  read = await get<Read>('logs')
  // Nothing is drawn again without a new line, so the page stays still.
  if (read.lines.at(-1)?.date !== last || read.lines.length !== count) render()
}

// The page that holds the views says when the server does not answer.
setInterval(() => void follow().catch(() => undefined), FOLLOW_MS)

// What the scan, the inventory and the report do, from a terminal and from the server.
export const logsPage = {
  section: element('logs'),
  title: (): string => 'Logs',
  loaded: (): boolean => read !== undefined,
  clear: (): void => {
    read = undefined
  },
  async show(params: URLSearchParams): Promise<Read> {
    job = params.get('job') ?? undefined
    return this.reload()
  },
  async reload(): Promise<Read> {
    read = await get<Read>('logs')
    render()
    return read
  },
}
