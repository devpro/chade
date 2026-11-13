import { expect, test } from './fixtures.js'
import { RepositoryPage } from './pages/RepositoryPage.js'

test('a commit IstarCI ran is marked in the history with what came of it', async ({ history }) => {
  await expect(history.check('Merge feature/graph')).toHaveText('✓')
  await expect(history.check('Merge feature/graph')).toHaveAttribute('title', 'Passed on IstarCI in 1 min 52 s')
  await expect(history.check('Change the guide')).toHaveAttribute('title', 'Failed on IstarCI after 5 s')
  await expect(history.check('Rename the guide')).toHaveAttribute('title', 'Running on IstarCI')
  await expect(history.check('Start history')).toHaveAttribute('title', 'Stopped on IstarCI')
  // A workflow run by hand on a commit is not its pipeline, which IstarCI left out.
  await expect(history.check('Draw the graph')).toHaveAttribute('title', 'Not run by IstarCI: A newer commit replaced it in the queue')
  await expect(history.check('Add the guide')).toHaveText('')
})

test('the changes of a commit link to its run in IstarCI, or to the repository for a commit not run', async ({ history, server }) => {
  await history.choose('Merge feature/graph')
  await expect(history.checkLink).toHaveText('✓Passed on IstarCI in 1 min 52 s')
  await expect(history.checkLink).toHaveAttribute('href', `${server.istarci}/#/run/run-merge`)
  await expect(history.checkLink).toHaveAttribute('target', '_blank')
  await history.choose('Draw the graph')
  await expect(history.checkLink).toHaveAttribute('href', new RegExp(`^${server.istarci}/#/repo/`))
  await history.choose('Add the guide')
  await expect(history.checkLink).toHaveCount(0)
})

test('a repository of Windows is marked as well', async ({ page, server }) => {
  const portal = new RepositoryPage(page)
  await portal.signIn(server.url, 'windows', `${server.root}/windows/portal`)
  await portal.expectOpen('portal')
  await expect(portal.check('Start portal')).toHaveAttribute('title', 'Passed on IstarCI in 40 s')
})

test('an IstarCI that does not answer leaves the page as it is without it', async ({ page, server }) => {
  const detached = new RepositoryPage(page)
  // IstarCI is given up on after a second, and the answer of chade then holds no check.
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/checks')
  await detached.signIn(server.url, 'wsl-ubuntu', `${server.root}/wsl-ubuntu/detached`)
  await detached.expectOpen('detached')
  await expect(detached.subjects).toContainText(['Start detached'])
  await detached.choose('Start detached')
  await answered
  await expect(detached.check('Start detached')).toHaveText('')
  await expect(detached.checkLink).toHaveCount(0)
  await expect(detached.notice).toBeHidden()
  await expect(detached.changes.locator('.error')).toHaveCount(0)
})

test('the list gives what IstarCI said last about each repository it watches, grey when it is about an older commit', async ({ repositories, server }) => {
  await repositories.showSystem('wsl-ubuntu')
  await expect(repositories.page.getByRole('columnheader', { name: 'IstarCI' })).toBeVisible()
  const history = repositories.repository('history').check
  await expect(history).toHaveText('●')
  await expect(history).toHaveAttribute('href', `${server.istarci}/#/run/run-rename`)
  await expect(history).toHaveAttribute('title', /^Running on IstarCI, for [0-9a-f]{7}$/)
  const ahead = repositories.repository('ahead').check
  await expect(ahead).toHaveText('✕')
  await expect(ahead).toHaveClass(/quiet/)
  await expect(ahead).toHaveAttribute('title', /^Failed on IstarCI, for [0-9a-f]{7} on main, not the commit checked out$/)
  await expect(repositories.repository('clean').check).toHaveCount(0)
  await repositories.showSystem('windows')
  await expect(repositories.repository('portal').check).toHaveText('✓')
})

test('a list IstarCI says nothing of has no IstarCI column', async ({ repositories }) => {
  await repositories.showSystem('wsl-ubuntu')
  await expect(repositories.page.getByRole('columnheader', { name: 'IstarCI' })).toBeVisible()
  // The filter keeps a repository IstarCI does not watch.
  await repositories.filter('clean')
  await expect(repositories.names).toHaveText(['clean'])
  await expect(repositories.page.getByRole('columnheader', { name: 'IstarCI' })).toHaveCount(0)
  // A system none of whose repositories IstarCI watches.
  await repositories.filter('')
  await repositories.showSystem('sandbox')
  await expect(repositories.names).toHaveText(['work'])
  await expect(repositories.page.getByRole('columnheader', { name: 'Fetched' })).toBeVisible()
  await expect(repositories.page.getByRole('columnheader', { name: 'IstarCI' })).toHaveCount(0)
})
