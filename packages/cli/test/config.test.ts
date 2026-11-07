import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { configPath, initialConfig, parseConfig } from '../src/config.js'

const home = '/home/me'

test('a minimal configuration is a store and one system', () => {
  const config = parseConfig('store: ~/snapshots\nlinux:\n  files: [/etc/wsl.conf]\n', home)
  // An absolute path of the platform, under the current drive on Windows.
  assert.equal(config.store, resolve('/home/me/snapshots'))
  assert.deepEqual(config.linux, { files: ['/etc/wsl.conf'], inventories: [], repos: [] })
  assert.equal(config.windows, undefined)
})

test('a custom inventory is a name and a command', () => {
  const config = parseConfig('store: /s\nlinux:\n  inventories:\n    - apt-manual\n    - name: pip\n      command: pip list\n', home)
  assert.deepEqual(config.linux?.inventories, ['apt-manual', { name: 'pip', command: 'pip list' }])
})

test('a mistake names what is wrong', () => {
  assert.throws(() => parseConfig('linux: {}\n', home), /store is required/)
  assert.throws(() => parseConfig('store: relative\n', home), /not an absolute path/)
  assert.throws(() => parseConfig('store: /s\nlinx: {}\n', home), /unknown key linx/)
  assert.throws(() => parseConfig('store: /s\nlinux:\n  files: [etc/wsl.conf]\n', home), /not an absolute path/)
  assert.throws(() => parseConfig('store: /s\nlinux:\n  inventories: [brew]\n', home), /brew is not one of/)
  assert.throws(() => parseConfig('store: /s\nlinux:\n  inventories: [{name: git-repos, command: ls}]\n', home), /unique file name/)
  assert.throws(() => parseConfig('store: /s\nmachine: ../up\n', home), /machine is a folder name/)
  assert.throws(() => parseConfig('store: /s\nredact: ["("]\n', home), /not a valid regular expression/)
})

test('cleanup lists built-in steps, and custom ones with a name and a command', () => {
  const config = parseConfig('store: /s\ncleanup:\n  - journal\n  - name: jetbrains\n    command: rm -rf ~/.cache/JetBrains\n', home)
  assert.deepEqual(config.cleanup, ['journal', { name: 'jetbrains', command: 'rm -rf ~/.cache/JetBrains' }])
  assert.deepEqual(parseConfig('store: /s\n', home).cleanup, [])
  assert.throws(() => parseConfig('store: /s\ncleanup: [everything]\n', home), /everything is not one of/)
  assert.throws(() => parseConfig('store: /s\ncleanup: [journal, journal]\n', home), /listed twice/)
  assert.throws(() => parseConfig('store: /s\ncleanup: [{name: journal, command: ls}]\n', home), /different from the built-in ones/)
})

test('a Windows file is a drive path or starts with a variable', () => {
  const config = parseConfig("store: /s\nwindows:\n  files: ['%USERPROFILE%\\.wslconfig', 'C:\\tools\\a.json']\n", home)
  assert.deepEqual(config.windows?.files, ['%USERPROFILE%\\.wslconfig', 'C:\\tools\\a.json'])
})

test('the configuration written by init reads back, with a section for each system of the run', () => {
  const wsl = parseConfig(initialConfig('/home/me/snapshots', ['windows', 'linux']), home)
  assert.ok(wsl.linux?.inventories.includes('apt-manual'))
  assert.ok(wsl.windows?.inventories.includes('winget'))
  const linux = parseConfig(initialConfig('/s', ['linux']), home)
  assert.equal(linux.windows, undefined)
  assert.deepEqual(linux.cleanup, [])
  const windows = parseConfig(initialConfig('/s', ['windows']), home)
  assert.equal(windows.linux, undefined)
  assert.ok(windows.windows?.inventories.includes('scheduled-tasks'))
})

test('CHADE_CONFIG moves the configuration file', () => {
  assert.equal(configPath({}, home), join(home, '.chade', 'config.yml'))
  assert.equal(configPath({ CHADE_CONFIG: '/tmp/c.yml' }, home), '/tmp/c.yml')
})
