import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig } from '../src/config.js'
import type { Run } from '../src/exec.js'
import { repositoryRoots } from '../src/roots.js'
import { detectHost } from '../src/system.js'

// Answers the way a Windows host does: its variables through cmd.exe, and its paths through wslpath.
const fakeRun: Run = async (command, args) => {
  const variables: Record<string, string> = { '%COMPUTERNAME%': 'DESKTOP-TEST', '%USERPROFILE%': 'C:\\Users\\me' }
  if (command === 'cmd.exe' && args[2] === 'echo') return { code: 0, stdout: `${variables[args[3]] ?? args[3]}\r\n`, stderr: '' }
  if (command === 'wslpath') return { code: 0, stdout: `/mnt/c${args[1].slice(2).replaceAll('\\', '/')}\n`, stderr: '' }
  return { code: 1, stdout: '', stderr: `${command} is not expected` }
}

const config = parseConfig(
  ['store: /tmp/store', 'linux:', '  repos: [~/repos, /srv/git]', 'windows:', "  repos: ['%USERPROFILE%\\projects']"].join('\n'),
  '/home/me',
)

test('on WSL, a Linux folder is read by git, and a Windows folder through its mount, by the git of Windows', async () => {
  const host = await detectHost({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu', HOME: '/home/me' }, run: fakeRun })
  const roots = await repositoryRoots(config, host)
  assert.deepEqual(roots, [
    { system: 'windows', folder: '/mnt/c/Users/me/projects', path: 'C:\\Users\\me\\projects', separator: '\\', git: 'git.exe', cwd: host.windows?.cwd() },
    { system: 'wsl-ubuntu', folder: '/home/me/repos', path: '/home/me/repos', separator: '/', git: 'git' },
    { system: 'wsl-ubuntu', folder: '/srv/git', path: '/srv/git', separator: '/', git: 'git' },
  ])
})

test('on Windows, a folder is read as it is, by git, and the Linux section is left out', async () => {
  const host = await detectHost({ platform: 'win32', env: { COMPUTERNAME: 'DESKTOP-TEST', HOME: 'C:\\Users\\me' }, run: fakeRun })
  assert.deepEqual(await repositoryRoots(config, host), [
    { system: 'windows', folder: 'C:\\Users\\me\\projects', path: 'C:\\Users\\me\\projects', separator: '\\', git: 'git', cwd: undefined },
  ])
})

test('on Linux, the Windows section is left out', async () => {
  const host = await detectHost({ platform: 'linux', env: { HOME: '/home/me' }, run: fakeRun })
  // A WSL kernel makes any run a WSL one, whatever the environment says.
  if (host.systems.length > 1) return
  assert.deepEqual(
    (await repositoryRoots(config, host)).map((root) => root.folder),
    ['/home/me/repos', '/srv/git'],
  )
})

test('a Windows variable that is not defined stops the run with its name', async () => {
  const host = await detectHost({ platform: 'win32', env: { COMPUTERNAME: 'DESKTOP-TEST' }, run: fakeRun })
  const broken = parseConfig("store: /tmp/store\nwindows:\n  repos: ['%NOWHERE%\\projects']", '/home/me')
  await assert.rejects(repositoryRoots(broken, host), /%NOWHERE% is not defined/)
})
