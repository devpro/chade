import { node } from './dom.js'

// The pages share the choice, so a system chosen on one page is the one the next page opens on.
const TAB_KEY = 'chade-system'

export interface SystemTab {
  system: string
  count: number
  todo: number
}

// The system chosen last, or the first one when the page does not have it.
export function chosenSystem(systems: string[]): string | undefined {
  const chosen = sessionStorage.getItem(TAB_KEY)
  return chosen !== null && systems.includes(chosen) ? chosen : systems[0]
}

export function chooseSystem(system: string): void {
  sessionStorage.setItem(TAB_KEY, system)
}

export function systemTabs(tabs: SystemTab[], shown: string | undefined, chosen: () => void): HTMLElement[] {
  return tabs.map(({ system, count, todo }) => {
    const tab = node('button', '', 'tab')
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(system === shown))
    tab.append(node('span', system), node('span', String(count), 'count'))
    if (todo > 0) {
      const mark = node('span', String(todo), 'count todo')
      mark.title = `${todo} with something to do`
      tab.append(mark)
    }
    tab.addEventListener('click', () => {
      chooseSystem(system)
      chosen()
    })
    return tab
  })
}
