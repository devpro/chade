import { element } from './dom.js'

let noticeTimer: ReturnType<typeof setTimeout> | undefined

// What an action did, or why git refused it, in the words of git, in a corner of the page.
export function notify(title: string, text: string, state: 'running' | 'done' | 'failed'): void {
  clearTimeout(noticeTimer)
  const notice = element('notice')
  notice.hidden = false
  notice.className = state
  element('notice-title').textContent = title
  element('notice-text').textContent = text
  // A success leaves by itself, and a failure stays until read.
  if (state === 'done') noticeTimer = setTimeout(() => (notice.hidden = true), 6000)
}

element('notice-close').addEventListener('click', () => (element('notice').hidden = true))

// What the notice says while git works, a push taking the seconds its remote takes.
export const RUNNING: Record<string, string> = {
  fetch: 'Fetching…',
  pull: 'Pulling…',
  push: 'Pushing…',
  checkout: 'Checking out…',
  branch: 'Creating the branch…',
  stage: 'Staging…',
  unstage: 'Unstaging…',
  commit: 'Committing…',
  amend: 'Amending…',
  delete: 'Deleting the branch…',
}

// The title of a notice for an action git refused.
export const refused = (action: string): string => `${action[0].toUpperCase()}${action.slice(1)} did not go through`

export const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// A repository changed from another page, which the page of that repository reads again rather than showing what it read before.
export const CHANGED_EVENT = 'chade-changed'
