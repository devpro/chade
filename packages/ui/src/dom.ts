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

// Each icon is a list of paths on a grid of 16 by 16.
const COPY_ICON = ['M5.5 5.5h8v8h-8z', 'M3.5 10.5h-1v-8h8v1']
const COPIED_ICON = ['M3 8.5l3.5 3.5L13 4.5']
const FAILED_ICON = ['M4 4l8 8', 'M12 4l-8 8']

function icon(paths: string[]): SVGElement {
  const created = svg('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' })
  created.append(...paths.map((d) => svg('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })))
  return created
}

// Copies the full text with one click.
export function copyButton(text: string, label = `Copy ${text}`): HTMLElement {
  const button = node('button', '', 'copy') as HTMLButtonElement
  button.type = 'button'
  let timer: ReturnType<typeof setTimeout> | undefined
  const show = (paths: string[], title: string, name: string): void => {
    button.replaceChildren(icon(paths))
    button.title = title
    button.setAttribute('aria-label', name)
  }
  const reset = (): void => show(COPY_ICON, 'Copy', label)
  const said = (paths: string[], title: string): void => {
    clearTimeout(timer)
    show(paths, title, title)
    timer = setTimeout(reset, 1500)
  }
  button.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(
      () => said(COPIED_ICON, 'Copied'),
      () => said(FAILED_ICON, 'Copy failed'),
    )
  })
  reset()
  return button
}

// A command and the button that copies it.
export function commandLine(command: string): HTMLElement {
  const line = node('span', '', 'command')
  line.append(node('code', command), copyButton(command))
  return line
}
