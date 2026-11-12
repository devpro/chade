import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forgeOf, mainRemote, parseRemoteUrls } from '../src/index.js'

test('the forge of a remote is told by its host, over https as over ssh', () => {
  assert.deepEqual(forgeOf('git@github.com:ada/work.git'), { forge: 'github', host: 'github.com' })
  assert.deepEqual(forgeOf('https://github.example.test/ada/work.git'), { forge: 'github', host: 'github.example.test' })
  assert.deepEqual(forgeOf('ssh://git@gitlab.com:22/group/sub/work.git'), { forge: 'gitlab', host: 'gitlab.com' })
  assert.deepEqual(forgeOf('https://gitlab.example.test/group/work'), { forge: 'gitlab', host: 'gitlab.example.test' })
  assert.deepEqual(forgeOf('https://ada@dev.azure.com/ada/system/_git/work'), { forge: 'azure', host: 'dev.azure.com' })
  assert.deepEqual(forgeOf('git@ssh.dev.azure.com:v3/ada/system/work'), { forge: 'azure', host: 'ssh.dev.azure.com' })
  assert.deepEqual(forgeOf('https://ada.visualstudio.com/system/_git/work'), { forge: 'azure', host: 'ada.visualstudio.com' })
  assert.deepEqual(forgeOf('https://bitbucket.org/ada/work.git'), { forge: 'git', host: 'bitbucket.org' })
  // A name only holding the name of a forge is no instance of it.
  assert.deepEqual(forgeOf('https://mygithubmirror.example.test/ada/work.git'), { forge: 'git', host: 'mygithubmirror.example.test' })
  for (const remote of ['/srv/git/work.git', 'C:\\repos\\work.git', 'nas:work.git']) assert.deepEqual(forgeOf(remote), { forge: 'git' }, remote)
})

test('a repository is known by the remote its branch tracks, or origin, or its only remote', () => {
  assert.equal(mainRemote(['origin', 'fork'], 'fork'), 'fork')
  assert.equal(mainRemote(['origin', 'fork'], 'gone'), 'origin')
  assert.equal(mainRemote(['fork']), 'fork')
  assert.equal(mainRemote(['fork', 'upstream']), undefined)
  assert.equal(mainRemote([]), undefined)
})

test('the addresses of the remotes, a name with a dot included, and the first of a remote with several', () => {
  const urls = parseRemoteUrls('remote.origin.url git@github.com:ada/work.git\nremote.my.fork.url /srv/git/work.git\nremote.origin.url https://mirror.example.test/work.git\n')
  assert.deepEqual([...urls], [
    ['origin', 'git@github.com:ada/work.git'],
    ['my.fork', '/srv/git/work.git'],
  ])
})
