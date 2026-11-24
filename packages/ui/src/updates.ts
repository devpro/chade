import type { Change, Dependency, InstalledTool, Inventory, Update } from '@chade/daemon'
// These modules alone, as the rest of the daemon is for Node and not for the page.
import { changeOf, toolOutdated, updatesOf } from '@chade/daemon/inventory'
import { address, get, keepAddress, post, route } from './api.js'
import { commandLine, element, node } from './dom.js'
import { ago } from './format.js'
import { chooseSystem, chosenSystem } from './systems.js'

interface Read {
  version: string
  machine: string
  inventory?: Inventory
  scannedAt?: string
}

type Tab = 'packages' | 'images' | 'tools' | 'problems'

const TABS: { id: Tab; name: string; title: string }[] = [
  { id: 'packages', name: 'Packages', title: 'The packages of npm and NuGet and the providers of Terraform that have a newer version' },
  { id: 'images', name: 'Images', title: 'The container images that have a newer tag, or a new image under the same tag' },
  { id: 'tools', name: 'Tools', title: 'The tools of the machine, those with a newer version first' },
  { id: 'problems', name: 'Unknown', title: 'The packages and images whose newest version is unknown, and why' },
]
// The chips: what fixes a vulnerability, then each size of change.
type Level = 'fixes' | Change
const LEVELS: Level[] = ['fixes', 'major', 'minor', 'patch', 'rebuilt']
const TONES: Record<Change, string> = { major: 'warn', minor: 'info', patch: 'quiet', rebuilt: 'quiet' }
const KINDS: Record<Dependency['kind'], string> = { npm: 'npm', nuget: 'NuGet', image: 'Image', terraform: 'Terraform' }
const SOURCES: Record<InstalledTool['source'], string> = { apt: 'apt', direct: 'Direct', nvm: 'nvm', npm: 'npm', winget: 'winget', repository: 'A repository' }

let read: Read | undefined
let checking = false
let failure: string | undefined
let tab: Tab = 'packages'
// No level chosen shows them all.
let level: Level | undefined
// The tools that are up to date show only when asked.
let allTools = false
let filter = ''
// The repository that the address names, when one page links to its updates.
let only: string | undefined
const opened = new Set<string>()

const has = (text: string): boolean => text.toLowerCase().includes(filter.toLowerCase())

function systems(inventory: Inventory): string[] {
  return [...new Set([...inventory.tools.map((one) => one.system), ...inventory.dependencies.map((one) => one.system)])]
}

function badge(text: string, tone: string): HTMLElement {
  return node('span', text, `badge ${tone}`)
}

function page(text: string, href: string | undefined): HTMLElement {
  if (!href?.startsWith('https://')) return node('span', text)
  const link = node('a', text) as HTMLAnchorElement
  link.href = href
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  return link
}

function table(titles: string[], rows: HTMLElement[]): HTMLElement {
  const created = node('table')
  const head = node('thead')
  const line = node('tr')
  line.append(...titles.map((title) => node('th', title)))
  head.append(line)
  const body = node('tbody')
  body.append(...rows)
  created.append(head, body)
  return created
}

function cell(className: string, ...content: (Node | string)[]): HTMLElement {
  const created = node('td', '', className)
  created.append(...content)
  return created
}

function row(...cells: HTMLElement[]): HTMLElement {
  const created = node('tr')
  created.append(...cells)
  return created
}

function toolsOf(inventory: Inventory, system: string | undefined): InstalledTool[] {
  return inventory.tools.filter((tool) => tool.system === system && (has(tool.name) || has(tool.path ?? '') || has(tool.package ?? '')))
}

const levelMatches = (update: Update): boolean => level === undefined || (level === 'fixes' ? update.fixes > 0 : update.change === level)

// The updates of the system, with only the places that the filter names, unless it names the package.
function updatesIn(inventory: Inventory, system: string | undefined, kind: 'packages' | 'images'): Update[] {
  const uses = inventory.dependencies.filter(
    (one) => one.system === system && (one.kind === 'image') === (kind === 'images') && (only === undefined || one.repository === only) && (has(one.name) || has(one.repositoryName) || has(one.file)),
  )
  return updatesOf(uses)
}

function useLine(use: Dependency): HTMLElement {
  const line = node('li')
  const repository = node('a', use.repositoryName) as HTMLAnchorElement
  repository.href = address({ system: use.system, path: use.repository })
  line.append(repository, node('span', use.file, 'use-file'), node('span', use.current, 'version'))
  if (use.command) line.append(commandLine(use.command))
  if (use.replace) line.append(commandLine(use.replace))
  return line
}

function updateText(update: Update): string {
  const from = [...new Set(update.uses.map((use) => use.current))].join(', ')
  return update.change === 'rebuilt' ? `${from}, with a new image` : `${from} → ${update.latest}`
}

function updateItem(update: Update): HTMLElement {
  const details = node('details', '', 'place update') as HTMLDetailsElement
  const key = `${update.kind}\n${update.name}\n${update.latest ?? ''}\n${update.change}`
  const summary = node('summary')
  const main = node('span', '', 'place-main')
  const used = new Set(update.uses.map((use) => use.repository)).size
  const meta = [KINDS[update.kind], used === 1 ? update.uses[0].repositoryName : `${used} repositories`]
  if (update.date) meta.push(`released ${ago(update.date, Date.now())}`)
  main.append(node('span', update.name, 'place-label'), node('span', updateText(update), 'version'), node('span', meta.join(' · '), 'place-meta'))
  const facts = node('span', '', 'place-facts')
  if (update.fixes > 0) facts.append(badge(update.fixes === 1 ? 'fixes 1 vulnerability' : `fixes ${update.fixes} vulnerabilities`, 'bad'))
  facts.append(badge(update.change, TONES[update.change]))
  summary.append(main, facts)
  details.append(summary)
  // The places are drawn when the update is opened, as there can be hundreds of updates.
  details.addEventListener('toggle', () => {
    if (!details.open) {
      opened.delete(key)
      return
    }
    opened.add(key)
    if (details.querySelector('.uses')) return
    const list = node('ul', '', 'uses')
    list.append(...update.uses.map(useLine))
    details.append(list)
  })
  if (opened.has(key)) details.open = true
  return details
}

function toolRow(tool: InstalledTool): HTMLElement {
  const name = cell('', node('strong', tool.name))
  if (tool.shadowed) name.append(' ', badge('another copy runs', 'warn'))
  if (tool.note) name.append(node('div', tool.note, 'tool-note'))
  const latest = cell('version', tool.latest === undefined ? '' : page(tool.latest, tool.url))
  if (toolOutdated(tool) && tool.version && tool.latest) latest.append(' ', badge(changeOf(tool.version, tool.latest), TONES[changeOf(tool.version, tool.latest)]))
  const update = cell('')
  if (toolOutdated(tool) && tool.command) update.append(commandLine(tool.command))
  else if (toolOutdated(tool) && tool.url) update.append(page('Release page', tool.url))
  const source = cell('', SOURCES[tool.source], node('div', tool.package ?? tool.path ?? '', 'path'))
  return row(name, cell('version', tool.version ?? ''), latest, source, update)
}

function toolTable(tools: InstalledTool[]): HTMLElement {
  return table(['Tool', 'Version', 'Newest', 'Source', 'Update'], tools.map(toolRow))
}

function aptLines(inventory: Inventory, system: string | undefined): HTMLElement[] {
  return inventory.apt
    .filter((apt) => apt.system === system)
    .map((apt) => {
      const lists = apt.date ? `, as the package lists of ${ago(apt.date, Date.now())} say` : ''
      return node('p', `${apt.upgradable} apt ${apt.upgradable === 1 ? 'package' : 'packages'} to upgrade${lists}`, 'apt-line')
    })
}

function shownTools(inventory: Inventory, system: string | undefined): InstalledTool[] {
  const tools = toolsOf(inventory, system)
  const outdated = tools.filter(toolOutdated)
  return allTools ? [...outdated, ...tools.filter((tool) => !toolOutdated(tool))] : outdated
}

function empty(text: string): HTMLElement {
  return node('p', filter || level ? 'Nothing here with these filters' : text, 'empty')
}

function toolsContent(inventory: Inventory, system: string | undefined): HTMLElement[] {
  const tools = shownTools(inventory, system)
  return [...aptLines(inventory, system), tools.length > 0 ? toolTable(tools) : empty('Every tool is up to date')]
}

function updatesContent(inventory: Inventory, system: string | undefined, kind: 'packages' | 'images'): HTMLElement[] {
  const updates = updatesIn(inventory, system, kind).filter(levelMatches)
  return updates.length > 0 ? updates.map(updateItem) : [empty(kind === 'images' ? 'Every image is up to date' : 'Every package is up to date')]
}

const problemsOf = (inventory: Inventory, system: string | undefined) => inventory.problems.filter((problem) => problem.system === undefined || problem.system === system)

function problemList(inventory: Inventory, system: string | undefined): HTMLElement[] {
  const problems = problemsOf(inventory, system)
  if (problems.length === 0) return [node('p', 'Nothing is unknown', 'empty')]
  const list = node('ul', '', 'skipped')
  list.append(...problems.map((problem) => node('li', `${problem.subject}: ${problem.reason}`)))
  return [list]
}

function renderTabs(inventory: Inventory, system: string | undefined): void {
  const counts: Record<Tab, number> = {
    packages: updatesIn(inventory, system, 'packages').length,
    images: updatesIn(inventory, system, 'images').length,
    tools: toolsOf(inventory, system).filter(toolOutdated).length,
    problems: problemsOf(inventory, system).length,
  }
  const tabs = TABS.filter(({ id }) => id !== 'problems' || counts.problems > 0 || tab === 'problems').map(({ id, name, title }) => {
    const created = node('button', '', 'tab')
    created.setAttribute('role', 'tab')
    created.setAttribute('aria-selected', String(id === tab))
    created.title = title
    created.append(node('span', name), node('span', String(counts[id]), 'count'))
    created.addEventListener('click', () => {
      tab = id
      level = undefined
      render()
    })
    return created
  })
  element('updates-tabs').replaceChildren(...tabs)
}

function levelChips(updates: Update[]): HTMLElement {
  const group = node('div', '', 'chips')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Change')
  for (const one of LEVELS) {
    const count = updates.filter((update) => (one === 'fixes' ? update.fixes > 0 : update.change === one)).length
    if (count === 0 && level !== one) continue
    const tone = one === 'fixes' ? 'bad' : TONES[one]
    const chip = toggle(one === 'fixes' ? 'fixes a vulnerability' : one, level === one, `chip ${tone}`, () => (level = level === one ? undefined : one))
    chip.append(node('span', String(count), 'chip-count'))
    group.append(chip)
  }
  return group
}

function toggle(text: string, pressed: boolean, className: string, onClick: () => void): HTMLElement {
  const button = node('button', text, className) as HTMLButtonElement
  button.type = 'button'
  button.setAttribute('aria-pressed', String(pressed))
  button.addEventListener('click', () => {
    onClick()
    render()
  })
  return button
}

function renderToggles(inventory: Inventory, all: string[], system: string | undefined): void {
  const groups: HTMLElement[] = []
  if (all.length > 1) {
    const group = node('div', '', 'segmented')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'System')
    group.append(...all.map((name) => toggle(name, name === system, 'segment', () => chooseSystem(name))))
    groups.push(group)
  }
  if (tab === 'packages' || tab === 'images') groups.push(levelChips(updatesIn(inventory, system, tab)))
  if (tab === 'tools') groups.push(toggle('Also up to date', allTools, 'chip quiet', () => (allTools = !allTools)))
  // The one repository shown, which a click lets go.
  if (only !== undefined && (tab === 'packages' || tab === 'images')) groups.push(toggle(`${only.split(/[\\/]/).findLast(Boolean)} ✕`, true, 'chip quiet', () => (only = undefined)))
  element('updates-toggles').replaceChildren(...groups)
}

function stateText(): string {
  if (checking) return 'Asking the registries, which takes a minute or more…'
  if (failure) return failure
  if (!read) return ''
  return read.inventory ? `Checked ${new Date(read.inventory.date).toLocaleString()}` : 'Never checked'
}

const EMPTY: Inventory = { machine: '', date: '', tools: [], dependencies: [], apt: [], problems: [] }

function render(): void {
  const state = element('updates-state')
  state.textContent = stateText()
  state.classList.toggle('measuring', checking)
  element<HTMLButtonElement>('updates-run').disabled = checking
  if (!read) return
  const inventory = read.inventory ?? EMPTY
  const all = systems(inventory)
  const system = chosenSystem(all)
  // A check that ends after the page was left must not change the address of another page.
  if (route().get('page') === 'updates') keepAddress({ page: 'updates', system, tab, change: level, repository: only })
  renderTabs(inventory, system)
  renderToggles(inventory, all, system)
  const content: HTMLElement[] = []
  if (!read.inventory) content.push(node('p', 'No inventory yet: Check makes one, or chade inventory in a terminal.', 'empty'))
  else if (tab === 'tools') content.push(...toolsContent(inventory, system))
  else if (tab === 'problems') content.push(...problemList(inventory, system))
  else content.push(...updatesContent(inventory, system, tab))
  element('updates-content').replaceChildren(...content)
}

function dated(value: Read): Read {
  return value.inventory ? { ...value, scannedAt: value.inventory.date } : value
}

// The registries take their time, so the check runs behind the page, which stays free to leave.
function checkNow(): void {
  if (checking) return
  checking = true
  failure = undefined
  render()
  const done = (detail: { read?: Read; error?: unknown }): void => {
    checking = false
    render()
    document.dispatchEvent(new CustomEvent('chade-measured', { detail }))
  }
  post<{ version: string } & Inventory>('inventory', {}).then(
    (inventory) => {
      read = { version: inventory.version, machine: inventory.machine, inventory, scannedAt: inventory.date }
      done({ read })
    },
    (error: unknown) => {
      failure = `The check failed: ${error instanceof Error ? error.message : String(error)}`
      done({ error })
    },
  )
}

async function readAll(): Promise<Read> {
  read = dated(await get<Read>('inventory'))
  render()
  return read
}

element('updates-run').addEventListener('click', checkNow)
element<HTMLInputElement>('updates-filter').addEventListener('input', (event) => {
  filter = (event.target as HTMLInputElement).value.trim()
  render()
})

// What has a newer version: the packages, the images and the tools.
export const updatesPage = {
  section: element('updates'),
  title: (): string => 'Updates',
  loaded: (): boolean => read !== undefined,
  clear: (): void => {
    read = undefined
  },
  age: (): string | undefined => (checking ? 'Checking…' : undefined),
  async show(params: URLSearchParams): Promise<Read> {
    // The address gives the tab and the filters: none in the address is none on the page.
    only = params.get('repository') ?? undefined
    const system = params.get('system')
    if (system) chooseSystem(system)
    const asked = TABS.find(({ id }) => id === params.get('tab'))?.id
    tab = asked ?? 'packages'
    level = LEVELS.find((one) => one === params.get('change'))
    const value = await readAll()
    // Without a tab in the address, a repository opens on the part that it has updates in.
    if (only !== undefined && asked === undefined && value.inventory && updatesIn(value.inventory, system ?? undefined, 'packages').length === 0) {
      tab = 'images'
      render()
    }
    return value
  },
  // Read again when asked. The page that reads itself again does not change what is open.
  async reload(asked = false): Promise<Read | void> {
    if (asked) return readAll()
  },
}
