export const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

// Every text reaches the page as text, never as markup, as a branch name, a commit subject or a line of a file can hold anything.
export function node(tag: string, text = '', className = ''): HTMLElement {
  const created = document.createElement(tag)
  created.textContent = text
  if (className) created.className = className
  return created
}

export function svg(tag: string, attributes: Record<string, string | number>): SVGElement {
  const created = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, String(value))
  return created
}
