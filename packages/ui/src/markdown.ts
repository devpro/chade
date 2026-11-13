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

// The Markdown the documentation of chade uses: headings, paragraphs, notes, lists with code under an item, tables and fenced code.
// A sentence starts on its own line in the sources, so a paragraph is the lines up to a blank one.
export function markdown(source: string, link: Linker, tight = false): HTMLElement[] {
  const lines = source.split('\n')
  const blocks: HTMLElement[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      continue
    }
    if (line.startsWith('```')) {
      const code: string[] = []
      for (index++; index < lines.length && !lines[index].startsWith('```'); index++) code.push(lines[index])
      index++
      blocks.push(wrap('pre', [node('code', code.join('\n'))]))
      continue
    }
    const heading = /^(#{1,4}) (.*)/.exec(line)
    if (heading) {
      const created = wrap(`h${heading[1].length}`, inline(heading[2], link))
      created.id = slugify(heading[2])
      blocks.push(created)
      index++
      continue
    }
    if (line.startsWith('>')) {
      const quoted: string[] = []
      for (; index < lines.length && lines[index].startsWith('>'); index++) quoted.push(lines[index].replace(/^> ?/, ''))
      // A note of GitHub starts with its kind between brackets, which is shown as its title.
      const kind = /^\[!(\w+)\]$/.exec(quoted[0].trim())?.[1]
      const body = markdown(quoted.slice(kind ? 1 : 0).join('\n'), link)
      blocks.push(wrap('blockquote', kind ? [node('strong', `${kind[0]}${kind.slice(1).toLowerCase()}`), ...body] : body))
      continue
    }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? '')) {
      const head = cells(line)
      const rows: string[][] = []
      for (index += 2; index < lines.length && lines[index].includes('|'); index++) rows.push(cells(lines[index]))
      const row = (tag: string, values: string[]): HTMLElement =>
        wrap(
          'tr',
          values.map((value) => wrap(tag, inline(value, link))),
        )
      blocks.push(wrap('div', [wrap('table', [wrap('thead', [row('th', head)]), wrap('tbody', rows.map((values) => row('td', values)))])], 'table-wrap'))
      continue
    }
    if (ITEM.test(line)) {
      const root: Item = { ordered: false, blocks: [], children: [] }
      const stack: { indent: number; item: Item }[] = [{ indent: -1, item: root }]
      let last = root
      // What is indented under an item belongs to it: the rest of its text, a block of code, a deeper item.
      for (; index < lines.length && (ITEM.test(lines[index]) || /^\s{2,}\S/.test(lines[index]) || (!lines[index].trim() && /^\s{2,}\S|^(\s*)([-*]|\d+\.) /.test(lines[index + 1] ?? ''))); index++) {
        const next = ITEM.exec(lines[index])
        if (!next) {
          last.blocks.push(lines[index].replace(/^\s+/, (spaces) => spaces.slice(Math.min(spaces.length, stack.at(-1)!.indent + 3))))
          continue
        }
        while (next[1].length <= stack.at(-1)!.indent) stack.pop()
        last = { ordered: /\d/.test(next[2]), blocks: [next[3]], children: [] }
        stack.at(-1)!.item.children.push(last)
        stack.push({ indent: next[1].length, item: last })
      }
      blocks.push(list(root.children, link))
      continue
    }
    const paragraph: (Node | string)[] = []
    for (; index < lines.length && lines[index].trim() && !/^(```|#{1,4} |>|\s*([-*]|\d+\.) )/.test(lines[index]); index++) {
      if (paragraph.length > 0) paragraph.push(' ')
      paragraph.push(...inline(lines[index].trim(), link))
    }
    // The one line of a list item needs no paragraph of its own.
    blocks.push(wrap(tight && blocks.length === 0 ? 'span' : 'p', paragraph))
  }
  return blocks
}
