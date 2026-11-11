import type { Report, Section } from '@chade/daemon'
import { get } from './api.js'
import { docsAddress } from './docs.js'
import { element, node } from './dom.js'
import { bytes } from './format.js'

type Loaded = Omit<Report, 'date'> & { version: string; scannedAt: string }

const SHORT = 24

let report: Loaded | undefined
let measuring = false

function card(section: Section): HTMLElement {
  const created = node('article', '', `card${section.hints.length > 0 ? ' todo' : ''}`)
  created.append(node('h3', section.title))
  // A size reads against the largest of its section, the total when the section gives one, and a lone size has nothing to read against.
  const sized = section.measures.filter((measure) => measure.bytes !== undefined)
  const largest = sized.length > 1 ? Math.max(...sized.map((measure) => measure.bytes ?? 0)) : 0
  for (const measure of section.measures) {
    const line = node('div', '', 'measure')
    // A short value without a size, such as a setting, sits where a size would, on the line of its label.
    const value = measure.bytes === undefined && measure.detail !== undefined && measure.detail.length <= SHORT
    line.append(node('span', measure.label, 'measure-label'))
    if (value) line.append(node('span', measure.detail, 'measure-size value'))
    else line.append(node('span', measure.bytes === undefined ? '' : bytes(measure.bytes), 'measure-size'))
    if (measure.detail && !value) line.append(node('span', measure.detail, 'measure-detail'))
    if (measure.bytes !== undefined && largest > 0) {
      const bar = node('span', '', 'measure-bar')
      const fill = node('span')
      fill.style.width = `${Math.max(1, Math.round((measure.bytes / largest) * 100))}%`
      bar.append(fill)
      line.append(bar)
    }
    created.append(line)
  }
  // A hint is a sentence, and the lines indented under it are the commands it gives.
  let commands: HTMLElement | undefined
  for (const hint of section.hints) {
    if (hint.startsWith('  ')) {
      if (!commands) created.append((commands = node('div', '', 'commands')))
      commands.append(node('div', hint.trimStart()))
    } else {
      commands = undefined
      created.append(node('p', hint, 'advice'))
    }
  }
  if (section.hints.length > 0 && section.guide) {
    const guide = node('a', 'How to, step by step', 'guide') as HTMLAnchorElement
    guide.href = docsAddress('cleanup', section.guide)
    created.append(guide)
  }
  return created
}

function render(): void {
  const state = element('report-state')
  state.textContent = measuring ? 'Measuring the machine, which takes a few seconds…' : report ? `Measured ${new Date(report.scannedAt).toLocaleString()}` : ''
  state.classList.toggle('measuring', measuring)
  const created: HTMLElement[] = []
  if (report) {
    const todo = report.sections.filter((section) => section.hints.length > 0).length
    element('report-summary').textContent = todo === 0 ? 'Nothing to clean' : `${todo} section${todo === 1 ? '' : 's'} with something to clean`
    const grid = node('div', '', 'cards')
    grid.append(...report.sections.map(card))
    created.push(grid)
  } else element('report-summary').textContent = ''
  element('report-sections').replaceChildren(...created)
}

// A report takes the seconds its commands take, so it is measured behind the page, which stays free to leave.
// The page that holds the views is told the outcome, to say it as it says any read or any failure.
function measure(): void {
  if (measuring) return
  measuring = true
  render()
  const done = (detail: { read?: Loaded; error?: unknown }): void => {
    measuring = false
    render()
    document.dispatchEvent(new CustomEvent('chade-measured', { detail }))
  }
  get<Loaded>('report').then(
    (read) => {
      report = read
      done({ read })
    },
    (error: unknown) => done({ error }),
  )
}

// What chade report measures: what takes disk and memory, and what to do about it.
export const reportPage = {
  section: element('report'),
  loaded: (): boolean => report !== undefined,
  clear: (): void => {
    report = undefined
  },
  // What the top of the page says in place of the age of the last read, while there is none to give.
  age: (): string | undefined => (measuring ? 'Measuring…' : undefined),
  async show(): Promise<{ machine: string; version: string; scannedAt?: string }> {
    render()
    if (report) return report
    measure()
    // The machine is named at once, without waiting for its report.
    return get<{ machine: string; version: string }>('ping')
  },
  // Measured again when asked, and not by the page reading itself again, as a report is no glance at a repository.
  async reload(asked = false): Promise<void> {
    if (asked) measure()
  },
}
