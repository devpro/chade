import { join } from 'node:path'
import { expect, test } from './fixtures.js'
import { RepositoryPage } from './pages/RepositoryPage.js'
import { shot } from './shot.js'

test('the name of a repository opens its page, and the link back returns to the system it was listed under', async ({ page, repositories }) => {
  await repositories.showSystem('wsl-ubuntu')
  await repositories.openRepository('history')
  const history = new RepositoryPage(page)
  await history.expectOpen('history')
  await expect(history.path).toHaveText(/wsl-ubuntu.history$/)
  await history.back()
  await expect(repositories.tab('wsl-ubuntu')).toHaveAttribute('aria-selected', 'true')
  await expect(repositories.names).toHaveCount(9)
  // The browser goes back to the repository as well.
  await page.goBack()
  await history.expectOpen('history')
})

test('a click anywhere on the row of a repository opens its page', async ({ page, repositories }) => {
  await repositories.showSystem('wsl-ubuntu')
  await repositories.openRow('history')
  await new RepositoryPage(page).expectOpen('history')
})

test('a file of a commit opens its changes in place of the history, and another file of the list takes its place', async ({ page, history }) => {
  await history.workingTree.click()
  await expect(history.files).toHaveText(['Astaged.txt+1', 'MREADME.md+2', 'Anotes.txt+1'])
  await history.openFile('staged.txt')
  await expect(history.history).toBeHidden()
  await expect(history.comparison.added).toHaveText(['ready'])
  await expect(history.files.filter({ hasText: 'staged.txt' })).toHaveClass(/selected/)
  // The list of the files stays, to go from one to the next without the history.
  await history.openFile('README.md')
  await expect(history.comparison.added).toHaveText(['', 'Edited, not staged.'])
  await expect(history.files.filter({ hasText: 'staged.txt' })).not.toHaveClass(/selected/)
  // The file is part of the address, so it stays open when the page is loaded again.
  await page.reload()
  await expect(history.comparison.path).toHaveText('README.md')
  await history.comparison.close()
  await expect(history.history).toBeVisible()
  await expect(history.comparison.view).toBeHidden()
  await expect(history.heading).toHaveText('Uncommitted changes')
})

test('the Escape key and another commit both leave the changes of a file for the history', async ({ page, history }) => {
  await history.choose('Change the guide')
  await history.openFile('guide.md')
  await page.keyboard.press('Escape')
  await expect(history.history).toBeVisible()
  await history.openFile('guide.md')
  await history.branch('feature/graph').click()
  await expect(history.history).toBeVisible()
  await expect(history.heading).toHaveText('Draw the graph')
})

test('the bar between the history and the changes resizes them, and the width is kept @layout', async ({ page, history }, testInfo) => {
  await history.choose('Change the guide')
  const before = await history.historyWidth()
  await history.resizeHistory(-260)
  const narrowed = await history.historyWidth()
  expect(narrowed).toBeGreaterThan(before - 275)
  expect(narrowed).toBeLessThan(before - 245)
  await shot(page, testInfo, 'history-narrowed')
  await page.reload()
  await history.expectOpen('history')
  expect(await history.historyWidth()).toBe(narrowed)
  // Neither side is dragged down to nothing.
  await history.resizeHistory(-2000)
  expect(await history.historyWidth()).toBe(240)
  await history.resizer.dblclick()
  expect(await history.historyWidth()).toBe(before)
})

test('a repository shows its state, its branches, and its history from the newest commit @layout', async ({ page, history }, testInfo) => {
  await expect(history.state).toHaveText('main↑ 12 changed1 untracked')
  await expect(history.branches).toHaveText(['feature/graph', 'main↑1', 'origin/main'])
  await expect(history.branch('main')).toHaveClass(/head/)
  await expect(history.workingTree).toHaveText('Uncommitted changes3 files')
  await expect(history.subjects).toContainText(['Rename the guide', 'Merge feature/graph'])
  await expect(history.commits).toHaveCount(6)
  await expect(history.commits.last()).toContainText('Start history')
  // Each commit carries the names pointing at it: the branch checked out, the other ones, the remote ones and the tags.
  await expect(history.refs('Rename the guide')).toHaveText(['main'])
  await expect(history.refs('Merge feature/graph')).toHaveText(['v1.0', 'origin/main'])
  await expect(history.refs('Draw the graph')).toHaveText(['feature/graph'])
  // Every commit has its dot, and the merge two lines leaving it.
  await expect(history.commits.locator('svg circle')).toHaveCount(6)
  // The uncommitted changes are one more line of the graph, tied to the commit checked out.
  await expect(history.workingTree.locator('svg circle')).toHaveCount(1)
  await expect(history.workingTree.locator('svg path')).toHaveCount(1)
  await expect(history.commit('Merge feature/graph').locator('svg path')).toHaveCount(3)
  await expect(history.changes).toHaveText('Choose a commit to see what it changed.')
  await shot(page, testInfo, 'repository')
})

test('a commit shows its message and its files, stays chosen when the page is loaded again, and a file shows the lines changed @layout', async ({ page, history }, testInfo) => {
  await history.choose('Change the guide')
  await expect(history.heading).toHaveText('Change the guide')
  await expect(history.body).toHaveText('The second step has a shorter name, and the last one was missing.')
  await expect(history.files).toHaveText(['Mguide.md+2−1'])
  await shot(page, testInfo, 'commit')
  expect(new URL(page.url()).hash).toMatch(/commit=[0-9a-f]{40}$/)
  await page.reload()
  await expect(history.heading).toHaveText('Change the guide')
  await expect(history.commit('Change the guide')).toHaveClass(/selected/)
  await history.openFile('guide.md')
  await expect(history.comparison.status).toHaveText('M')
  await expect(history.comparison.removed).toHaveText(['Configure'])
  await expect(history.comparison.added).toHaveText(['Set up', 'Stop'])
  await shot(page, testInfo, 'file')
})

test('a merge shows what the branch brought, and a rename the two names of the file', async ({ history }) => {
  await history.choose('Merge feature/graph')
  await expect(history.files).toHaveText(['Agraph.txt+1'])
  await history.openFile('graph.txt')
  await expect(history.comparison.added).toHaveText(['lanes'])
  await history.comparison.close()
  await history.choose('Rename the guide')
  await expect(history.files).toHaveText(['Rguide.md → manual.md'])
  await history.openFile('manual.md')
  await expect(history.comparison.path).toHaveText('guide.md → manual.md')
  await expect(history.comparison.note).toHaveText('Renamed, with no change of content.')
})

test('the uncommitted changes show what is staged, what is not, and the files not tracked @layout', async ({ page, history }, testInfo) => {
  await history.workingTree.click()
  await expect(history.heading).toHaveText('Uncommitted changes')
  await expect(history.changes.locator('h3')).toHaveText([/^Staged \(1\)/, /^Not staged \(1\)/, /^Untracked \(1\)/])
  await expect(history.files).toHaveText(['Astaged.txt+1', 'MREADME.md+2', 'Anotes.txt+1'])
  // A file not tracked yet shows its content, as lines added.
  await history.openFile('notes.txt')
  await expect(history.comparison.added).toHaveText(['not tracked'])
  await history.comparison.close()
  await shot(page, testInfo, 'working-tree')
})

test('a branch chooses the commit it points at', async ({ history }) => {
  await history.branch('feature/graph').click()
  await expect(history.heading).toHaveText('Draw the graph')
  await expect(history.commit('Draw the graph')).toHaveClass(/selected/)
})

test('a commit subject and a line of a file are text, whatever they hold', async ({ page, server }) => {
  const ahead = new RepositoryPage(page)
  await ahead.signIn(server.url, 'wsl-ubuntu', join(server.root, 'wsl-ubuntu', 'ahead'))
  await ahead.expectOpen('ahead')
  await ahead.choose('Change the file, which <b>is not</b> markup')
  await expect(ahead.heading).toHaveText('Change the file, which <b>is not</b> markup')
  await ahead.openFile('a.txt')
  await expect(ahead.comparison.added).toHaveText(['two'])
  await expect(ahead.page.locator('#repository b')).toHaveCount(0)
})

test('a folder that is no repository of the machine is refused', async ({ page, server }) => {
  const outside = new RepositoryPage(page)
  await outside.signIn(server.url, 'wsl-ubuntu', join(server.root, 'remotes'))
  await expect(outside.message).toHaveText(/remotes is not a repository under the repos folders of wsl-ubuntu/)
  await expect(outside.commits).toHaveCount(0)
})

test('a repository git cannot read says why, in place of its history', async ({ page, server }) => {
  const interrupted = new RepositoryPage(page)
  await interrupted.signIn(server.url, 'wsl-ubuntu', join(server.root, 'wsl-ubuntu', 'interrupted'))
  await expect(interrupted.name).toHaveText('interrupted')
  await expect(page.locator('#history .error')).toContainText('not a git repository')
})
