import { node } from './dom.js'

// Where a link of a page goes: an address, or null when the target is not in the interface, and its text is left unlinked.
export type Linker = (target: string) => string | null

export const slugify = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[`*]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

function anchor(href: string, children: (Node | string)[]): HTMLElement {
  const link = node('a') as HTMLAnchorElement
  link.href = href
  link.append(...children)
  if (/^https?:/.test(href)) {
    link.target = '_blank'
    link.rel = 'noopener'
  }
  return link
}

// The links, the code, the bold and the italic of a line, as nodes, never as markup.
// An image is left out, as the page loads nothing from another site.
function inline(text: string, link: Linker): (Node | string)[] {
  const nodes: (Node | string)[] = []
  const pattern = /\[!\[[^\]]*\]\([^)\s]+\)\]\([^)\s]+\)|!\[[^\]]*\]\([^)\s]+\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    if (match[1] !== undefined) nodes.push(node('code', match[1]))
    else if (match[2] !== undefined) nodes.push(wrap('strong', inline(match[2], link)))
    else if (match[3] !== undefined) nodes.push(wrap('em', inline(match[3], link)))
    else if (match[4] !== undefined) {
      const href = link(match[5])
      const label = inline(match[4], link)
      nodes.push(href === null ? wrap('span', label) : anchor(href, label))
    }
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function wrap(tag: string, children: (Node | string)[], className = ''): HTMLElement {
  const created = node(tag, '', className)
  created.append(...children)
  return created
}

interface Item {
  ordered: boolean
  blocks: string[]
  children: Item[]
}

function list(items: Item[], link: Linker): HTMLElement {
  return wrap(
    items[0].ordered ? 'ol' : 'ul',
    items.map((item) => wrap('li', [...markdown(item.blocks.join('\n'), link, true), ...(item.children.length > 0 ? [list(item.children, link)] : [])])),
  )
}

const cells = (line: string): string[] =>
  line
    .replace(/^\s*\||\|\s*$/g, '')
    .split('|')
    .map((cell) => cell.trim())

const ITEM = /^(\s*)([-*]|\d+\.) (.*)/

// A block of the page, and the index of the first line after it.
interface Parsed {
  block: HTMLElement
  next: number
}

type BlockParser = (lines: string[], index: number, link: Linker) => Parsed | undefined

function fence(lines: string[], index: number): Parsed | undefined {
  if (!lines[index].startsWith('```')) return undefined
  const code: string[] = []
  let next = index + 1
  for (; next < lines.length && !lines[next].startsWith('```'); next++) code.push(lines[next])
  return { block: wrap('pre', [node('code', code.join('\n'))]), next: next + 1 }
}

function heading(lines: string[], index: number, link: Linker): Parsed | undefined {
  const match = /^(#{1,4}) (.*)/.exec(lines[index])
  if (!match) return undefined
  const created = wrap(`h${match[1].length}`, inline(match[2], link))
  created.id = slugify(match[2])
  return { block: created, next: index + 1 }
}

function quote(lines: string[], index: number, link: Linker): Parsed | undefined {
  if (!lines[index].startsWith('>')) return undefined
  const quoted: string[] = []
  let next = index
  for (; next < lines.length && lines[next].startsWith('>'); next++) quoted.push(lines[next].replace(/^> ?/, ''))
  // A note of GitHub starts with its kind between brackets, which is shown as its title.
  const kind = /^\[!(\w+)\]$/.exec(quoted[0].trim())?.[1]
  const body = markdown(quoted.slice(kind ? 1 : 0).join('\n'), link)
  return { block: wrap('blockquote', kind ? [node('strong', `${kind[0]}${kind.slice(1).toLowerCase()}`), ...body] : body), next }
}

function table(lines: string[], index: number, link: Linker): Parsed | undefined {
  if (!lines[index].includes('|') || !/^\s*(\|\s*)?:?-{3,}/.test(lines[index + 1] ?? '')) return undefined
  const head = cells(lines[index])
  const rows: string[][] = []
  let next = index + 2
  for (; next < lines.length && lines[next].includes('|'); next++) rows.push(cells(lines[next]))
  const row = (tag: string, values: string[]): HTMLElement =>
    wrap(
      'tr',
      values.map((value) => wrap(tag, inline(value, link))),
    )
  return { block: wrap('div', [wrap('table', [wrap('thead', [row('th', head)]), wrap('tbody', rows.map((values) => row('td', values)))])], 'table-wrap'), next }
}

// What is indented under an item belongs to it: the rest of its text, a block of code, a deeper item, and a blank line before more of them.
function inList(lines: string[], index: number): boolean {
  const line = lines[index]
  if (ITEM.test(line) || /^\s{2,}\S/.test(line)) return true
  return !line.trim() && /^\s{2,}\S|^(\s*)([-*]|\d+\.) /.test(lines[index + 1] ?? '')
}

function itemList(lines: string[], index: number, link: Linker): Parsed | undefined {
  if (!ITEM.test(lines[index])) return undefined
  const root: Item = { ordered: false, blocks: [], children: [] }
  const stack: { indent: number; item: Item }[] = [{ indent: -1, item: root }]
  let last = root
  let next = index
  for (; next < lines.length && inList(lines, next); next++) {
    const item = ITEM.exec(lines[next])
    if (!item) {
      last.blocks.push(lines[next].replace(/^\s+/, (spaces) => spaces.slice(Math.min(spaces.length, stack.at(-1)!.indent + 3))))
      continue
    }
    while (item[1].length <= stack.at(-1)!.indent) stack.pop()
    last = { ordered: /\d/.test(item[2]), blocks: [item[3]], children: [] }
    stack.at(-1)!.item.children.push(last)
    stack.push({ indent: item[1].length, item: last })
  }
  return { block: list(root.children, link), next }
}

const BLOCKS: BlockParser[] = [fence, heading, quote, table, itemList]

// A sentence starts on its own line in the sources, so a paragraph is the lines up to a blank one or another block.
function paragraph(lines: string[], index: number, link: Linker): { nodes: (Node | string)[]; next: number } {
  const nodes: (Node | string)[] = []
  let next = index
  for (; next < lines.length && lines[next].trim() && !/^(```|#{1,4} |>|\s*([-*]|\d+\.) )/.test(lines[next]); next++) {
    if (nodes.length > 0) nodes.push(' ')
    nodes.push(...inline(lines[next].trim(), link))
  }
  return { nodes, next }
}

// The Markdown the documentation of chade uses: headings, paragraphs, notes, lists with code under an item, tables and fenced code.
export function markdown(source: string, link: Linker, tight = false): HTMLElement[] {
  const lines = source.split('\n')
  const blocks: HTMLElement[] = []
  let index = 0
  while (index < lines.length) {
    if (!lines[index].trim()) {
      index++
      continue
    }
    const parsed = firstBlock(lines, index, link)
    if (parsed) {
      blocks.push(parsed.block)
      index = parsed.next
      continue
    }
    const { nodes, next } = paragraph(lines, index, link)
    // The one line of a list item needs no paragraph of its own.
    blocks.push(wrap(tight && blocks.length === 0 ? 'span' : 'p', nodes))
    index = next
  }
  return blocks
}

function firstBlock(lines: string[], index: number, link: Linker): Parsed | undefined {
  for (const parse of BLOCKS) {
    const parsed = parse(lines, index, link)
    if (parsed) return parsed
  }
  return undefined
}
