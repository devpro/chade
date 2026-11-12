import type { Branch, Check, Commit, Detail, Diff, FileChange, LastCommit } from '@chade/daemon'
import { address, get, post } from './api.js'
import { parseDiff } from './diff.js'
import { element, node, svg } from './dom.js'
import { counts, diffLines, fileHead, fileOf, label, resizable, statusOf } from './files.js'
import { ago, changes, checkOf, sync } from './format.js'
import { layout, type GraphRow } from './graph.js'
import { badges, list } from './list.js'

type Loaded = Detail & { machine: string; version: string; scannedAt: string }

// What the changes panel shows: the working tree, or a commit by its hash.
const WORKING_TREE = 'working-tree'
const PAGE = 300
const LANE = 14
const ROW = 28
const LANES_SHOWN = 12
let detail: Loaded | undefined
let key = ''
let limit = PAGE
let target: string | undefined
// The file whose changes take the place of the history, and the commit or the part of the working tree they are read from.
let shownFile: { path: string; from: string } | undefined
// The patch of a commit never changes, so it is asked once.
const patches = new Map<string, Diff>()
const rows = new Map<string, HTMLElement>()
// What IstarCI did with each commit, read after the history so the history never waits for it.
let checks: Record<string, Check> = {}
// An action is running: the next one waits for its answer, as git changes one thing at a time in a repository.
let acting = false

let noticeTimer: ReturnType<typeof setTimeout> | undefined

// What an action did, or why git refused it, in the words of git, in a corner of the page.
function notify(title: string, text: string, state: 'running' | 'done' | 'failed'): void {
  const failed = state === 'failed'
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

function setBusy(busy: boolean): void {
  acting = busy
  repository.section.classList.toggle('busy', busy)
  for (const button of repository.section.querySelectorAll<HTMLButtonElement>('.action')) button.disabled = busy || button.dataset.off === 'true'
}

// What the notice says while git works, a push taking the seconds its remote takes.
const RUNNING: Record<string, string> = {
  fetch: 'Fetching…',
  pull: 'Pulling…',
  push: 'Pushing…',
  checkout: 'Checking out…',
  branch: 'Creating the branch…',
  stage: 'Staging…',
  unstage: 'Unstaging…',
  commit: 'Committing…',
  amend: 'Amending…',
}

// Asks the server for one change in the repository shown, then reads the repository again.
// The button that asked turns until the answer, and the notice says what is running, so the page never looks stopped.
async function act(request: Record<string, unknown>, done: string, button?: HTMLElement): Promise<boolean> {
  if (!detail || acting) return false
  const { system, path } = detail.repository
  const action = String(request.action)
  setBusy(true)
  button?.classList.add('running')
  notify(RUNNING[action] ?? 'Working…', '', 'running')
  let succeeded = false
  try {
    const { output } = await post<{ output: string }>('action', { system, path, ...request })
    succeeded = true
    acting = false
    await repository.reload().catch(() => undefined)
    notify(done, output, 'done')
  } catch (error) {
    acting = false
    await repository.reload().catch(() => undefined)
    notify(`${action[0].toUpperCase()}${action.slice(1)} did not go through`, error instanceof Error ? error.message : String(error), 'failed')
  }
  button?.classList.remove('running')
  setBusy(false)
  // The list of the repositories shows this one as it was before, until it reads again.
  list.clear()
  return succeeded
}

function actionButton(text: string, title: string, run: (button: HTMLButtonElement) => void, className = 'action small'): HTMLButtonElement {
  const button = node('button', text, className) as HTMLButtonElement
  button.type = 'button'
  button.title = title
  button.disabled = acting
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    run(button)
  })
  return button
}

// The message being written, kept while the page reads the repository again around it.
const message = node('textarea') as HTMLTextAreaElement
message.id = 'commit-message'
message.placeholder = 'Commit message'
message.rows = 3
message.setAttribute('aria-label', 'Commit message')
const commitButton = node('button', 'Commit', 'action') as HTMLButtonElement
commitButton.type = 'button'
// Amend puts what is staged into the last commit, under the message in the box, which starts as the message of that commit.
const amend = node('input') as HTMLInputElement
amend.type = 'checkbox'
amend.id = 'amend'
const amendLabel = node('label', '', 'amend')
amendLabel.append(amend, ' Amend the last commit')
const commitActions = node('div', '', 'commit-actions')
commitActions.append(amendLabel, commitButton)
const commitForm = node('div', '', 'commit-form')
commitForm.append(message, commitActions)
let stagedCount = 0
let last: LastCommit | undefined

function updateCommit(): void {
  // A commit pushed meanwhile, from a terminal, is no longer amended.
  if (!last || last.pushed) amend.checked = false
  amend.disabled = !last || last.pushed
  amendLabel.title = !last ? 'There is no commit to amend yet' : last.pushed ? 'The last commit is already pushed, so it is not amended' : 'Put what is staged into the last commit, and change its message'
  const empty = message.value.trim() === ''
  const off = empty || (!amend.checked && stagedCount === 0)
  commitButton.textContent = amend.checked ? 'Amend' : 'Commit'
  commitButton.dataset.off = String(off)
  commitButton.disabled = off || acting
  const staged = `${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`
  if (amend.checked) commitButton.title = empty ? 'Write a message to amend' : stagedCount === 0 ? 'Change the message of the last commit' : `Put ${staged} into the last commit`
  else commitButton.title = stagedCount === 0 ? 'Stage a file to commit it' : empty ? 'Write a message to commit' : `Commit ${staged}`
}

message.addEventListener('input', updateCommit)
amend.addEventListener('change', () => {
  if (amend.checked && last && message.value.trim() === '') message.value = last.message
  // The message of the last commit, left as it was, is not the start of a new one.
  if (!amend.checked && message.value === last?.message) message.value = ''
  updateCommit()
})
commitButton.addEventListener('click', () => {
  const action = amend.checked ? 'amend' : 'commit'
  void act({ action, message: message.value }, action === 'amend' ? 'Amended' : 'Committed', commitButton).then((succeeded) => {
    if (succeeded) {
      message.value = ''
      amend.checked = false
    }
    updateCommit()
  })
})

function graphCell(row: GraphRow, width: number, merge: boolean): SVGElement {
  const x = (lane: number) => lane * LANE + LANE / 2 + 2
  const middle = ROW / 2
  const drawing = svg('svg', { width, height: ROW, class: 'graph', 'aria-hidden': 'true' })
  const line = (lane: number, path: string) => drawing.append(svg('path', { d: path, class: `lane lane-${lane % 8}` }))
  for (const lane of row.through) line(lane, `M ${x(lane)} 0 V ${ROW}`)
  for (const [from, to] of row.moved) line(to, `M ${x(from)} 0 C ${x(from)} ${ROW}, ${x(to)} 0, ${x(to)} ${ROW}`)
  for (const lane of row.into) {
    line(lane, lane === row.column ? `M ${x(lane)} 0 V ${middle}` : `M ${x(lane)} 0 C ${x(lane)} ${middle}, ${x(row.column)} 0, ${x(row.column)} ${middle}`)
  }
  for (const lane of row.out) {
    line(lane, lane === row.column ? `M ${x(lane)} ${middle} V ${ROW}` : `M ${x(row.column)} ${middle} C ${x(row.column)} ${ROW}, ${x(lane)} ${middle}, ${x(lane)} ${ROW}`)
  }
  drawing.append(svg('circle', { cx: x(row.column), cy: middle, r: merge ? 3 : 4, class: `dot lane-${row.column % 8}${merge ? ' merge' : ''}` }))
  return drawing
}

function refBadges(commit: Commit, branches: Branch[]): HTMLElement[] {
  return commit.refs
    .filter((ref) => !/\/HEAD$/.test(ref))
    .map((ref) => {
      if (ref.startsWith('tag: ')) return node('span', ref.slice('tag: '.length), 'ref tag')
      if (ref.startsWith('HEAD -> ')) return node('span', ref.slice('HEAD -> '.length), 'ref head')
      if (ref === 'HEAD') return node('span', 'HEAD', 'ref head')
      return node('span', ref, branches.some((branch) => branch.remote && branch.name === ref) ? 'ref remote' : 'ref local')
    })
}

// The mark of a line of the history, empty for a commit IstarCI has no word on.
function paintMark(mark: HTMLElement, hash: string): void {
  const check = checks[hash]
  if (!check) {
    mark.textContent = ''
    mark.className = 'check'
    mark.removeAttribute('title')
    return
  }
  const { mark: symbol, tone, text } = checkOf(check)
  mark.textContent = symbol
  mark.className = `check ${tone}`
  mark.title = text
}

// The line of the changes of a commit that links to what IstarCI did with it, on the page of IstarCI.
function paintFact(fact: HTMLElement, hash: string): void {
  const check = checks[hash]
  fact.replaceChildren()
  fact.hidden = !check
  if (!check) return
  const { mark, tone, text } = checkOf(check)
  const link = node('a', '', `check-link ${tone}`) as HTMLAnchorElement
  link.href = check.url
  link.target = '_blank'
  link.rel = 'noopener'
  link.append(node('span', mark, 'check'), node('span', text))
  fact.append(link)
}

function paintChecks(): void {
  for (const [hash, line] of rows) {
    const mark = line.querySelector<HTMLElement>('.check')
    if (mark) paintMark(mark, hash)
  }
  const fact = element('detail').querySelector<HTMLElement>('.check-fact')
  if (fact?.dataset.hash) paintFact(fact, fact.dataset.hash)
}

async function loadChecks(system: string, path: string): Promise<void> {
  const answer = await get<{ checks: Record<string, Check> }>('checks', { system, path }).catch(() => undefined)
  // The answer for a repository left meanwhile is dropped, and a failed read keeps the marks of the one before.
  if (!answer || `${system}\n${path}` !== key) return
  checks = answer.checks
  paintChecks()
}

function choose(chosen: string): void {
  if (!detail) return
  location.hash = address({ system: detail.repository.system, path: detail.repository.path, commit: chosen })
}

function renderHistory(current: Loaded): void {
  const history = element('history')
  rows.clear()
  const created: HTMLElement[] = []
  const graph = layout(current.commits)
  const width = Math.min(Math.max(1, ...graph.map((row) => row.width)), LANES_SHOWN) * LANE + 6
  if (current.changes.length > 0) {
    // A line of the history like the commits, as the commit to come: a hollow dot, tied to the commit checked out when that one is the next line.
    const working = node('button', '', 'commit-row working-tree')
    const onHead = current.commits[0]?.refs.some((ref) => ref === 'HEAD' || ref.startsWith('HEAD -> ')) ?? false
    const drawing = svg('svg', { width, height: ROW, class: 'graph', 'aria-hidden': 'true' })
    const x = (onHead ? graph[0].column : 0) * LANE + LANE / 2 + 2
    if (onHead) drawing.append(svg('path', { d: `M ${x} ${ROW / 2} V ${ROW}`, class: 'lane pending' }))
    drawing.append(svg('circle', { cx: x, cy: ROW / 2, r: 4, class: 'dot pending' }))
    const files = `${current.changes.length} file${current.changes.length === 1 ? '' : 's'}`
    working.append(drawing, node('span', 'Uncommitted changes', 'subject'), node('span', '', 'author'), node('span', files, 'age'))
    working.addEventListener('click', () => choose(WORKING_TREE))
    rows.set(WORKING_TREE, working)
    created.push(working)
  }
  const now = Date.now()
  current.commits.forEach((commit, index) => {
    const line = node('button', '', 'commit-row')
    const text = node('span', '', 'subject')
    text.append(...refBadges(commit, current.branches), commit.subject)
    const mark = node('span', '', 'check')
    paintMark(mark, commit.hash)
    line.append(graphCell(graph[index], width, commit.parents.length > 1), text, mark, node('span', commit.author, 'author'), node('span', ago(commit.date, now), 'age'))
    line.title = commit.subject
    line.addEventListener('click', () => choose(commit.hash))
    rows.set(commit.hash, line)
    created.push(line)
  })
  if (current.commits.length === 0 && current.repository.error === undefined) created.push(node('p', 'No commit yet.', 'empty'))
  if (current.repository.error !== undefined) created.push(node('p', current.repository.error, 'error'))
  if (current.more) {
    const more = node('button', `Show ${PAGE} older commits`, 'more')
    more.addEventListener('click', () => {
      limit += PAGE
      more.setAttribute('disabled', '')
      void repository.reload().catch(() => more.removeAttribute('disabled'))
    })
    created.push(more)
  }
  history.replaceChildren(...created)
}

function renderBranches(current: Loaded): void {
  const group = (title: string, branches: Branch[]): HTMLElement[] => {
    if (branches.length === 0) return []
    const items = branches.map((branch) => {
      const item = node('button', '', `branch-item${branch.head ? ' head' : ''}`)
      item.append(node('span', branch.name, 'branch-name'))
      if (branch.gone) item.append(node('span', 'gone', 'track warn'))
      if (branch.ahead) item.append(node('span', `↑${branch.ahead}`, 'track info'))
      if (branch.behind) item.append(node('span', `↓${branch.behind}`, 'track warn'))
      item.title = branch.upstream ? `${branch.name}, tracking ${branch.upstream}` : branch.name
      item.addEventListener('click', () => choose(branch.commit))
      if (branch.head) return item
      // The name shows the commit of the branch, and the button beside it checks the branch out.
      const line = node('div', '', 'branch-line')
      const checkout = actionButton('Check out', `Check out ${branch.name}`, (button) => void act({ action: 'checkout', branch: branch.name }, `Checked out ${branch.name}`, button), 'action small checkout')
      checkout.setAttribute('aria-label', `Check out ${branch.name}`)
      line.append(item, checkout)
      return line
    })
    return [node('h3', title), ...items]
  }
  element('branches').replaceChildren(
    ...group(
      'Local',
      current.branches.filter((branch) => !branch.remote),
    ),
    ...group(
      'Remote',
      current.branches.filter((branch) => branch.remote),
    ),
  )
}

// Where the changes of one file are asked from: a commit, or what is staged or not in the working tree.
function open(from: string, path: string | undefined): void {
  if (!detail) return
  const group = from === 'staged' || from === 'unstaged' || from === 'untracked' ? from : undefined
  location.hash = address({ system: detail.repository.system, path: detail.repository.path, commit: group ? WORKING_TREE : from, group, file: path })
}

// What a file of the working tree can be asked: to be staged, or to leave the index.
interface FileAction {
  text: string
  title: string
  action: 'stage' | 'unstage'
}

// The files of a patch by name, each one opening its changes in place of the history.
function fileIndex(diff: Diff, from: string, change?: FileAction): HTMLElement[] {
  const index = node('ul', '', 'files index')
  for (const file of parseDiff(diff.patch)) {
    const entry = node('button', '', 'file-link')
    entry.append(statusOf(file.status), node('span', label(file), 'file-path'), ...counts(file))
    entry.classList.toggle('selected', shownFile?.path === file.path && shownFile.from === from)
    entry.addEventListener('click', () => open(from, file.path))
    const item = node('li')
    item.append(entry)
    if (change) {
      const done = change.action === 'stage' ? `Staged ${file.path}` : `Unstaged ${file.path}`
      const button = actionButton(change.text, `${change.title} ${file.path}`, (pressed) => void act({ action: change.action, files: [file.path] }, done, pressed))
      button.setAttribute('aria-label', `${change.title} ${file.path}`)
      item.append(button)
    }
    index.append(item)
  }
  const created = [index]
  if (diff.truncated) created.push(node('p', 'The changes are too large to list in full, and stop here.', 'empty'))
  return created
}

function fileList(title: string, files: FileChange[], letter: string): HTMLElement[] {
  if (files.length === 0) return []
  const list = node('ul', '', 'files')
  for (const file of files) {
    const item = node('li')
    item.append(node('span', letter, 'status'), node('span', label(file), 'file-path'))
    list.append(item)
  }
  return [node('h3', `${title} (${files.length})`), list]
}

async function patch(current: Loaded, of: string): Promise<Diff> {
  const cached = patches.get(of)
  if (cached) return cached
  const diff = await get<Diff>('diff', { system: current.repository.system, path: current.repository.path, target: of })
  // What is staged changes with the working tree, and is asked again at each read.
  if (diff.commit) patches.set(of, diff)
  return diff
}

// The changes of the file chosen, in place of the history, until closed.
async function renderFile(current: Loaded): Promise<void> {
  const view = element('diff')
  const shown = shownFile
  element('history').hidden = shown !== undefined
  view.hidden = shown === undefined
  if (!shown) return view.replaceChildren()
  const close = (): void => open(shown.from, undefined)
  try {
    const file = fileOf((await patch(current, shown.from)).patch, shown.path)
    if (shown !== shownFile) return
    if (!file) return view.replaceChildren(fileHead(close, node('span', shown.path, 'file-path')), node('p', 'This file is no longer among the changes.', 'empty'))
    view.replaceChildren(fileHead(close, statusOf(file.status), node('span', label(file), 'file-path'), ...counts(file)), ...diffLines(file))
    view.scrollTop = 0
  } catch (error) {
    if (shown !== shownFile) return
    view.replaceChildren(fileHead(close, node('span', shown.path, 'file-path')), node('p', error instanceof Error ? error.message : String(error), 'error'))
  }
}

async function renderDetail(current: Loaded): Promise<void> {
  const panel = element('detail')
  for (const [name, line] of rows) line.classList.toggle('selected', name === target)
  void renderFile(current)
  if (!target) {
    panel.replaceChildren(node('p', 'Choose a commit to see what it changed.', 'empty'))
    return
  }
  const shown = target
  try {
    const created: HTMLElement[] = []
    if (shown === WORKING_TREE) {
      const staged = current.changes.filter((file) => file.staged !== ' ' && file.staged !== 'U')
      const conflicts = current.changes.filter((file) => file.staged === 'U' || file.unstaged === 'U')
      const unstaged = current.changes.filter((file) => file.unstaged !== ' ' && file.unstaged !== '?' && file.unstaged !== 'U' && file.staged !== 'U')
      const untracked = current.changes.filter((file) => file.unstaged === '?')
      created.push(node('h2', 'Uncommitted changes'))
      if (current.changes.length === 0) created.push(node('p', 'The working tree is clean.', 'empty'))
      created.push(...fileList('In conflict', conflicts, 'U'))
      // A title of a part of the working tree, with the button that stages or unstages all of it.
      const title = (text: string, button?: HTMLButtonElement): HTMLElement => {
        const heading = node('h3', text, 'with-action')
        if (button) heading.append(button)
        return heading
      }
      const paths = (files: FileChange[]): string[] => files.map((file) => file.path)
      const stage: FileAction = { text: '+', title: 'Stage', action: 'stage' }
      stagedCount = staged.length
      last = current.last
      updateCommit()
      created.push(commitForm)
      if (staged.length > 0) {
        const all = actionButton('Unstage all', 'Take every file out of the index', (button) => void act({ action: 'unstage' }, 'Unstaged every file', button))
        created.push(title(`Staged (${staged.length})`, all), ...fileIndex(await patch(current, 'staged'), 'staged', { text: '−', title: 'Unstage', action: 'unstage' }))
      }
      if (unstaged.length + conflicts.length > 0) {
        const all = unstaged.length > 0 ? actionButton('Stage all', 'Stage every changed file', (button) => void act({ action: 'stage', files: paths(unstaged) }, 'Staged the changed files', button)) : undefined
        // The two Stage all buttons of the panel are told apart by what they stage.
        all?.setAttribute('aria-label', 'Stage all changed files')
        created.push(title(`Not staged (${unstaged.length + conflicts.length})`, all), ...fileIndex(await patch(current, 'unstaged'), 'unstaged', stage))
      }
      if (untracked.length > 0) {
        const all = actionButton('Stage all', 'Stage every file not tracked', (button) => void act({ action: 'stage', files: paths(untracked) }, 'Staged the new files', button))
        all.setAttribute('aria-label', 'Stage all new files')
        created.push(title(`Untracked (${untracked.length})`, all), ...fileIndex(await patch(current, 'untracked'), 'untracked', stage))
      }
    } else {
      const diff = await patch(current, shown)
      const [subject, ...body] = (diff.commit?.message ?? '').split('\n')
      created.push(node('h2', subject))
      if (body.join('\n').trim()) created.push(node('pre', body.join('\n').trim(), 'body'))
      const facts = node('p', '', 'facts')
      const hash = node('code', shown.slice(0, 10))
      hash.title = shown
      facts.append(hash, node('span', diff.commit?.author ?? ''), node('span', diff.commit ? new Date(diff.commit.date).toLocaleString() : ''))
      created.push(facts)
      const fact = node('p', '', 'check-fact')
      fact.dataset.hash = shown
      paintFact(fact, shown)
      created.push(fact)
      if (diff.patch === '') created.push(node('p', 'This commit changes no file.', 'empty'))
      else created.push(node('h3', 'Files'), ...fileIndex(diff, shown))
    }
    // The answer of a commit left for another one meanwhile is dropped.
    if (shown !== target) return
    // A message being written keeps its place and its caret, which taking the box out of the page and back would lose.
    const writing = document.activeElement === message ? [message.selectionStart, message.selectionEnd] : undefined
    panel.replaceChildren(...created)
    if (writing && message.isConnected) {
      message.focus()
      message.setSelectionRange(writing[0], writing[1])
    }
  } catch (error) {
    if (shown === target) panel.replaceChildren(node('p', error instanceof Error ? error.message : String(error), 'error'))
  }
}

// The page of the remote, which opens in a tab of its own, and only on the web, as a link to anything else would leave the interface for the machine.
function showWeb(web: string | undefined): void {
  const link = element<HTMLAnchorElement>('repository-web')
  const url = web ? new URL(web) : undefined
  link.hidden = !url || (url.protocol !== 'https:' && url.protocol !== 'http:')
  if (!url || link.hidden) return link.removeAttribute('href')
  link.href = url.href
  link.textContent = `${url.host} ↗`
  link.title = `Open ${url.href}`
}

function render(current: Loaded): void {
  element('repository-name').textContent = current.repository.name
  element('repository-path').textContent = current.repository.path
  showWeb(current.web)
  const state = element('repository-state')
  state.replaceChildren()
  if (current.repository.branch) state.append(node('span', current.repository.branch, 'branch'))
  else if (current.repository.head) state.append(node('span', `detached at ${current.repository.head}`, 'branch detached'))
  if (current.repository.error === undefined) state.append(...badges([...sync(current.repository), ...changes(current.repository)], 'span').children)
  renderBranches(current)
  renderHistory(current)
  void renderDetail(current)
}

resizable('resize', 'history', 'diff')

for (const button of actionButtons()) {
  const action = button.dataset.action as string
  const done: Record<string, string> = { fetch: 'Fetched', pull: 'Pulled', push: 'Pushed' }
  button.addEventListener('click', () => void act({ action }, done[action], button))
}

function actionButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('#actions [data-action]')]
}

// The name of a new branch is asked in a line of its own, which Create and Enter send, and Cancel and Escape close.
{
  const form = element<HTMLFormElement>('branch-form')
  const name = element<HTMLInputElement>('branch-name')
  const close = (): void => {
    form.hidden = true
    name.value = ''
  }
  element('new-branch').addEventListener('click', () => {
    form.hidden = false
    name.focus()
  })
  element('branch-cancel').addEventListener('click', close)
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close()
      event.stopPropagation()
    }
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const branch = name.value.trim()
    if (branch === '') return
    void act({ action: 'branch', branch }, `Created ${branch}`, form.querySelector<HTMLElement>('[type=submit]') ?? undefined).then((succeeded) => {
      if (succeeded) close()
    })
  })
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && shownFile && !repository.section.hidden) open(shownFile.from, undefined)
})

// One repository: its branches, its history as a graph, and the changes of the commit chosen.
export const repository = {
  section: element('repository'),
  // The last folder names a repository, whichever separator its system uses.
  title: (params: URLSearchParams): string => (params.get('path') ?? '').split(/[\\/]/).filter(Boolean).pop() ?? 'Repository',
  loaded: (): boolean => detail !== undefined,
  clear: (): void => {
    detail = undefined
  },
  async show(params: URLSearchParams): Promise<{ machine: string; version: string; scannedAt: string } | void> {
    const asked = `${params.get('system')}\n${params.get('path')}`
    target = params.get('commit') ?? undefined
    const file = params.get('file')
    const from = target === WORKING_TREE ? params.get('group') : target
    shownFile = file && from ? { path: file, from } : undefined
    if (detail && asked === key) return void renderDetail(detail)
    // Another repository starts from its newest commits, with nothing of the one before on the page.
    key = asked
    limit = PAGE
    detail = undefined
    patches.clear()
    checks = {}
    message.value = ''
    element('branch-form').hidden = true
    for (const id of ['branches', 'history', 'diff', 'detail', 'repository-state']) element(id).replaceChildren()
    element('repository-name').textContent = ''
    element('repository-path').textContent = params.get('path') ?? ''
    showWeb(undefined)
    return this.reload()
  },
  async reload(): Promise<{ machine: string; version: string; scannedAt: string }> {
    const [system, path] = key.split('\n')
    const loaded = await get<Loaded>('repository', { system, path, limit: String(limit) })
    // The answer for a repository left meanwhile is dropped.
    if (`${system}\n${path}` !== key) return loaded
    detail = loaded
    render(detail)
    void loadChecks(system, path)
    return detail
  },
}
