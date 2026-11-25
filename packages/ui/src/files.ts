import type { ChangedFile, FilePatch } from '@chade/daemon'
import { parseDiff } from './diff.js'
import { element, node } from './dom.js'

// What is longer than this is shown in steps, on demand, as a page with all of it at once is slow to draw and to scroll.
const FILES_SHOWN = 500
const LINES_SHOWN = 10_000
// A minified file has lines of megabytes.
const CHARACTERS_SHOWN = 2000

const STATUS: Record<string, string> = { A: 'added', C: 'added', D: 'deleted', R: 'renamed' }

// The lists of files asked in full, which stay so when the page draws them again.
const expanded = new Set<string>()

// The files in a list, the first ones, then all of them on demand.
export function fileItems<T>(id: string, files: T[], item: (file: T) => HTMLElement): HTMLElement[] {
  const list = node('ul', '', 'files index')
  const first = expanded.has(id) ? files.length : FILES_SHOWN
  list.append(...files.slice(0, first).map(item))
  if (files.length <= first) return [list]
  const more = node('button', `Show all ${files.length} files`, 'more')
  more.addEventListener('click', () => {
    expanded.add(id)
    list.append(...files.slice(first).map(item))
    more.remove()
  })
  return [list, more]
}

export const label = (file: { path: string; from?: string }): string => (file.from ? `${file.from} → ${file.path}` : file.path)

export function statusOf(letter: string): HTMLElement {
  const status = STATUS[letter] ?? 'modified'
  const created = node('span', status[0].toUpperCase(), `status ${status}`)
  created.title = status
  return created
}

export function counts(file: ChangedFile): HTMLElement[] {
  const created: HTMLElement[] = []
  if (file.additions) created.push(node('span', `+${file.additions}`, 'additions'))
  if (file.deletions) created.push(node('span', `−${file.deletions}`, 'deletions'))
  return created
}

// The title of the file shown in place of a history, with the button that brings the history back.
export function fileHead(close: () => void, ...content: HTMLElement[]): HTMLElement {
  const button = node('button', 'Close', 'close')
  button.title = 'Back to the history (Escape)'
  button.addEventListener('click', close)
  const head = node('div', '', 'diff-head')
  head.append(...content, button)
  return head
}

interface NumberedLine {
  kind: string
  text: string
  before?: number
  after?: number
}

// The text of a line, its start only when it is very long, then the rest on demand.
function lineText(text: string): HTMLElement {
  const created = node('span', text.slice(0, CHARACTERS_SHOWN), 'text')
  const left = text.length - CHARACTERS_SHOWN
  if (left <= 0) return created
  const more = node('button', `Show ${left.toLocaleString('en')} more characters`, 'line-rest')
  more.addEventListener('click', () => (created.textContent = text))
  created.append(more)
  return created
}

function lineOf(line: NumberedLine): HTMLElement {
  const created = node('div', '', `line ${line.kind}`)
  // A file read as it is has one number per line, and a comparison the number before and the one after.
  if (line.kind !== 'content') created.append(node('span', line.before === undefined ? '' : String(line.before), 'number'))
  created.append(node('span', line.after === undefined ? '' : String(line.after), 'number'))
  created.append(lineText(line.kind === 'note' ? String.raw`\ ${line.text}` : line.text))
  return created
}

function numbered(lines: NumberedLine[]): HTMLElement[] {
  const block = node('div', '', 'lines')
  const more = node('button', '', 'more')
  let shown = 0
  const next = (): void => {
    for (const line of lines.slice(shown, shown + LINES_SHOWN)) block.append(lineOf(line))
    shown = Math.min(shown + LINES_SHOWN, lines.length)
    const left = lines.length - shown
    if (left === 0) more.remove()
    else more.textContent = left > LINES_SHOWN ? `Show ${LINES_SHOWN.toLocaleString('en')} more lines of the ${left.toLocaleString('en')} left` : `Show the last ${left.toLocaleString('en')} lines`
  }
  more.addEventListener('click', next)
  next()
  return shown < lines.length ? [block, more] : [block]
}

// The changes of one file, line by line, or the reason there is no line to show.
export function diffLines({ file, patch }: FilePatch): HTMLElement[] {
  if (file.binary) return [node('p', 'Binary file, not shown.', 'empty')]
  const parsed = parseDiff(patch)
  // A folder that takes the place of a file brings its own files under the path, and a file that becomes a link comes in two parts.
  // Git quotes a path that holds special characters, and then no path reads as the one asked.
  const own = parsed.filter((candidate) => candidate.path === file.path)
  const lines = (own.length > 0 ? own : parsed).flatMap((part) => part.lines)
  if (lines.length === 0) return [node('p', file.status === 'R' ? 'Renamed, with no change of content.' : 'No change of content.', 'empty')]
  return numbered(lines)
}

// The content of one file, each line with its number.
export function contentLines(content: string): HTMLElement[] {
  if (content === '') return [node('p', 'Empty file.', 'empty')]
  const lines = content.replace(/\n$/, '').split('\n')
  return numbered(lines.map((text, index) => ({ kind: 'content', text, after: index + 1 })))
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
