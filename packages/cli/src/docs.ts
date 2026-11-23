// These titles must be the same as the titles on the Docs page of chade ui.
const TITLES = { cleanup: 'System clean-up', scan: 'Packages and images' }

// Tells the user where to find the instructions.
// The Docs page always agrees with the installed version of chade.
// A page on GitHub can be for a different version.
export function docsPointer(page: keyof typeof TITLES, heading: string): string {
  return `How to: chade ui, Docs, ${TITLES[page]}, #${heading}`
}
