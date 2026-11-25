import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'
import { RepositoryPage } from './pages/RepositoryPage.js'
import { shot } from './shot.js'

// The tests change one repository, each from the state the one before left it in, as a session at the interface does.
// They run once, on the first screen, as a second run would start from what the first one left.
test.describe.configure({ mode: 'serial' })

let work: RepositoryPage
let folder: string

const git = (...args: string[]): string => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' }).trim()

test.beforeEach(async ({ page, server }) => {
  folder = join(server.root, 'sandbox', 'work')
  work = new RepositoryPage(page)
  await work.signIn(server.url, 'sandbox', folder)
  await work.expectOpen('work')
})

test('a fetch shows what the remote has, and a pull brings it to the branch', async ({ page }, testInfo) => {
  await expect(work.state).toHaveText('mainin sync1 changed1 untracked')
  await expect(work.branches).toHaveText(['main', 'origin/main'])
  await work.run('Fetch', 'Fetched')
  await expect(work.state).toHaveText('main↓ 11 changed1 untracked')
  await expect(work.branches).toHaveText(['main↓1', 'origin/main', 'origin/review'])
  await expect(work.refs('Add a file from another machine')).toHaveText(['origin/main'])
  await shot(page, testInfo, 'fetched')
  await work.run('Pull', 'Pulled')
  await expect(work.state).toHaveText('mainin sync1 changed1 untracked')
  await expect(work.refs('Add a file from another machine')).toHaveText(['main', 'origin/main'])
  expect(git('log', '-1', '--format=%s')).toBe('Add a file from another machine')
})

test('files are staged and unstaged one by one or all at once, and committed with a message', async ({ page }, testInfo) => {
  await work.workingTree.click()
  await expect(work.part('Not staged')).toHaveText(['README.md'])
  await expect(work.part('Untracked')).toHaveText(['draft.txt'])
  // Nothing staged and no message: nothing to commit.
  await expect(work.commitButton).toBeDisabled()
  await work.stage('draft.txt')
  await expect(work.part('Staged')).toHaveText(['draft.txt'])
  await expect(work.changes.locator('h3')).toHaveText([/^Staged \(1\)/, /^Not staged \(1\)/])
  await work.unstage('draft.txt')
  await expect(work.part('Untracked')).toHaveText(['draft.txt'])
  await work.stage('README.md')
  await expect(work.part('Staged')).toHaveText(['README.md'])
  await work.page.getByRole('button', { name: 'Stage all new files' }).click()
  await expect(work.part('Staged')).toHaveText(['README.md', 'draft.txt'])
  await expect(work.commitButton).toBeDisabled()
  await work.commitMessage.fill('Describe the work\n\nAnd keep the draft.')
  await expect(work.commitButton).toBeEnabled()
  await shot(page, testInfo, 'ready-to-commit')
  await work.commitButton.click()
  await expect(work.notice).toHaveText('Committed')
  // The commit is the newest line of the history, the working tree is clean, and the message box is empty for the next one.
  await expect(work.subjects.first()).toHaveText('mainDescribe the work')
  await expect(work.workingTree).toHaveCount(0)
  await expect(work.state).toHaveText('main↑ 1clean')
  await expect(work.commitMessage).toHaveValue('')
  expect(git('log', '-1', '--format=%B')).toBe('Describe the work\n\nAnd keep the draft.')
  expect(git('status', '--porcelain')).toBe('')
})

test('a message being written stays, with its caret, while the page reads the repository again', async ({ page }) => {
  writeFileSync(join(folder, 'later.txt'), 'later\n')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await work.workingTree.click()
  await work.commitMessage.fill('Half a mess')
  // A commit made in a terminal meanwhile, which the next read of the page shows, as its read every 30 seconds would.
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '--quiet', '--allow-empty', '--message', 'An empty commit')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(work.subjects.first()).toContainText('An empty commit')
  await expect(work.commitMessage).toBeFocused()
  await page.keyboard.type('age')
  await expect(work.commitMessage).toHaveValue('Half a message')
})

test('an amend puts what is staged into the last commit, under the message it starts from', async ({ page }, testInfo) => {
  writeFileSync(join(folder, 'forgotten.txt'), 'forgotten\n')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await work.workingTree.click()
  await work.stage('forgotten.txt')
  await work.amend.check()
  await expect(work.commitMessage).toHaveValue('An empty commit')
  await work.commitMessage.fill('Add the forgotten file')
  await shot(page, testInfo, 'ready-to-amend')
  await work.amendButton.click()
  await expect(work.notice).toHaveText('Amended')
  await expect(work.subjects.first()).toHaveText('mainAdd the forgotten file')
  await expect(work.state).toHaveText('main↑ 21 untracked')
  await expect(work.commitMessage).toHaveValue('')
  await expect(work.amend).not.toBeChecked()
  expect(git('show', '--format=%s', '--name-only', 'HEAD')).toBe('Add the forgotten file\n\nforgotten.txt')
  // Unchecked again, the message of the last commit leaves the box.
  await work.amend.check()
  await work.amend.uncheck()
  await expect(work.commitMessage).toHaveValue('')
})

test('a push sends the commits, and the branch is in sync again, its last commit no longer amended', async () => {
  await expect(work.state).toHaveText('main↑ 21 untracked')
  await work.run('Push', 'Pushed')
  await expect(work.state).toHaveText('mainin sync1 untracked')
  expect(git('rev-list', '--count', 'origin/main..main')).toBe('0')
  await work.workingTree.click()
  await expect(work.amend).toBeDisabled()
})

test('a new branch is checked out as it is created, and its first push gives it an upstream', async ({ page }, testInfo) => {
  await work.createBranch('feature/new')
  await expect(work.notice).toHaveText('Created feature/new')
  await expect(work.branch('feature/new')).toHaveClass(/head/)
  await expect(work.state).toHaveText('feature/newno upstream1 untracked')
  await work.run('Push', 'Pushed')
  await expect(work.state).toHaveText('feature/newin sync1 untracked')
  await expect(work.branches).toHaveText(['feature/new', 'main', 'origin/feature/new', 'origin/main', 'origin/review'])
  await shot(page, testInfo, 'new-branch')
})

test('a branch is checked out from the list, a remote one as the local branch that tracks it', async () => {
  await work.checkOut('main')
  await expect(work.branch('main')).toHaveClass(/head/)
  await work.checkOut('origin/review')
  await expect(work.branch('review')).toHaveClass(/head/)
  await expect(work.state).toHaveText('reviewin sync1 untracked')
  expect(git('branch', '--show-current')).toBe('review')
  await work.checkOut('main')
})

test('a branch that is not checked out is pulled where it is, the working tree untouched', async ({ page, server }, testInfo) => {
  // The remote gets a commit on review, from the clone that made the branch.
  const elsewhere = join(server.root, 'elsewhere')
  execFileSync('git', ['-C', elsewhere, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '--quiet', '--allow-empty', '--message', 'Answer the review'])
  execFileSync('git', ['-C', elsewhere, 'push', '--quiet'])
  await work.run('Fetch', 'Fetched')
  await expect(work.branch('review')).toHaveText('review↓1')
  await work.branch('review').hover()
  await shot(page, testInfo, 'branch-actions')
  await work.pullBranch('review')
  await expect(work.branch('review')).toHaveText('review')
  await expect(work.refs('Answer the review')).toHaveText(['origin/review', 'review'])
  expect(git('branch', '--show-current')).toBe('main')
  expect(git('status', '--porcelain')).toBe('?? later.txt')
})

test('a branch is deleted after a question, which says the commits that would be lost with it', async ({ page }, testInfo) => {
  // Pushed: the remote branch holds its commits.
  await work.askDelete('feature/new')
  await expect(work.deleteQuestion).toHaveText('Delete feature/new? Its commits stay, in another branch or under a tag.')
  await work.confirmDelete('feature/new')
  await expect(work.branches).toHaveText(['main', 'review', 'origin/feature/new', 'origin/main', 'origin/review'])
  // Squash merged on the remote, as a branch whose commits no other branch holds.
  git('branch', 'squashed')
  git('switch', '--quiet', 'squashed')
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '--quiet', '--allow-empty', '--message', 'Work that was squashed')
  git('switch', '--quiet', 'main')
  await page.getByRole('button', { name: 'Refresh' }).click()
  await work.askDelete('squashed')
  await expect(work.deleteQuestion).toHaveText('Delete squashed? 1 commit is in no other branch or tag, and is lost with it.')
  await shot(page, testInfo, 'delete-branch')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(work.deleteQuestion).toBeHidden()
  expect(git('branch', '--list', 'squashed')).toContain('squashed')
  await work.askDelete('squashed')
  await work.confirmDelete('squashed')
  await expect(work.branch('squashed')).toHaveCount(0)
  expect(git('branch', '--list', 'squashed')).toBe('')
  // The branch checked out has no button to delete it.
  await expect(page.getByRole('button', { name: 'Delete main', exact: true })).toHaveCount(0)
})

test('what git refuses is said in its own words, and stays until dismissed', async ({ page }, testInfo) => {
  await work.createBranch('two words')
  await expect(work.notice).toHaveText('Branch did not go through')
  await expect(work.noticeText).toHaveText('two words is not a valid branch name')
  await shot(page, testInfo, 'refused')
  // The name stays in its box, to be corrected.
  await expect(page.getByRole('textbox', { name: 'Name of the new branch' })).toHaveValue('two words')
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(work.notice).toBeHidden()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('textbox', { name: 'Name of the new branch' })).toBeHidden()
  expect(git('branch', '--show-current')).toBe('main')
})

test('while git works, the button that asked turns and the notice says what is running', async ({ page }) => {
  // A remote that takes its time, as a push over the network does.
  await page.route('**/api/action', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.fallback()
  })
  const fetch = page.getByRole('button', { name: 'Fetch', exact: true })
  await fetch.click()
  await expect(work.notice).toHaveText('Fetching…')
  await expect(fetch).toHaveClass(/running/)
  await expect(page.getByRole('button', { name: 'Push', exact: true })).toBeDisabled()
  await expect(work.notice).toHaveText('Fetched')
  await expect(fetch).not.toHaveClass(/running/)
  await expect(fetch).toBeEnabled()
})

test('the list shows a repository as an action or a terminal left it, without asking', async ({ page, repositories }) => {
  await page.getByRole('link', { name: 'chade' }).click()
  await repositories.showSystem('sandbox')
  await expect(repositories.repository('work').upstream).toHaveText('in sync')
  await repositories.openRow('work')
  await work.expectOpen('work')
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', 'commit', '--quiet', '--allow-empty', '--message', 'One more commit')
  await work.back()
  await expect(repositories.repository('work').upstream).toHaveText('↑ 1Push')
})

test('the list pushes and pulls a repository in one click, the button turning until git answers', async ({ page, repositories, server }, testInfo) => {
  await page.getByRole('link', { name: 'chade' }).click()
  await repositories.showSystem('sandbox')
  const row = repositories.repository('work')
  await expect(row.upstream).toHaveText('↑ 1Push')
  await expect(row.sync('Pull')).toHaveCount(0)
  // A remote that takes its time, as a push over the network does.
  await page.route('**/api/action', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.fallback()
  })
  await row.sync('Push').click()
  await expect(work.notice).toHaveText('Pushing work…')
  await expect(row.sync('Push')).toHaveClass(/running/)
  await shot(page, testInfo, 'list-pushing')
  await expect(work.notice).toHaveText('Pushed work')
  await expect(row.upstream).toHaveText('in sync')
  expect(git('rev-list', '--count', 'origin/main..main')).toBe('0')
  // A commit pushed from another clone, which a fetch in a terminal brings.
  const elsewhere = join(server.root, 'elsewhere')
  const there = (...args: string[]): string => execFileSync('git', ['-C', elsewhere, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.test', ...args], { encoding: 'utf8' })
  there('switch', '--quiet', 'main')
  there('pull', '--quiet', '--no-rebase')
  there('commit', '--quiet', '--allow-empty', '--message', 'One more from elsewhere')
  there('push', '--quiet')
  git('fetch', '--quiet')
  await repositories.refresh()
  await expect(row.upstream).toHaveText('↓ 1Pull')
  await row.sync('Pull').click()
  await expect(work.notice).toHaveText('Pulled work')
  await expect(row.upstream).toHaveText('in sync')
  expect(git('log', '-1', '--format=%s')).toBe('One more from elsewhere')
  // The page of the repository, read before the pull, reads it again.
  await repositories.openRow('work')
  await expect(work.subjects.first()).toContainText('One more from elsewhere')
})
