import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changedConffiles } from '../src/discover.js'
import { normalizeWinget, npmGlobal, scheduledTasks, systemdUnits } from '../src/inventories.js'

test('a winget export loses its date and sorts its packages, so an unchanged system is no change', () => {
  const first = JSON.stringify({ CreationDate: '2026-10-28', Sources: [{ SourceDetails: { Name: 'winget' }, Packages: [{ PackageIdentifier: 'Git.Git' }, { PackageIdentifier: 'A.B' }] }] })
  const second = JSON.stringify({ CreationDate: '2026-10-29', Sources: [{ SourceDetails: { Name: 'winget' }, Packages: [{ PackageIdentifier: 'A.B' }, { PackageIdentifier: 'Git.Git' }] }] })
  assert.equal(normalizeWinget(first), normalizeWinget(second))
  assert.doesNotMatch(normalizeWinget(first), /CreationDate/)
})

test('global npm packages are name@version lines', () => {
  assert.equal(npmGlobal('{"dependencies":{"npm":{"version":"11.1.1"},"corepack":{"version":"0.34.0"}}}'), 'corepack@0.34.0\nnpm@11.1.1')
  assert.equal(npmGlobal('{}'), '')
})

test('only services and timers are kept from systemd', () => {
  const text = 'snap-core22-2955.mount  enabled enabled\nistarci.service  enabled enabled\ndirmngr.socket  enabled enabled\napt-daily.timer  enabled enabled\n'
  assert.equal(systemdUnits(text), 'apt-daily.timer\nistarci.service')
})

test('scheduled tasks keep the names of the tasks Windows does not ship', () => {
  const csv = '"\\Git for Windows Updater","10/28/2026 3:40:15 PM","Ready"\r\n"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready"\r\n"\\Git for Windows Updater","N/A","Ready"\r\n'
  assert.equal(scheduledTasks(csv), '\\Git for Windows Updater')
})

test('dpkg --verify reports a configuration file whose checksum changed', () => {
  const output = '??5?????? c /etc/ssh/sshd_config\n????????? c /etc/sudoers\nmissing     /var/lib/polkit-1/localauthority (Permission denied)\n??5??????   /usr/bin/tool\n'
  assert.deepEqual(changedConffiles(output), ['/etc/ssh/sshd_config'])
})
