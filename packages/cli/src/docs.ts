// The titles the Docs page of chade ui lists its pages under.
const TITLES = { cleanup: 'System clean-up', scan: 'Packages and images' }

// Where the terminal sends to the documentation bundled with chade, whose version is the one running, where a page on the web may be of another.
export function docsPointer(page: keyof typeof TITLES, heading: string): string {
  return `How to: chade ui, Docs, ${TITLES[page]}, #${heading}`
}
