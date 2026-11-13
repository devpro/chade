import type { Machine, SnapshotDetail, Store, StoredFile } from '@chade/daemon'
import { address, get } from './api.js'
import { parseDiff, type DiffFile } from './diff.js'
import { copyHash, element, node, svg } from './dom.js'
import { contentLines, counts, diffLines, fileHead, label, resizable, statusOf } from './files.js'
import { ago } from './format.js'

type Loaded = Store & { machine: string; version: string; scannedAt: string }

const PAGE = 300
const ROW = 28
const STATUSES: Record<string, DiffFile['status']> = { A: 'added', D: 'deleted', R: 'renamed', C: 'added', M: 'modified', T: 'modified' }

let loaded: Loaded | undefined
let limit = PAGE
// What the address names: a machine, one of its snapshots, the changes of that snapshot or every file of it, and one file.
let asked: { machine?: string; commit?: string; files: boolean; file?: string } = { files: false }
// A snapshot is a commit, which never changes, so what is read of one is asked once.
const details = new Map<string, SnapshotDetail>()
const trees = new Map<string, string[]>()
const contents = new Map<string, StoredFile>()

function cached<T>(cache: Map<string, T>, key: string, read: () => Promise<T>): Promise<T> {
  const known = cache.get(key)
  if (known !== undefined) return Promise.resolve(known)
  return read().then((value) => {
    cache.set(key, value)
    return value
  })
}

// The machine shown: the one the address names, the one the server runs on otherwise, or the first of the store.
function machineOf(current: Loaded): Machine | undefined {
  return current.machines.find((machine) => machine.name === asked.machine) ?? current.machines.find((machine) => machine.name === current.machine) ?? current.machines[0]
}

// The snapshot shown: the one the address names, the last one of the machine otherwise.
function snapshotOf(machine: Machine | undefined): string | undefined {
  return machine?.snapshots.find((snapshot) => snapshot.hash === asked.commit)?.hash ?? machine?.snapshots[0]?.hash
}

function go(values: { machine?: string; commit?: string; files?: boolean; file?: string }): void {
  location.hash = address({ page: 'store', machine: values.machine, commit: values.commit, view: values.files ? 'files' : undefined, file: values.file })
}

function renderMachines(current: Loaded, shown: Machine | undefined): void {
  const created: HTMLElement[] = [node('h3', 'Machines')]
  for (const machine of current.machines) {
    const here = machine.name === current.machine
    const item = node('button', '', `branch-item${here ? ' head' : ''}${machine === shown ? ' selected' : ''}`)
    item.append(node('span', machine.name, 'branch-name'), node('span', String(machine.snapshots.length) + (machine.more ? '+' : ''), 'track'))
    item.title = `${machine.name}${here ? ', the machine this page is served from' : ''}, ${machine.snapshots.length}${machine.more ? ' or more' : ''} snapshot${machine.snapshots.length === 1 ? '' : 's'}`
    item.addEventListener('click', () => go({ machine: machine.name }))
    created.push(item)
    for (const system of machine.systems) created.push(node('div', system, 'machine-system'))
  }
  element('store-machines').replaceChildren(...created)
}

function renderSnapshots(current: Loaded, machine: Machine | undefined, chosen: string | undefined): void {
  const created: HTMLElement[] = []
  if (current.error !== undefined) created.push(node('p', current.error, 'error'))
  else if (!machine) created.push(node('p', 'No snapshot yet. The chade snapshot command takes the first one.', 'empty'))
  const now = Date.now()
  machine?.snapshots.forEach((snapshot, index) => {
    const line = node('button', '', `commit-row${snapshot.hash === chosen ? ' selected' : ''}`)
    // The snapshots of a machine follow one another, drawn as the one line of history they are.
    const drawing = svg('svg', { width: 20, height: ROW, class: 'graph', 'aria-hidden': 'true' })
    const last = index === machine.snapshots.length - 1 && !machine.more
    drawing.append(svg('path', { d: `M 9 ${index === 0 ? ROW / 2 : 0} V ${last ? ROW / 2 : ROW}`, class: 'lane lane-0' }), svg('circle', { cx: 9, cy: ROW / 2, r: 4, class: 'dot lane-0' }))
    line.append(drawing, node('span', snapshot.subject, 'subject'), node('span', snapshot.author, 'author'), node('span', ago(snapshot.date, now), 'age'))
    line.title = `${snapshot.subject}, ${new Date(snapshot.date).toLocaleString()}`
    line.addEventListener('click', () => go({ machine: machine.name, commit: snapshot.hash, files: asked.files }))
    created.push(line)
  })
  if (machine?.more) {
    const more = node('button', `Show ${PAGE} older snapshots`, 'more')
    more.addEventListener('click', () => {
      limit += PAGE
      more.setAttribute('disabled', '')
      void store.reload().catch(() => more.removeAttribute('disabled'))
    })
    created.push(more)
  }
  element('store-snapshots').replaceChildren(...created)
}

// The files of a machine under the system they belong to, each named from the folder of that system.
function grouped<T extends { path: string }>(machine: string, files: T[]): Map<string, { file: T; name: string }[]> {
  const groups = new Map<string, { file: T; name: string }[]>()
  for (const file of files) {
    const [system, ...rest] = file.path.slice(machine.length + 1).split('/')
    // A file beside the folders of the systems belongs to none.
    const group = rest.length > 0 ? system : ''
    groups.set(group, [...(groups.get(group) ?? []), { file, name: rest.length > 0 ? rest.join('/') : system }])
  }
  return groups
}

function fileLists<T extends { path: string }>(machine: string, files: T[], entry: (file: T, name: string) => HTMLElement[], open: (path: string) => void): HTMLElement[] {
  const created: HTMLElement[] = []
  for (const [system, members] of grouped(machine, files)) {
    const list = node('ul', '', 'files index')
    for (const { file, name } of members) {
      const link = node('button', '', `file-link${asked.file === file.path ? ' selected' : ''}`)
      link.append(...entry(file, name))
      link.title = file.path
      link.addEventListener('click', () => open(file.path))
      const item = node('li')
      item.append(link)
      list.append(item)
    }
    created.push(node('h3', `${system || 'Machine'} (${members.length})`), list)
  }
  return created
}

const snapshotQuery = (machine: string, commit: string): Record<string, string> => ({ machine, commit })

// What stays the same between two renders tells whether an answer still has its place on the page.
const place = (): string => JSON.stringify(asked)

// A file as the snapshot holds it, in the Files view.
async function fileContent(machine: string, commit: string, path: string, close: () => void, name: HTMLElement): Promise<HTMLElement[]> {
  const file = await cached(contents, `${commit}\n${path}`, () => get<StoredFile>('snapshot-file', { ...snapshotQuery(machine, commit), path }))
  const created = [fileHead(close, name), ...(file.binary ? [node('p', 'Binary file, not shown.', 'empty')] : contentLines(file.content))]
  if (file.truncated) created.push(node('p', 'The file is too large to show in full, and stops here.', 'empty'))
  return created
}

// What the snapshot changed of a file, in the Changes view.
async function fileChanges(machine: string, commit: string, path: string, close: () => void, name: HTMLElement): Promise<HTMLElement[]> {
  const detail = await cached(details, commit, () => get<SnapshotDetail>('snapshot', snapshotQuery(machine, commit)))
  const file = parseDiff(detail.patch).find((candidate) => candidate.path === path)
  if (file) {
    name.textContent = label({ path: file.path.slice(machine.length + 1), from: file.from?.slice(machine.length + 1) })
    return [fileHead(close, statusOf(file.status), name, ...counts(file)), ...diffLines(file)]
  }
  const known = detail.changes.some((change) => change.path === path)
  return [fileHead(close, name), node('p', known ? 'The changes of this snapshot are too large to show those of this file. Files shows its content.' : 'This snapshot did not change this file.', 'empty')]
}

async function renderFile(machine: string, commit: string): Promise<void> {
  const view = element('store-file')
  const path = asked.file
  element('store-snapshots').hidden = path !== undefined
  view.hidden = path === undefined
  if (path === undefined) return view.replaceChildren()
  const at = place()
  const close = (): void => go({ machine, commit, files: asked.files })
  const name = node('span', path.slice(machine.length + 1), 'file-path')
  try {
    const created = asked.files ? await fileContent(machine, commit, path, close, name) : await fileChanges(machine, commit, path, close, name)
    if (at !== place()) return
    view.replaceChildren(...created)
    view.scrollTop = 0
  } catch (error) {
    if (at === place()) view.replaceChildren(fileHead(close, name), node('p', error instanceof Error ? error.message : String(error), 'error'))
  }
}

// The files of the snapshot in the Files view, or what it changed of them in the Changes view.
function snapshotFiles(machine: string, commit: string, detail: SnapshotDetail, tree: string[] | undefined): HTMLElement[] {
  const created: HTMLElement[] = []
  if (tree) {
    created.push(
      ...fileLists(
        machine,
        tree.map((path) => ({ path })),
        (_file, name) => [node('span', name, 'file-path')],
        (path) => go({ machine, commit, files: true, file: path }),
      ),
    )
  } else if (detail.changes.length === 0) created.push(node('p', 'This snapshot changed no file of the machine.', 'empty'))
  else {
    const patched = new Map(parseDiff(detail.patch).map((file) => [file.path, file]))
    created.push(
      ...fileLists(
        machine,
        detail.changes,
        (change, name) => {
          const file = patched.get(change.path)
          const from = change.from?.split('/').slice(2).join('/')
          return [statusOf(STATUSES[change.status] ?? 'modified'), node('span', label({ path: name, from }), 'file-path'), ...(file ? counts(file) : [])]
        },
        (path) => go({ machine, commit, file: path }),
      ),
    )
    if (detail.truncated) created.push(node('p', 'The changes are too large to show in full: the last files open without their lines.', 'empty'))
  }
  return created
}

async function renderDetail(current: Loaded, machine: Machine | undefined, commit: string | undefined): Promise<void> {
  const panel = element('store-detail')
  if (!machine || !commit) {
    element('store-snapshots').hidden = false
    element('store-file').hidden = true
    return panel.replaceChildren()
  }
  void renderFile(machine.name, commit)
  const at = place()
  try {
    const detail = await cached(details, commit, () => get<SnapshotDetail>('snapshot', snapshotQuery(machine.name, commit)))
    const tree = asked.files ? await cached(trees, commit, async () => (await get<{ files: string[] }>('snapshot-files', snapshotQuery(machine.name, commit))).files) : undefined
    if (at !== place()) return
    const [subject, ...body] = (detail.commit?.message ?? '').split('\n')
    const created: HTMLElement[] = [node('h2', subject)]
    if (body.join('\n').trim()) created.push(node('pre', body.join('\n').trim(), 'body'))
    const facts = node('p', '', 'facts')
    const hash = copyHash(commit)
    const before = machine.snapshots.find((snapshot) => snapshot.hash === detail.previous)
    const previous = before ? new Date(before.date).toLocaleString() : detail.previous?.slice(0, 10)
    const compared = detail.previous ? `Compared with the snapshot of ${previous}` : `First snapshot of ${machine.name}`
    facts.append(hash, node('span', detail.commit?.author ?? ''), node('span', detail.commit ? new Date(detail.commit.date).toLocaleString() : ''), node('span', compared))
    created.push(facts)
    const views = node('div', '', 'views')
    views.setAttribute('role', 'tablist')
    views.setAttribute('aria-label', 'What to list of the snapshot')
    const view = (text: string, title: string, files: boolean, count?: number): HTMLElement => {
      const tab = node('button', '', 'tab')
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(asked.files === files))
      tab.title = title
      tab.append(node('span', text))
      if (count !== undefined) tab.append(node('span', String(count), 'count'))
      tab.addEventListener('click', () => go({ machine: machine.name, commit, files }))
      return tab
    }
    views.append(view('Changes', 'What the snapshot changed since the one before', false, detail.changes.length), view('Files', 'Every file the machine had at the snapshot', true, tree?.length))
    created.push(views, ...snapshotFiles(machine.name, commit, detail, tree))
    panel.replaceChildren(...created)
  } catch (error) {
    if (at === place()) panel.replaceChildren(node('p', error instanceof Error ? error.message : String(error), 'error'))
  }
}

function render(current: Loaded): void {
  element('store-path').textContent = current.path
  const state = element('store-state')
  state.replaceChildren()
  if (current.repository) {
    const link = node('a', 'Open its repository', 'back') as HTMLAnchorElement
    link.href = address(current.repository)
    link.title = `${current.repository.path}, where a snapshot is pushed from`
    state.append(link)
  }
  const machine = machineOf(current)
  const commit = snapshotOf(machine)
  renderMachines(current, machine)
  renderSnapshots(current, machine, commit)
  void renderDetail(current, machine, commit)
}

resizable('store-resize', 'store-snapshots', 'store-file')

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && asked.file !== undefined && !store.section.hidden) go({ machine: asked.machine, commit: asked.commit, files: asked.files })
})

// The store: its machines, the snapshots of one, and what a snapshot changed or held.
export const store = {
  section: element('store'),
  title: (params: URLSearchParams): string => (params.get('machine') ? `${params.get('machine')}, store` : 'Store'),
  loaded: (): boolean => loaded !== undefined,
  clear: (): void => {
    loaded = undefined
  },
  async show(params: URLSearchParams): Promise<{ machine: string; version: string; scannedAt: string } | void> {
    asked = { machine: params.get('machine') ?? undefined, commit: params.get('commit') ?? undefined, files: params.get('view') === 'files', file: params.get('file') ?? undefined }
    if (!loaded) return this.reload()
    render(loaded)
  },
  async reload(): Promise<{ machine: string; version: string; scannedAt: string }> {
    loaded = await get<Loaded>('store', { limit: String(limit) })
    render(loaded)
    return loaded
  },
}
