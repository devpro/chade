// The scan module alone, as the rest of the daemon is for Node and not for the page.
import { packagesOf, SEVERITIES, type Finding, type PackageFindings, type Place, type PlaceKind, type Scan, type Severity, type ToolUse } from '@chade/daemon/scan'
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

// A malicious package is a level of its own, above critical, as no update fixes it.
type Level = 'malicious' | Severity
type Tab = PlaceKind | 'scanners'

const LEVELS: Level[] = ['malicious', ...SEVERITIES]
const TONES: Record<Level, string> = { malicious: 'bad', critical: 'bad', high: 'warn', medium: 'info', low: 'quiet', unknown: 'quiet' }
// The kind of a place is its tab, so a place never repeats it.
const KINDS: { kind: PlaceKind; name: string; title: string }[] = [
  { kind: 'repository', name: 'Repositories', title: 'Installed in a repository: node_modules, .terraform, .venv, restored .NET projects' },
  { kind: 'machine', name: 'Installed', title: 'Installed for the user: global npm and pnpm packages, each Node.js of nvm, pipx, dotnet tools, Go binaries' },
  { kind: 'cache', name: 'Caches', title: 'The npx cache, the NuGet cache, the Terraform plugin cache' },
  { kind: 'image', name: 'Images', title: 'The container images Docker holds' },
]

let read: Read | undefined
let scanning = false
let failure: string | undefined
let system: string | undefined
let tab: Tab | undefined
let levels = new Set<Level>(LEVELS)
let unusedOnly = false
let filter = ''
// The places left open stay open as the filters change.
const opened = new Set<string>()

const levelOf = (finding: Finding): Level => (finding.malicious ? 'malicious' : finding.severity)
const keyOf = (place: Place): string => `${place.system}\n${place.path}`
const allLevels = (): boolean => levels.size === LEVELS.length

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

function commandLine(command: string): HTMLElement {
  const line = node('span', '', 'command')
  line.append(node('code', command), copyButton(command))
  return line
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

function toggle(text: string, pressed: boolean, title: string, onClick: () => void, className = 'chip'): HTMLElement {
  const button = node('button', '', className) as HTMLButtonElement
  button.type = 'button'
  button.title = title
  button.setAttribute('aria-pressed', String(pressed))
  button.append(text)
  button.addEventListener('click', () => {
    onClick()
    render()
  })
  return button
}

// The system is said only when the places of several systems are listed together.
function showsSystem(scan: Scan): boolean {
  return system === undefined && new Set(scan.places.map((place) => place.system)).size > 1
}

function labelMatches(place: Place): boolean {
  return filter === '' || place.label.toLowerCase().includes(filter.toLowerCase())
}

function findingMatches(finding: Finding): boolean {
  const text = filter.toLowerCase()
  return finding.package.toLowerCase().includes(text) || finding.ids.some((id) => id.toLowerCase().includes(text))
}

// The findings of a place the filters keep: those of the chosen levels, all of them when the filter names the place, else those it names.
function textFindings(place: Place): Finding[] {
  return labelMatches(place) ? place.findings : place.findings.filter(findingMatches)
}

function shownFindings(place: Place): Finding[] {
  return textFindings(place).filter((finding) => levels.has(levelOf(finding)))
}

// The places of a tab before the levels, which the counts of the levels are taken from.
function inScope(scan: Scan, kind: PlaceKind): Place[] {
  return scan.places.filter((place) => place.kind === kind && (system === undefined || place.system === system) && (!unusedOnly || place.unused))
}

// A place shows with a finding of the chosen levels, or, every level chosen, with a note such as an operating system past its end of life.
function shownPlaces(scan: Scan, kind: PlaceKind): Place[] {
  return inScope(scan, kind).filter((place) => shownFindings(place).length > 0 || (allLevels() && place.notes.length > 0 && labelMatches(place)))
}

function levelCounts(findings: Finding[]): Record<Level, number> {
  const counts: Record<Level, number> = { malicious: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  for (const finding of findings) counts[levelOf(finding)]++
  return counts
}

function levelBadges(findings: Finding[]): HTMLElement[] {
  const counts = levelCounts(findings)
  return LEVELS.filter((level) => counts[level] > 0).map((level) => badge(`${counts[level]} ${level}`, TONES[level]))
}

function fixText(group: PackageFindings): string {
  if (group.findings.some((finding) => finding.malicious)) return 'remove it'
  if (!group.fixed) return 'no fix yet'
  return group.unfixed > 0 ? `update to ${group.fixed}, ${group.unfixed} without fix` : `update to ${group.fixed}`
}

// One row for each version of a package, as one update fixes all its advisories.
function packageRow(group: PackageFindings, place: Place): HTMLElement {
  const row = node('tr')
  const level = node('td', '', 'level')
  level.append(badge(levelOf(group.findings[0]), TONES[levelOf(group.findings[0])]))
  const fix = node('td', fixText(group), group.fixed && !group.findings[0].malicious ? 'fix' : 'fix none')
  const advisories = node('td', '', 'advisories')
  // The level of each advisory says something only beside advisories of other levels.
  const mixed = new Set(group.findings.map(levelOf)).size > 1
  for (const finding of group.findings) {
    const line = node('div', '', 'advisory-line')
    if (mixed) line.append(node('span', levelOf(finding), `level-text ${TONES[levelOf(finding)]}`))
    const summary = node('span', finding.summary, 'summary')
    summary.title = finding.summary
    line.append(advisory(finding.ids[0]), summary)
    // A finding some scanners missed is named with those that saw it, as one alone is often an advisory the others do not know yet.
    if (place.tools.some((tool) => !finding.tools.includes(tool))) {
      const tools = node('span', `only ${finding.tools.join(', ')}`, 'tools')
      tools.title = `Found by ${finding.tools.join(', ')}, of the scanners that read the place: ${place.tools.join(', ')}`
      line.append(tools)
    }
    advisories.append(line)
  }
  row.append(level, node('td', `${group.package} ${group.version}`, 'package'), fix, advisories)
  return row
}

function findingsTable(place: Place): HTMLElement {
  const table = node('table', '', 'findings')
  const head = node('thead')
  const titles = node('tr')
  titles.append(...['Level', 'Package', 'Fix', 'Advisories'].map((title) => node('th', title)))
  head.append(titles)
  const body = node('tbody')
  body.append(...packagesOf(shownFindings(place)).map((group) => packageRow(group, place)))
  table.append(head, body)
  return table
}

// A place nothing uses is removed rather than updated, which ends every finding in it at once.
function cleanBox(place: Place, unused: NonNullable<Place['unused']>): HTMLElement {
  const box = node('div', '', 'clean')
  const size = place.bytes === undefined ? '' : `, ${bytes(place.bytes)}`
  box.append(node('p', `Nothing uses it: ${unused.reason}. Removing it ends its ${place.findings.length} finding(s)${size}.`), commandLine(unused.command))
  return box
}

function placeItem(place: Place, scan: Scan): HTMLElement {
  const details = node('details', '', 'place') as HTMLDetailsElement
  const key = keyOf(place)
  const summary = node('summary')
  const main = node('span', '', 'place-main')
  main.append(node('span', place.label, 'place-label'))
  const meta: string[] = []
  if (showsSystem(scan)) meta.push(place.system)
  if (place.packages > 0) meta.push(`${place.packages} packages`)
  if (meta.length > 0) main.append(node('span', meta.join(' · '), 'place-meta'))
  // A note, such as a system past its end of life, says more than any one finding, so it shows with the place closed.
  main.append(...place.notes.map((note) => node('span', note, 'note')))
  const facts = node('span', '', 'place-facts')
  facts.append(...levelBadges(shownFindings(place)))
  if (place.unused) facts.append(badge(place.bytes === undefined ? 'unused' : `unused · ${bytes(place.bytes)}`, 'unused', `Nothing uses it: ${place.unused.reason}`))
  summary.append(main, facts)
  details.append(summary)
  // The findings are drawn when the place is opened, as an image alone can have thousands.
  details.addEventListener('toggle', () => {
    if (!details.open) {
      opened.delete(key)
      return
    }
    opened.add(key)
    if (details.querySelector('table')) return
    if (place.unused) details.append(cleanBox(place, place.unused))
    if (shownFindings(place).length > 0) details.append(findingsTable(place))
  })
  if (opened.has(key)) details.open = true
  return details
}

// The places with the most severe findings first, then the most of them.
function bySeverity(a: Place, b: Place): number {
  const left = levelCounts(shownFindings(a))
  const right = levelCounts(shownFindings(b))
  for (const level of LEVELS) if (left[level] !== right[level]) return right[level] - left[level]
  return a.label.localeCompare(b.label)
}

// A malicious package may have run at its install, so each shows above every tab, with where it lies, the place to remove it from.
function maliciousAlert(scan: Scan): HTMLElement[] {
  const found = scan.places
    .filter((place) => system === undefined || place.system === system)
    .flatMap((place) => place.findings.filter((finding) => finding.malicious).map((finding) => ({ place, finding })))
  if (found.length === 0) return []
  const alert = node('section', '', 'alert')
  alert.setAttribute('role', 'alert')
  alert.append(node('h3', `${found.length} malicious package(s): removed rather than updated, as they may have run at their install, and the machine looked at`))
  const list = node('ul')
  for (const { place, finding } of found) {
    const item = node('li')
    const where = showsSystem(scan) ? `${place.label}, ${place.system}` : place.label
    item.append(node('span', `${finding.package} ${finding.version}`, 'package'), advisory(finding.ids[0]), node('span', `in ${where}`, 'place-label'))
    list.append(item)
  }
  alert.append(list)
  return [alert]
}

function tabButton(name: string, value: Tab, selected: Tab, count: string, title: string, tone = ''): HTMLElement {
  const created = node('button', '', 'tab')
  created.setAttribute('role', 'tab')
  created.setAttribute('aria-selected', String(selected === value))
  created.title = title
  created.append(node('span', name))
  if (count) created.append(node('span', count, `count ${tone}`.trim()))
  created.addEventListener('click', () => {
    tab = value
    render()
  })
  return created
}

function tabs(scan: Scan, selected: Tab): HTMLElement[] {
  const kinds = KINDS.filter(({ kind }) => scan.places.some((place) => place.kind === kind))
  const problems = (scan.tools ?? []).filter((use) => use.problem).length + scan.skipped.length
  return [
    ...kinds.map(({ kind, name, title }) => tabButton(name, kind, selected, String(shownPlaces(scan, kind).length), title)),
    tabButton('Scanners', 'scanners', selected, problems > 0 ? String(problems) : '', 'The scanners of each system with their versions, and the parts skipped', 'warn'),
  ]
}

// The first tab with something to show, until one is chosen.
function chosenTab(scan: Scan): Tab {
  if (tab !== undefined) return tab
  const kinds = KINDS.map(({ kind }) => kind).filter((kind) => scan.places.some((place) => place.kind === kind))
  return kinds.find((kind) => shownPlaces(scan, kind).length > 0) ?? kinds[0] ?? 'scanners'
}

// The first level clicked with every level shown shows that level alone, the way a level is looked at, and the others then add to it.
function chooseLevel(level: Level): void {
  if (allLevels()) levels = new Set([level])
  else if (levels.has(level)) levels.delete(level)
  else levels.add(level)
  if (levels.size === 0) levels = new Set(LEVELS)
}

function toggles(scan: Scan, kind: Tab): HTMLElement[] {
  const groups: HTMLElement[] = []
  const systems = [...new Set(scan.places.map((place) => place.system))]
  if (systems.length > 1) {
    const group = node('div', '', 'segmented')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'System')
    group.append(...[undefined, ...systems].map((name) => toggle(name ?? 'All systems', system === name, name ? `Only ${name}` : 'Every system of the machine', () => (system = name), 'segment')))
    groups.push(group)
  }
  if (kind === 'scanners') return groups
  const counts = levelCounts(inScope(scan, kind).flatMap(textFindings))
  const group = node('div', '', 'chips')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Level')
  for (const level of LEVELS) {
    const shown = !allLevels() && levels.has(level)
    const title = allLevels() ? `Only ${level}` : `${shown ? 'Hide' : 'Show'} ${level}`
    const chip = toggle(level, shown, title, () => chooseLevel(level), `chip ${TONES[level]}${counts[level] === 0 ? ' zero' : ''}`)
    chip.append(node('span', String(counts[level]), 'chip-count'))
    group.append(chip)
  }
  const unused = scan.places.filter((place) => place.kind === kind && place.unused && (system === undefined || place.system === system)).length
  const unusedChip = toggle('unused', unusedOnly, 'Only what nothing uses, removed rather than updated', () => (unusedOnly = !unusedOnly), 'chip unused')
  unusedChip.append(node('span', String(unused), 'chip-count'))
  group.append(unusedChip)
  groups.push(group)
  return groups
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

function scannersContent(scan: Scan): HTMLElement[] {
  const content: HTMLElement[] = []
  const uses = (scan.tools ?? []).filter((use) => system === undefined || use.system === system)
  if (uses.length > 0) content.push(scannerList(uses))
  const skipped = scan.skipped.filter((skip) => system === undefined || skip.system === system)
  if (skipped.length > 0) {
    const list = node('ul', '', 'skipped')
    list.append(...skipped.map((skip) => node('li', `${skip.system} ${skip.part}: ${skip.reason}`)))
    content.push(node('h3', 'Skipped'), list)
  }
  return content.length > 0 ? content : [node('p', 'No scanner ran', 'empty')]
}

function placesContent(scan: Scan, kind: PlaceKind): HTMLElement[] {
  const places = shownPlaces(scan, kind).sort(bySeverity)
  if (places.length > 0) return places.map((place) => placeItem(place, scan))
  const filtered = !allLevels() || unusedOnly || filter !== ''
  return [node('p', filtered ? 'Nothing here with these filters' : 'No known vulnerability', 'empty')]
}

function stateText(): string {
  if (scanning) return 'Scanning the disk, which takes minutes…'
  if (failure) return failure
  if (!read) return ''
  return read.scan ? `Scanned ${new Date(read.scan.date).toLocaleString()}` : 'Never scanned'
}

function render(): void {
  const state = element('security-state')
  state.textContent = stateText()
  state.classList.toggle('measuring', scanning)
  element<HTMLButtonElement>('security-scan').disabled = scanning
  const scan = read?.scan
  const kind = scan ? chosenTab(scan) : undefined
  element('security-alert').replaceChildren(...(scan ? maliciousAlert(scan) : []))
  element('security-tabs').replaceChildren(...(scan && kind ? tabs(scan, kind) : []))
  element('security-filters').hidden = !scan
  element('security-toggles').replaceChildren(...(scan && kind ? toggles(scan, kind) : []))
  element('security-filter').hidden = kind === 'scanners'
  const content: HTMLElement[] = []
  if (read && !scan) content.push(node('p', 'No scan yet: Scan reads the packages and the images on the disk, or chade scan in a terminal.', 'empty'))
  if (scan && kind) content.push(...(kind === 'scanners' ? scannersContent(scan) : placesContent(scan, kind)))
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

// What chade scan found on the disk: vulnerable and malicious packages, by the kind of place they lie in.
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
