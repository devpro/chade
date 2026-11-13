import cleanup from '../../../docs/cleanup.md'
import commands from '../../../docs/commands.md'
import configuration from '../../../docs/configuration.md'
import webInterface from '../../../docs/web-interface.md'
import contributing from '../../../CONTRIBUTING.md'
import readme from '../../../README.md'
import { address, get } from './api.js'
import { element, node } from './dom.js'
import { markdown, slugify } from './markdown.js'

interface Page {
  slug: string
  // Path of the file in the repository, which the links between the pages are written against.
  file: string
  title: string
  source: string
}

// The documentation of the repository, bundled with the interface, so the two never drift apart and it reads without a network.
const pages: Page[] = [
  { slug: 'guide', file: 'README.md', title: 'User guide', source: readme },
  { slug: 'commands', file: 'docs/commands.md', title: 'Commands', source: commands },
  { slug: 'configuration', file: 'docs/configuration.md', title: 'Configuration', source: configuration },
  { slug: 'web-interface', file: 'docs/web-interface.md', title: 'Web interface', source: webInterface },
  { slug: 'cleanup', file: 'docs/cleanup.md', title: 'System clean-up', source: cleanup },
  { slug: 'contributing', file: 'CONTRIBUTING.md', title: 'Contributor guide', source: contributing },
]

// The address of a page of the documentation, at one of its headings when given.
export const docsAddress = (slug: string, heading?: string): string => address({ page: 'docs', name: slug === pages[0].slug ? undefined : slug, at: heading })

let shown: Page | undefined

function scrollTo(heading: string | undefined): void {
  const target = heading ? document.getElementById(heading) : undefined
  if (target && element('docs-page').contains(target)) target.scrollIntoView()
  else window.scrollTo(0, 0)
}

// A link to another page opens it here, one to a heading of this page names it in the address, one to a file not shown is left as text.
function linker(page: Page): (target: string) => string | null {
  return (target) => {
    if (/^[a-z]+:/i.test(target)) return target
    if (target.startsWith('#')) return docsAddress(page.slug, target.slice(1))
    const url = new URL(target, `file:///${page.file}`)
    const linked = pages.find((candidate) => `/${candidate.file}` === url.pathname)
    return linked ? docsAddress(linked.slug, url.hash.slice(1) || undefined) : null
  }
}

function render(page: Page): void {
  const links = pages.map((candidate) => {
    const link = node('a', candidate.title) as HTMLAnchorElement
    link.href = docsAddress(candidate.slug)
    if (candidate === page) link.setAttribute('aria-current', 'page')
    return link
  })
  element('docs-nav').replaceChildren(node('h3', 'Documentation'), ...links)
  element('docs-page').replaceChildren(...markdown(page.source, linker(page)))
  // The headings of a fenced block are no headings of the page.
  const headings = [...page.source.replace(/^```[\s\S]*?^```/gm, '').matchAll(/^## (.*)$/gm)].map((match) => match[1])
  const toc = headings.map((heading) => {
    const link = node('a', heading.replaceAll('`', '')) as HTMLAnchorElement
    link.href = docsAddress(page.slug, slugify(heading))
    return link
  })
  element('docs-toc').replaceChildren(node('h3', 'On this page'), ...toc)
  element('docs-toc').hidden = toc.length === 0
}

// The documentation: its pages, the one chosen, and the headings of that one.
export const docs = {
  section: element('docs'),
  loaded: (): boolean => shown !== undefined,
  clear: (): void => {
    shown = undefined
  },
  // The pages are read from the interface itself, at no moment in particular.
  age: (): string => '',
  title: (params: URLSearchParams): string => (pages.find((candidate) => candidate.slug === params.get('name')) ?? pages[0]).title,
  async show(params: URLSearchParams): Promise<{ machine: string; version: string }> {
    const page = pages.find((candidate) => candidate.slug === params.get('name')) ?? pages[0]
    if (page !== shown) render(page)
    shown = page
    const heading = params.get('at') ?? undefined
    // Once the page is shown, as a hidden one has no place to scroll to.
    requestAnimationFrame(() => scrollTo(heading))
    return this.reload()
  },
  // The pages need no server, and asking it keeps the top of the page true about the session.
  async reload(): Promise<{ machine: string; version: string }> {
    return get<{ machine: string; version: string }>('ping')
  },
}
