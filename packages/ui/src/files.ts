import { parseDiff, type DiffFile } from './diff.js'
import { element, node } from './dom.js'

// A file of more lines than this is cut, as a page of that length no longer scrolls.
export const MAX_LINES = 10_000

const STATUS: Record<DiffFile['status'], string> = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' }

export const label = (file: { path: string; from?: string }): string => (file.from ? `${file.from} → ${file.path}` : file.path)

export function statusOf(status: DiffFile['status']): HTMLElement {
  const created = node('span', STATUS[status], `status ${status}`)
  created.title = status
  return created
}

export function counts(file: DiffFile): HTMLElement[] {
  const created: HTMLElement[] = []
  if (file.additions > 0) created.push(node('span', `+${file.additions}`, 'additions'))
  if (file.deletions > 0) created.push(node('span', `−${file.deletions}`, 'deletions'))
  return created
}

export const fileOf = (patch: string, path: string): DiffFile | undefined => parseDiff(patch).find((candidate) => candidate.path === path)

// The title of the file shown in place of a history, with the button that brings the history back.
export function fileHead(close: () => void, ...content: HTMLElement[]): HTMLElement {
  const button = node('button', 'Close', 'close')
  button.title = 'Back to the history (Escape)'
  button.addEventListener('click', close)
  const head = node('div', '', 'diff-head')
  head.append(...content, button)
  return head
}

function numbered(lines: { kind: string; text: string; before?: number; after?: number }[], what: string): HTMLElement[] {
  const block = node('div', '', 'lines')
  for (const line of lines.slice(0, MAX_LINES)) {
    const created = node('div', '', `line ${line.kind}`)
    // A file read as it is has one number per line, and a comparison the number before and the one after.
    if (line.kind !== 'content') created.append(node('span', line.before === undefined ? '' : String(line.before), 'number'))
    created.append(node('span', line.after === undefined ? '' : String(line.after), 'number'))
    created.append(node('span', line.kind === 'note' ? String.raw`\ ${line.text}` : line.text, 'text'))
    block.append(created)
  }
  return lines.length > MAX_LINES ? [block, node('p', `The first ${MAX_LINES} lines of ${what} are shown.`, 'empty')] : [block]
}

// The changes of one file, line by line, or the reason there is no line to show.
export function diffLines(file: DiffFile): HTMLElement[] {
  if (file.binary) return [node('p', 'Binary file, not shown.', 'empty')]
  if (file.lines.length === 0) return [node('p', file.status === 'renamed' ? 'Renamed, with no change of content.' : 'No change of content.', 'empty')]
  return numbered(file.lines, 'the changes')
}

// The content of one file, each line with its number.
export function contentLines(content: string): HTMLElement[] {
  if (content === '') return [node('p', 'Empty file.', 'empty')]
  const lines = content.replace(/\n$/, '').split('\n')
  return numbered(
    lines.map((text, index) => ({ kind: 'content', text, after: index + 1 })),
    'the file',
  )
}

const WIDTH_KEY = 'chade-history-width'
const SIDE_KEY = 'chade-side-width'
const MIN_SIDE = 120
const MIN_HISTORY = 240
const MIN_CHANGES = 320

// A bar dragged, or moved with the arrow keys, sets the width of a column, kept for the next visit, and a double click or Home resets it.
// The pages share the widths, as they share the layout.
function draggable(bar: HTMLElement, variable: string, key: string, measured: () => HTMLElement, clamp: (width: number) => number): void {
  const workspace = bar.parentElement as HTMLElement
  const apply = (width: number | undefined): void => {
    if (width === undefined) {
      workspace.style.removeProperty(variable)
      localStorage.removeItem(key)
      return
    }
    const clamped = Math.round(clamp(width))
    workspace.style.setProperty(variable, `${clamped}px`)
    localStorage.setItem(key, String(clamped))
  }
  // Read when the page is shown, so a width chosen on another page applies here as well.
  const restore = (): void => {
    const kept = Number(localStorage.getItem(key))
    if (kept > 0) workspace.style.setProperty(variable, `${kept}px`)
    else workspace.style.removeProperty(variable)
  }
  restore()
  window.addEventListener('hashchange', restore)
  bar.addEventListener('pointerdown', (event) => {
    const start = event.clientX
    const width = measured().offsetWidth
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
    if (event.key === 'ArrowLeft') apply(measured().offsetWidth - 40)
    else if (event.key === 'ArrowRight') apply(measured().offsetWidth + 40)
    else if (event.key === 'Home') apply(undefined)
    else return
    event.preventDefault()
  })
  bar.addEventListener('dblclick', () => apply(undefined))
}

// The bar between a history and the changes gives one the room of the other.
export function resizable(barId: string, historyId: string, fileId: string): void {
  const bar = element(barId)
  const workspace = bar.parentElement as HTMLElement
  // The file shown in place of the history has its place and its width.
  const shown = (): HTMLElement => (element(historyId).hidden ? element(fileId) : element(historyId))
  // Both sides keep a width they can be read at.
  draggable(bar, '--history-width', WIDTH_KEY, shown, (width) => Math.max(MIN_HISTORY, Math.min(width, workspace.clientWidth - shown().offsetLeft - bar.offsetWidth - MIN_CHANGES)))
}

// The bar between the list on the side and the history gives the side the room a long name needs.
export function resizableSide(barId: string, sideId: string, historyId: string, fileId: string, detailId: string): void {
  const bar = element(barId)
  const side = element(sideId)
  const shown = (): HTMLElement => (element(historyId).hidden ? element(fileId) : element(historyId))
  // The side takes from the changes, and from the history too while its width is not set, so neither goes under its least.
  const room = (): number => {
    const history = (bar.parentElement as HTMLElement).style.getPropertyValue('--history-width') ? 0 : shown().offsetWidth - MIN_HISTORY
    return Math.max(0, history) + Math.max(0, element(detailId).offsetWidth - MIN_CHANGES)
  }
  draggable(bar, '--side-width', SIDE_KEY, () => side, (width) => Math.max(MIN_SIDE, Math.min(width, side.offsetWidth + room())))
}
