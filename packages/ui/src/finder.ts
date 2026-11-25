import type { Repository } from '@chade/daemon'
import { address } from './api.js'
import { element, node } from './dom.js'
import { forgeIcon } from './forge.js'
import { find } from './format.js'
import { listState, readState } from './list.js'
import { chosenSystem } from './systems.js'

const dialog = element<HTMLDialogElement>('finder')
const input = element<HTMLInputElement>('finder-input')
const results = element('finder-results')
const note = element('finder-note')

// The address of the selected repository.
// A list that is read again keeps the selection.
let selected: string | undefined

const addressOf = ({ system, path }: Repository): string => address({ system, path })

const options = (): HTMLAnchorElement[] => [...results.querySelectorAll<HTMLAnchorElement>('[role=option]')]

function select(option: HTMLAnchorElement | undefined): void {
  selected = option?.getAttribute('href') ?? undefined
  for (const each of options()) each.setAttribute('aria-selected', String(each === option))
  if (option) input.setAttribute('aria-activedescendant', option.id)
  else input.removeAttribute('aria-activedescendant')
}

function optionOf(repository: Repository, index: number): HTMLElement {
  const option = node('a', '', 'finder-option') as HTMLAnchorElement
  option.id = `finder-option-${index}`
  option.href = addressOf(repository)
  option.tabIndex = -1
  option.setAttribute('role', 'option')
  option.append(forgeIcon(repository.remote), node('span', repository.name, 'finder-name'), node('span', repository.path, 'path'), node('span', repository.system, 'finder-system'))
  // Ctrl and click opens another tab of the browser, and the search stays open.
  option.addEventListener('click', (event) => {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) dialog.close()
  })
  option.addEventListener('pointermove', () => {
    if (selected !== option.getAttribute('href')) select(option)
  })
  return option
}

function render(): void {
  const state = listState()
  if (!state) return
  const system = chosenSystem([...new Set(state.repositories.map((repository) => repository.system))])
  const found = find(state.repositories, input.value, system)
  results.replaceChildren(...found.map((repository, index) => optionOf(repository, index)))
  input.setAttribute('aria-expanded', String(found.length > 0))
  note.textContent = found.length === 0 ? 'No repository matches.' : ''
  const shown = options()
  const option = shown.find((each) => each.getAttribute('href') === selected) ?? shown[0]
  select(option)
  option?.scrollIntoView({ block: 'nearest' })
}

async function open(): Promise<void> {
  input.value = ''
  selected = undefined
  results.replaceChildren()
  select(undefined)
  note.textContent = listState() ? '' : 'Reading the repositories…'
  dialog.showModal()
  render()
  // The known list shows at once.
  // A repository cloned since the last read shows when this read ends.
  try {
    await readState()
    if (dialog.open) render()
  } catch (error) {
    if (!listState()) note.textContent = error instanceof Error ? error.message : String(error)
  }
}

function move(step: number): void {
  const shown = options()
  if (shown.length === 0) return
  const index = shown.findIndex((each) => each.getAttribute('href') === selected)
  const option = shown[(index + step + shown.length) % shown.length]
  select(option)
  option.scrollIntoView({ block: 'nearest' })
}

input.addEventListener('input', () => {
  selected = undefined
  render()
})

dialog.addEventListener('keydown', (event) => {
  // The page behind has its own Escape, which must not close a file there.
  event.stopPropagation()
  // Enter and the arrows first belong to an input method that composes a word.
  if (event.isComposing) return
  if (event.key === 'ArrowDown') move(1)
  else if (event.key === 'ArrowUp') move(-1)
  else if (event.key === 'Enter') options().find((each) => each.getAttribute('href') === selected)?.click()
  // The input is the only stop of the keyboard.
  else if (event.key !== 'Tab') return
  event.preventDefault()
})

// The search covers its whole dialog, so a press on the dialog itself is a press outside of the search.
dialog.addEventListener('pointerdown', (event) => {
  if (event.target === dialog) dialog.close()
})

// A letter typed in a field is text, not a shortcut.
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null)
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'r' || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return
  if (dialog.open || typing(event.target)) return
  // The letter must not land in the search.
  event.preventDefault()
  void open()
})
