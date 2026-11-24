import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeOf, isNewer, toolOutdated, updateCounts, updatesOf, type Dependency } from '../src/inventory.js'
import { technologiesOf } from '../src/technologies.js'

test('the technologies come from the names of the files', () => {
  assert.deepEqual(technologiesOf(['src/App/App.csproj', 'web/package.json', 'infra/main.tf', 'Dockerfile.dev', 'chart/Chart.yaml', '.github/workflows/ci.yaml']), ['dotnet', 'nodejs', 'terraform', 'helm', 'docker', 'github-actions'])
  assert.deepEqual(technologiesOf(['docker-compose.override.yml']), ['docker'])
  assert.deepEqual(technologiesOf(['README.md', 'docs/package.json.md', 'workflows/ci.yaml']), [])
})

test('a release is newer than its pre-release and than a lower number', () => {
  assert.equal(isNewer('2.10.1', '2.9.2'), true)
  assert.equal(isNewer('2.0.0', '2.0.0-rc.1'), true)
  assert.equal(isNewer('2.0.0-rc.1', '2.0.0'), false)
  assert.equal(isNewer('v1.2.3', '1.2.3'), false)
  assert.equal(isNewer('latest', '1.2.3'), false)
  assert.deepEqual([changeOf('1.2.3', '2.0.0'), changeOf('1.2.3', '1.3.0'), changeOf('1.2.3', '1.2.4'), changeOf('16-alpine', '18-alpine'), changeOf('5:29.1.0-1', '5:30.0.0-1')], ['major', 'minor', 'patch', 'major', 'major'])
})

test('apt decides for its own tools', () => {
  const tool = { system: 'linux', name: 'trivy', version: '0.76.2', latest: '0.76.2-ubuntu1' }
  assert.equal(toolOutdated({ ...tool, source: 'apt' }), true)
  assert.equal(toolOutdated({ ...tool, source: 'direct' }), false)
  assert.equal(toolOutdated({ system: 'linux', name: 'x', source: 'direct', latest: '1.0.0' }), false)
})

test('the updates are one for each package and version, those with a fix first', () => {
  const use = (name: string, current: string, latest: string | undefined, more: Partial<Dependency> = {}): Dependency => ({ system: 'linux', repository: '/r/a', repositoryName: 'a', file: 'package.json', kind: 'npm', name, current, latest, ...more })
  const all = [use('b', '1.0.0', '2.0.0'), use('a', '1.0.0', '1.0.1'), use('c', '1.0.0', '1.0.0'), use('d', '1.0.0', '3.0.0', { fixes: 1 }), use('b', '1.9.0', '2.0.0', { repository: '/r/b' }), use('e', '1.0.0', undefined)]
  assert.deepEqual(updatesOf([use('node', '24', '24', { kind: 'image', rebuilt: true })]).map((one) => one.change), ['rebuilt'])
  assert.deepEqual(updatesOf(all).map((one) => [one.name, one.change, one.uses.length]), [['d', 'major', 1], ['a', 'patch', 1], ['b', 'major', 2]])
  assert.deepEqual(updateCounts(all), [
    { system: 'linux', path: '/r/a', count: 3, fixes: 1 },
    { system: 'linux', path: '/r/b', count: 1, fixes: 0 },
  ])
})
