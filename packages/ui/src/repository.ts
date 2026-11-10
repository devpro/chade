import type { Branch, Commit, Detail, Diff, FileChange } from '@chade/daemon'
import { address, get } from './api.js'
import { parseDiff, type DiffFile } from './diff.js'
import { element, node, svg } from './dom.js'
import { ago, changes, sync } from './format.js'
import { layout, type GraphRow } from './graph.js'
import { badges } from './list.js'

type Loaded = Detail & { machine: string; version: string; scannedAt: string }

// What the changes panel shows: the working tree, or a commit by its hash.
const WORKING_TREE = 'working-tree'
const PAGE = 300
const LANE = 14
const ROW = 28
const LANES_SHOWN = 12
// A file of more lines than this is cut, as a page of that length no longer scrolls.
const MAX_LINES = 10_000

let detail: Loaded | undefined
let key = ''
let limit = PAGE
let target: string | undefined
// The file whose changes take the place of the history, and the commit or the part of the working tree they are read from.
let shownFile: { path: string; from: string } | undefined
// The patch of a commit never changes, so it is asked once.
const patches = new Map<string, Diff>()
const rows = new Map<string, HTMLElement>()

function graphCell(row: GraphRow, width: number, merge: boolean): SVGElement {
  const x = (lane: number) => lane * LANE + LANE / 2 + 2
  const middle = ROW / 2
  const drawing = svg('svg', { width, height: ROW, class: 'graph', 'aria-hidden': 'true' })
  const line = (lane: number, path: string) => drawing.append(svg('path', { d: path, class: `lane lane-${lane % 8}` }))
  for (const lane of row.through) line(lane, `M ${x(lane)} 0 V ${ROW}`)
  for (const [from, to] of row.moved) line(to, `M ${x(from)} 0 C ${x(from)} ${ROW}, ${x(to)} 0, ${x(to)} ${ROW}`)
  for (const lane of row.into) {
    line(lane, lane === row.column ? `M ${x(lane)} 0 V ${middle}` : `M ${x(lane)} 0 C ${x(lane)} ${middle}, ${x(row.column)} 0, ${x(row.column)} ${middle}`)
  }
  for (const lane of row.out) {
    line(lane, lane === row.column ? `M ${x(lane)} ${middle} V ${ROW}` : `M ${x(row.column)} ${middle} C ${x(row.column)} ${ROW}, ${x(lane)} ${middle}, ${x(lane)} ${ROW}`)
  }
  drawing.append(svg('circle', { cx: x(row.column), cy: middle, r: merge ? 3 : 4, class: `dot lane-${row.column % 8}${merge ? ' merge' : ''}` }))
  return drawing
}

function refBadges(commit: Commit, branches: Branch[]): HTMLElement[] {
  return commit.refs
    .filter((ref) => !/\/HEAD$/.test(ref))
    .map((ref) => {
      if (ref.startsWith('tag: ')) return node('span', ref.slice('tag: '.length), 'ref tag')
      if (ref.startsWith('HEAD -> ')) return node('span', ref.slice('HEAD -> '.length), 'ref head')
      if (ref === 'HEAD') return node('span', 'HEAD', 'ref head')
      return node('span', ref, branches.some((branch) => branch.remote && branch.name === ref) ? 'ref remote' : 'ref local')
    })
}

function choose(chosen: string): void {
  if (!detail) return
  location.hash = address({ system: detail.repository.system, path: detail.repository.path, commit: chosen })
}

function renderHistory(current: Loaded): void {
  const history = element('history')
  rows.clear()
  const created: HTMLElement[] = []
  const graph = layout(current.commits)
  const width = Math.min(Math.max(1, ...graph.map((row) => row.width)), LANES_SHOWN) * LANE + 6
  if (current.changes.length > 0) {
    // A line of the history like the commits, as the commit to come: a hollow dot, tied to the commit checked out when that one is the next line.
    const working = node('button', '', 'commit-row working-tree')
    const onHead = current.commits[0]?.refs.some((ref) => ref === 'HEAD' || ref.startsWith('HEAD -> ')) ?? false
    const drawing = svg('svg', { width, height: ROW, class: 'graph', 'aria-hidden': 'true' })
    const x = (onHead ? graph[0].column : 0) * LANE + LANE / 2 + 2
    if (onHead) drawing.append(svg('path', { d: `M ${x} ${ROW / 2} V ${ROW}`, class: 'lane pending' }))
    drawing.append(svg('circle', { cx: x, cy: ROW / 2, r: 4, class: 'dot pending' }))
    const files = `${current.changes.length} file${current.changes.length === 1 ? '' : 's'}`
    working.append(drawing, node('span', 'Uncommitted changes', 'subject'), node('span', '', 'author'), node('span', files, 'age'))
    working.addEventListener('click', () => choose(WORKING_TREE))
    rows.set(WORKING_TREE, working)
    created.push(working)
  }
  const now = Date.now()
  current.commits.forEach((commit, index) => {
    const line = node('button', '', 'commit-row')
    const text = node('span', '', 'subject')
    text.append(...refBadges(commit, current.branches), commit.subject)
    line.append(graphCell(graph[index], width, commit.parents.length > 1), text, node('span', commit.author, 'author'), node('span', ago(commit.date, now), 'age'))
    line.title = commit.subject
    line.addEventListener('click', () => choose(commit.hash))
    rows.set(commit.hash, line)
    created.push(line)
  })
  if (current.commits.length === 0 && current.repository.error === undefined) created.push(node('p', 'No commit yet.', 'empty'))
  if (current.repository.error !== undefined) created.push(node('p', current.repository.error, 'error'))
  if (current.more) {
    const more = node('button', `Show ${PAGE} older commits`, 'more')
    more.addEventListener('click', () => {
      limit += PAGE
      more.setAttribute('disabled', '')
      void repository.reload().catch(() => more.removeAttribute('disabled'))
    })
    created.push(more)
  }
  history.replaceChildren(...created)
}

function renderBranches(current: Loaded): void {
  const group = (title: string, branches: Branch[]): HTMLElement[] => {
    if (branches.length === 0) return []
    const items = branches.map((branch) => {
      const item = node('button', '', `branch-item${branch.head ? ' head' : ''}`)
      item.append(node('span', branch.name, 'branch-name'))
      if (branch.gone) item.append(node('span', 'gone', 'track warn'))
      if (branch.ahead) item.append(node('span', `↑${branch.ahead}`, 'track info'))
      if (branch.behind) item.append(node('span', `↓${branch.behind}`, 'track warn'))
      item.title = branch.upstream ? `${branch.name}, tracking ${branch.upstream}` : branch.name
      item.addEventListener('click', () => choose(branch.commit))
      return item
    })
    return [node('h3', title), ...items]
  }
  element('branches').replaceChildren(
    ...group(
      'Local',
      current.branches.filter((branch) => !branch.remote),
    ),
    ...group(
      'Remote',
      current.branches.filter((branch) => branch.remote),
    ),
  )
}

const STATUS: Record<string, string> = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' }

const label = (file: { path: string; from?: string }): string => (file.from ? `${file.from} → ${file.path}` : file.path)

function statusOf(file: DiffFile): HTMLElement {
  const status = node('span', STATUS[file.status], `status ${file.status}`)
  status.title = file.status
  return status
}

function counts(file: DiffFile): HTMLElement[] {
  const created: HTMLElement[] = []
  if (file.additions > 0) created.push(node('span', `+${file.additions}`, 'additions'))
  if (file.deletions > 0) created.push(node('span', `−${file.deletions}`, 'deletions'))
  return created
}

// Where the changes of one file are asked from: a commit, or what is staged or not in the working tree.
function open(from: string, path: string | undefined): void {
  if (!detail) return
  const group = from === 'staged' || from === 'unstaged' || from === 'untracked' ? from : undefined
  location.hash = address({ system: detail.repository.system, path: detail.repository.path, commit: group ? WORKING_TREE : from, group, file: path })
}

// The files of a patch by name, each one opening its changes in place of the history.
function fileIndex(diff: Diff, from: string): HTMLElement[] {
  const index = node('ul', '', 'files index')
  for (const file of parseDiff(diff.patch)) {
    const entry = node('button', '', 'file-link')
    entry.append(statusOf(file), node('span', label(file), 'file-path'), ...counts(file))
    entry.classList.toggle('selected', shownFile?.path === file.path && shownFile.from === from)
    entry.addEventListener('click', () => open(from, file.path))
    const item = node('li')
    item.append(entry)
    index.append(item)
  }
  const created = [index]
  if (diff.truncated) created.push(node('p', 'The changes are too large to list in full, and stop here.', 'empty'))
  return created
}

function fileList(title: string, files: FileChange[], letter: string): HTMLElement[] {
  if (files.length === 0) return []
  const list = node('ul', '', 'files')
  for (const file of files) {
    const item = node('li')
    item.append(node('span', letter, 'status'), node('span', label(file), 'file-path'))
    list.append(item)
  }
  return [node('h3', `${title} (${files.length})`), list]
}

async function patch(current: Loaded, of: string): Promise<Diff> {
  const cached = patches.get(of)
  if (cached) return cached
  const diff = await get<Diff>('diff', { system: current.repository.system, path: current.repository.path, target: of })
  // What is staged changes with the working tree, and is asked again at each read.
  if (diff.commit) patches.set(of, diff)
  return diff
}

// The changes of the file chosen, in place of the history, until closed.
async function renderFile(current: Loaded): Promise<void> {
  const view = element('diff')
  const shown = shownFile
  element('history').hidden = shown !== undefined
  view.hidden = shown === undefined
  if (!shown) return view.replaceChildren()
  const close = node('button', 'Close', 'close')
  close.title = 'Back to the history (Escape)'
  close.addEventListener('click', () => open(shown.from, undefined))
  const head = node('div', '', 'diff-head')
  try {
    const file = parseDiff((await patch(current, shown.from)).patch).find((candidate) => candidate.path === shown.path)
    if (shown !== shownFile) return
    if (!file) {
      head.append(node('span', shown.path, 'file-path'), close)
      return view.replaceChildren(head, node('p', 'This file is no longer among the changes.', 'empty'))
    }
    head.append(statusOf(file), node('span', label(file), 'file-path'), ...counts(file), close)
    if (file.binary) return view.replaceChildren(head, node('p', 'Binary file, not shown.', 'empty'))
    if (file.lines.length === 0) return view.replaceChildren(head, node('p', file.status === 'renamed' ? 'Renamed, with no change of content.' : 'No change of content.', 'empty'))
    const lines = node('div', '', 'lines')
    for (const line of file.lines.slice(0, MAX_LINES)) {
      const created = node('div', '', `line ${line.kind}`)
      created.append(node('span', line.before === undefined ? '' : String(line.before), 'number'), node('span', line.after === undefined ? '' : String(line.after), 'number'))
      created.append(node('span', line.kind === 'note' ? `\\ ${line.text}` : line.text, 'text'))
      lines.append(created)
    }
    view.replaceChildren(head, lines)
    if (file.lines.length > MAX_LINES) view.append(node('p', `The first ${MAX_LINES} lines of the changes are shown.`, 'empty'))
    view.scrollTop = 0
  } catch (error) {
    if (shown !== shownFile) return
    head.append(node('span', shown.path, 'file-path'), close)
    view.replaceChildren(head, node('p', error instanceof Error ? error.message : String(error), 'error'))
  }
}

async function renderDetail(current: Loaded): Promise<void> {
  const panel = element('detail')
  for (const [name, line] of rows) line.classList.toggle('selected', name === target)
  void renderFile(current)
  if (!target) {
    panel.replaceChildren(node('p', 'Choose a commit to see what it changed.', 'empty'))
    return
  }
  const shown = target
  try {
    const created: HTMLElement[] = []
    if (shown === WORKING_TREE) {
      const staged = current.changes.filter((file) => file.staged !== ' ' && file.staged !== 'U')
      const conflicts = current.changes.filter((file) => file.staged === 'U' || file.unstaged === 'U')
      const unstaged = current.changes.filter((file) => file.unstaged !== ' ' && file.unstaged !== '?' && file.unstaged !== 'U' && file.staged !== 'U')
      const untracked = current.changes.filter((file) => file.unstaged === '?')
      created.push(node('h2', 'Uncommitted changes'))
      if (current.changes.length === 0) created.push(node('p', 'The working tree is clean.', 'empty'))
      created.push(...fileList('In conflict', conflicts, 'U'))
      if (staged.length > 0) created.push(node('h3', `Staged (${staged.length})`), ...fileIndex(await patch(current, 'staged'), 'staged'))
      if (unstaged.length + conflicts.length > 0) {
        created.push(node('h3', `Not staged (${unstaged.length + conflicts.length})`), ...fileIndex(await patch(current, 'unstaged'), 'unstaged'))
      }
      if (untracked.length > 0) created.push(node('h3', `Untracked (${untracked.length})`), ...fileIndex(await patch(current, 'untracked'), 'untracked'))
    } else {
      const diff = await patch(current, shown)
      const [subject, ...body] = (diff.commit?.message ?? '').split('\n')
      created.push(node('h2', subject))
      if (body.join('\n').trim()) created.push(node('pre', body.join('\n').trim(), 'body'))
      const facts = node('p', '', 'facts')
      const hash = node('code', shown.slice(0, 10))
      hash.title = shown
      facts.append(hash, node('span', diff.commit?.author ?? ''), node('span', diff.commit ? new Date(diff.commit.date).toLocaleString() : ''))
      created.push(facts)
      if (diff.patch === '') created.push(node('p', 'This commit changes no file.', 'empty'))
      else created.push(node('h3', 'Files'), ...fileIndex(diff, shown))
    }
    // The answer of a commit left for another one meanwhile is dropped.
    if (shown === target) panel.replaceChildren(...created)
  } catch (error) {
    if (shown === target) panel.replaceChildren(node('p', error instanceof Error ? error.message : String(error), 'error'))
  }
}

function render(current: Loaded): void {
  element('repository-name').textContent = current.repository.name
  element('repository-path').textContent = current.repository.path
  const state = element('repository-state')
  state.replaceChildren()
  if (current.repository.branch) state.append(node('span', current.repository.branch, 'branch'))
  else if (current.repository.head) state.append(node('span', `detached at ${current.repository.head}`, 'branch detached'))
  if (current.repository.error === undefined) state.append(...badges([...sync(current.repository), ...changes(current.repository)], 'span').children)
  renderBranches(current)
  renderHistory(current)
  void renderDetail(current)
}

const WIDTH_KEY = 'chade-history-width'
const MIN_HISTORY = 240
const MIN_CHANGES = 320

// The bar between the history and the changes is dragged to give one the room of the other, and the width is kept for the next visit.
function resizable(): void {
  const bar = element('resize')
  const workspace = bar.parentElement as HTMLElement
  const history = element('history')
  const apply = (width: number | undefined, keep = true): void => {
    if (width === undefined) {
      workspace.style.removeProperty('--history-width')
      if (keep) localStorage.removeItem(WIDTH_KEY)
      return
    }
    // Both sides keep a width they can be read at.
    const most = workspace.clientWidth - history.offsetLeft - bar.offsetWidth - MIN_CHANGES
    const clamped = Math.round(Math.max(MIN_HISTORY, Math.min(width, most)))
    workspace.style.setProperty('--history-width', `${clamped}px`)
    if (keep) localStorage.setItem(WIDTH_KEY, String(clamped))
  }
  const kept = Number(localStorage.getItem(WIDTH_KEY))
  if (kept > 0) workspace.style.setProperty('--history-width', `${kept}px`)
  bar.addEventListener('pointerdown', (event) => {
    const start = event.clientX
    const width = history.offsetWidth
    bar.setPointerCapture(event.pointerId)
    bar.classList.add('dragging')
    const move = (moved: PointerEvent): void => apply(width + moved.clientX - start)
    const stop = (): void => {
      bar.classList.remove('dragging')
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', stop)
      bar.removeEventListener('pointercancel', stop)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', stop)
    bar.addEventListener('pointercancel', stop)
    event.preventDefault()
  })
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') apply(history.offsetWidth - 40)
    else if (event.key === 'ArrowRight') apply(history.offsetWidth + 40)
    else if (event.key === 'Home') apply(undefined)
    else return
    event.preventDefault()
  })
  bar.addEventListener('dblclick', () => apply(undefined))
}

resizable()

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && shownFile && !repository.section.hidden) open(shownFile.from, undefined)
})

// One repository: its branches, its history as a graph, and the changes of the commit chosen.
export const repository = {
  section: element('repository'),
  loaded: (): boolean => detail !== undefined,
  clear: (): void => {
    detail = undefined
  },
  async show(params: URLSearchParams): Promise<{ machine: string; version: string; scannedAt: string } | void> {
    const asked = `${params.get('system')}\n${params.get('path')}`
    target = params.get('commit') ?? undefined
    const file = params.get('file')
    const from = target === WORKING_TREE ? params.get('group') : target
    shownFile = file && from ? { path: file, from } : undefined
    if (detail && asked === key) return void renderDetail(detail)
    // Another repository starts from its newest commits, with nothing of the one before on the page.
    key = asked
    limit = PAGE
    detail = undefined
    patches.clear()
    for (const id of ['branches', 'history', 'diff', 'detail', 'repository-state']) element(id).replaceChildren()
    element('repository-name').textContent = ''
    element('repository-path').textContent = params.get('path') ?? ''
    return this.reload()
  },
  async reload(): Promise<{ machine: string; version: string; scannedAt: string }> {
    const [system, path] = key.split('\n')
    const loaded = await get<Loaded>('repository', { system, path, limit: String(limit) })
    // The answer for a repository left meanwhile is dropped.
    if (`${system}\n${path}` !== key) return loaded
    detail = loaded
    render(detail)
    return detail
  },
}
