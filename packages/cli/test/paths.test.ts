import assert from 'node:assert/strict'
import { test } from 'node:test'
import { expandHome, isSegment, linuxStorePath, windowsStorePath } from '../src/paths.js'

test('a Linux file keeps its absolute path under the system folder', () => {
  assert.equal(linuxStorePath('/etc/wsl.conf', '/home/me'), 'etc/wsl.conf')
  assert.equal(linuxStorePath('~/.istarci/config.yml', '/home/me'), 'home/me/.istarci/config.yml')
  assert.equal(linuxStorePath('/etc/../etc/hosts', '/home/me'), 'etc/hosts')
})

test('a relative Linux path is refused', () => {
  assert.throws(() => linuxStorePath('etc/wsl.conf', '/home/me'), /not an absolute path/)
})

test('a Windows file keeps its drive and path, with forward slashes', () => {
  assert.equal(windowsStorePath('C:\\Users\\me\\.wslconfig'), 'C/Users/me/.wslconfig')
  assert.equal(windowsStorePath('d:\\tools\\settings.json'), 'D/tools/settings.json')
})

test('a Windows path without a drive, or climbing above it, is refused', () => {
  assert.throws(() => windowsStorePath('\\\\server\\share\\file'), /drive letter/)
  assert.throws(() => windowsStorePath('C:\\..\\..\\etc'), /climbs above/)
})

test('the home folder expands only as a leading tilde', () => {
  assert.equal(expandHome('~', '/home/me'), '/home/me')
  assert.equal(expandHome('/srv/~/x', '/home/me'), '/srv/~/x')
})

test('a store folder name never climbs out of the store', () => {
  assert.ok(isSegment('DESKTOP-9AMBHO5'))
  assert.ok(!isSegment('..'))
  assert.ok(!isSegment('a/b'))
})
