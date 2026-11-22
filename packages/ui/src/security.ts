// The scan module alone, as the rest of the daemon is for Node and not for the page.
import { countsOf, SEVERITIES, severityRank, type Finding, type Place, type Scan, type Severity, type ToolUse } from '@chade/daemon/scan'
import { get, post } from './api.js'
import { element, node } from './dom.js'
import { bytes } from './format.js'

interface Read {
  version: string
  machine: string
  scan?: Scan
  // The date of the scan, which the top of the page tells the age of.
  scannedAt?: string
}

const TONES: Record<Severity, string> = { critical: 'bad', high: 'warn', medium: 'info', low: 'quiet', unknown: 'quiet' }
const KINDS: Record<Place['kind'], string> = { machine: 'installed for the user', repository: 'installed in a repository', cache: 'cache', image: 'container image' }

let read: Read | undefined
let scanning = false
let failure: string | undefined
let system: string | undefined
let filter = ''

// A command is what the page is for, so a click copies it whole.
function copyButton(text: string): HTMLElement {
  const button = node('button', 'Copy', 'copy') as HTMLButtonElement
  button.type = 'button'
  button.setAttribute('aria-label', `Copy ${text}`)
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(
      () => (button.textContent = 'Copied'),
      () => (button.textContent = 'Copy failed'),
    )
    setTimeout(() => (button.textContent = 'Copy'), 1500)
  })
  return button
}

function badge(text: string, tone: string, title = ''): HTMLElement {
  const created = node('span', text, `badge ${tone}`)
  if (title) created.title = title
  return created
}

// The advisory on OSV, which has a page for the identifiers trivy gives as well.
function advisory(id: string): HTMLElement {
  const link = node('a', id, 'advisory') as HTMLAnchorElement
  link.href = `https://osv.dev/vulnerability/${encodeURIComponent(id)}`
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  return link
}

function levelBadges(findings: Finding[]): HTMLElement[] {
  const badges: HTMLElement[] = []
  const malicious = findings.filter((finding) => finding.malicious).length
  if (malicious > 0) badges.push(badge(`${malicious} malicious`, 'bad', 'Removed rather than updated, as it may have run at its install'))
  for (const level of SEVERITIES) {
    const count = findings.filter((finding) => !finding.malicious && finding.severity === level).length
    if (count > 0) badges.push(badge(`${count} ${level}`, TONES[level]))
  }
  return badges
}

function findingRow(finding: Finding): HTMLElement {
  const row = node('tr')
  const level = node('td')
  level.append(finding.malicious ? badge('malicious', 'bad') : badge(finding.severity, TONES[finding.severity]))
  const id = node('td')
  id.append(advisory(finding.ids[0]))
  // A finding several scanners agree on is surer than one alone saw, and one alone is what another layer missed.
  const tools = node('td', finding.tools.join(', '), 'tools')
  tools.title = `Found by ${finding.tools.join(', ')}`
  row.append(level, node('td', `${finding.package} ${finding.version}`, 'package'), node('td', finding.fixed ? `fixed in ${finding.fixed}` : 'no fix yet', finding.fixed ? 'fix' : 'fix none'), id, tools, node('td', finding.summary, 'summary'))
  return row
}

function placeHead(place: Place): HTMLElement[] {
  const head = node('span', '', 'place-head')
  head.append(node('span', place.label, 'place-label'), node('span', `${place.system}, ${KINDS[place.kind]}`, 'path'))
  // A note, such as a system past its end of life, says more than any one finding, so it shows with the place closed.
  head.append(...place.notes.map((note) => node('span', note, 'note')))
  const facts = node('span', '', 'place-facts')
  if (place.packages > 0) facts.append(node('span', `${place.packages} package(s)`, 'path'))
  facts.append(...levelBadges(place.findings))
  return [head, facts]
}

// The findings of a place are drawn when it is opened, as a binary of Terraform alone can have hundreds.
function placeItem(place: Place): HTMLElement {
  const details = node('details', '', 'place') as HTMLDetailsElement
  const summary = node('summary')
  summary.append(...placeHead(place))
  details.append(summary)
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('table')) return
    const table = node('table', '', 'findings')
    const body = node('tbody')
    body.append(...place.findings.toSorted((a, b) => severityRank(a) - severityRank(b)).map(findingRow))
    table.append(body)
    details.append(table)
  })
  return details
}

// A malicious package may have run at its install, so each is named with where it lies, the place to remove it from.
function maliciousTable(found: { place: Place; finding: Finding }[]): HTMLElement {
  const table = node('table', '', 'malicious')
  const body = node('tbody')
  for (const { place, finding } of found) {
    const row = node('tr')
    const id = node('td')
    id.append(advisory(finding.ids[0]))
    const where = node('td', '', 'place-cell')
    where.append(node('span', place.label, 'place-label'), node('span', place.system, 'path'))
    row.append(node('td', `${finding.package} ${finding.version}`, 'package'), id, where, node('td', finding.tools.join(', '), 'tools'), node('td', finding.summary, 'summary'))
    body.append(row)
  }
  table.append(body)
  return table
}

function unusedTable(places: Place[]): HTMLElement {
  const table = node('table', '', 'unused')
  const head = node('thead')
  const titles = node('tr')
  titles.append(...['Place', 'Size', 'Why', 'Command'].map((title) => node('th', title)))
  head.append(titles)
  const body = node('tbody')
  for (const place of places.toSorted((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))) {
    const row = node('tr')
    const label = node('td', '', 'place-cell')
    label.append(node('span', place.label, 'place-label'), node('span', place.system, 'path'))
    const command = node('td')
    const line = node('span', '', 'command')
    line.append(node('code', place.unused?.command ?? ''), copyButton(place.unused?.command ?? ''))
    command.append(line)
    row.append(label, node('td', place.bytes === undefined ? '' : bytes(place.bytes), 'size'), node('td', place.unused?.reason ?? '', 'summary'), command)
    body.append(row)
  }
  table.append(head, body)
  return table
}

// Each scanner is a layer, so the page says which ran on each system with its version, and which is missing or failed.
function scannerList(uses: ToolUse[]): HTMLElement {
  const list = node('ul', '', 'scanners')
  for (const key of [...new Set(uses.map((use) => `${use.system} ${use.part}`))]) {
    const item = node('li')
    item.append(node('span', key, 'scanner-part'))
    for (const use of uses.filter((one) => `${one.system} ${one.part}` === key)) {
      const created = use.problem ? badge(`${use.tool}: ${use.problem}`, 'warn') : badge(`${use.tool} ${use.version ?? ''}`.trim(), 'quiet')
      item.append(created)
    }
    list.append(item)
  }
  return list
}

function matches(place: Place): boolean {
  if (system !== undefined && place.system !== system) return false
  if (filter === '') return true
  const text = filter.toLowerCase()
  return place.label.toLowerCase().includes(text) || place.findings.some((finding) => finding.package.toLowerCase().includes(text) || finding.ids.some((id) => id.toLowerCase().includes(text)))
}

function tabs(scan: Scan): HTMLElement[] {
  const systems = [...new Set(scan.places.map((place) => place.system))]
  const tab = (name: string | undefined, count: number): HTMLElement => {
    const created = node('button', '', 'tab')
    created.setAttribute('role', 'tab')
    created.setAttribute('aria-selected', String(system === name))
    created.append(node('span', name ?? 'All'), node('span', String(count), 'count'))
    created.addEventListener('click', () => {
      system = name
      render()
    })
    return created
  }
  return [tab(undefined, scan.places.length), ...systems.map((name) => tab(name, scan.places.filter((place) => place.system === name).length))]
}

function section(title: string, ...content: HTMLElement[]): HTMLElement {
  const created = node('section', '', 'scan-part')
  created.append(node('h3', title), ...content)
  return created
}

function stateText(): string {
  if (scanning) return 'Scanning the disk, which takes minutes…'
  if (failure) return failure
  if (!read) return ''
  return read.scan ? `Scanned ${new Date(read.scan.date).toLocaleString()}` : 'Never scanned'
}

function summaryText(scan: Scan): string {
  const counts = countsOf(scan)
  const parts = [`${counts.malicious} malicious`, ...(['critical', 'high'] as const).map((level) => `${counts.severities[level]} ${level}`)]
  return `${parts.join(', ')}, ${bytes(counts.unusedBytes)} unused`
}

function render(): void {
  const state = element('security-state')
  state.textContent = stateText()
  state.classList.toggle('measuring', scanning)
  element<HTMLButtonElement>('security-scan').disabled = scanning
  const scan = read?.scan
  element('security-summary').textContent = scan ? summaryText(scan) : ''
  element('security-tabs').replaceChildren(...(scan ? tabs(scan) : []))
  const content: HTMLElement[] = []
  if (read && !scan) content.push(node('p', 'No scan yet: Scan reads the packages and the images on the disk, or chade scan in a terminal.', 'empty'))
  if (scan) {
    const shown = scan.places.filter(matches)
    const malicious = shown.flatMap((place) => place.findings.filter((finding) => finding.malicious).map((finding) => ({ place, finding })))
    if (malicious.length > 0) content.push(section('Malicious, removed rather than updated', maliciousTable(malicious)))
    // The places with the most severe findings first, then the most of them.
    const exposed = shown.filter((place) => place.findings.some((finding) => !finding.malicious) || place.notes.length > 0)
    exposed.sort((a, b) => {
      for (const level of SEVERITIES) {
        const difference = b.findings.filter((one) => one.severity === level).length - a.findings.filter((one) => one.severity === level).length
        if (difference !== 0) return difference
      }
      return 0
    })
    content.push(section(`Vulnerabilities, ${exposed.length} place(s)`, ...(exposed.length > 0 ? exposed.map(placeItem) : [node('p', 'No known vulnerability', 'empty')])))
    const unused = shown.filter((place) => place.unused)
    if (unused.length > 0) content.push(section(`Unused, ${bytes(unused.reduce((sum, place) => sum + (place.bytes ?? 0), 0))}`, unusedTable(unused)))
    const uses = (scan.tools ?? []).filter((use) => system === undefined || use.system === system)
    if (uses.length > 0) content.push(section('Scanners', scannerList(uses)))
    const skipped = scan.skipped.filter((skip) => system === undefined || skip.system === system)
    if (skipped.length > 0) {
      const list = node('ul', '', 'skipped')
      list.append(...skipped.map((skip) => node('li', `${skip.system} ${skip.part}: ${skip.reason}`)))
      content.push(section('Skipped', list))
    }
  }
  element('security-content').replaceChildren(...content)
}

// A scan takes minutes, so it runs behind the page, which stays free to leave, and says when it is done.
function scanNow(): void {
  if (scanning) return
  scanning = true
  failure = undefined
  render()
  // The page that holds the views is told the outcome, to say it as it says any read or any failure.
  const done = (detail: { read?: Read; error?: unknown }): void => {
    scanning = false
    render()
    document.dispatchEvent(new CustomEvent('chade-measured', { detail }))
  }
  post<{ version: string } & Scan>('scan', {}).then(
    (scan) => {
      read = { version: scan.version, machine: scan.machine, scan, scannedAt: scan.date }
      done({ read })
    },
    (error: unknown) => {
      failure = `The scan failed: ${error instanceof Error ? error.message : String(error)}`
      done({ error })
    },
  )
}

function dated(value: Read): Read {
  return value.scan ? { ...value, scannedAt: value.scan.date } : value
}

element('security-scan').addEventListener('click', scanNow)
element<HTMLInputElement>('security-filter').addEventListener('input', (event) => {
  filter = (event.target as HTMLInputElement).value.trim()
  render()
})

// What chade scan found on the disk: vulnerable and malicious packages, and what nothing uses.
export const securityPage = {
  section: element('security'),
  title: (): string => 'Security',
  loaded: (): boolean => read !== undefined,
  clear: (): void => {
    read = undefined
  },
  age: (): string | undefined => (scanning ? 'Scanning…' : undefined),
  async show(): Promise<Read> {
    read ??= dated(await get<Read>('scan'))
    render()
    return read
  },
  // Read again when asked, as the scan of another terminal may have saved a new one, and never scanned by the page reading itself again.
  async reload(asked = false): Promise<Read | void> {
    if (!asked) return
    read = dated(await get<Read>('scan'))
    render()
    return read
  },
}
