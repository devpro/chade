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

// The short hash is what reads, the full hash is what a pipeline or a command needs, so a click copies the full one.
export function copyHash(hash: string): HTMLElement {
  const shown = hash.slice(0, 10)
  const button = node('button', shown, 'hash')
  button.title = `${hash}\nCopy the full hash`
  button.setAttribute('aria-label', `Copy the full hash ${hash}`)
  let timer: ReturnType<typeof setTimeout> | undefined
  button.addEventListener('click', () => {
    const said = (text: string): void => {
      clearTimeout(timer)
      button.textContent = text
      timer = setTimeout(() => (button.textContent = shown), 1500)
    }
    navigator.clipboard.writeText(hash).then(
      () => said('Copied'),
      () => said('Copy failed'),
    )
  })
  return button
}
