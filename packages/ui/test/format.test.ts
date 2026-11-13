import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Repository } from '@chade/daemon'
import { ago, bytes, changes, checkOf, duration, matches, needsAttention, summary, sync, tone } from '../src/format.js'

const clean: Repository = {
  system: 'linux',
  name: 'chade',
  path: '/home/me/repos/chade',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  changed: 0,
  untracked: 0,
  conflicts: 0,
}

test('a date reads as the time since', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  assert.equal(ago('2026-11-10T11:59:30Z', now), 'just now')
  assert.equal(ago('2026-11-10T11:59:00Z', now), '1 minute ago')
  assert.equal(ago('2026-11-10T09:00:00Z', now), '3 hours ago')
  assert.equal(ago('2026-11-01T12:00:00Z', now), '9 days ago')
  assert.equal(ago('2026-07-10T12:00:00Z', now), '4 months ago')
  assert.equal(ago('2023-11-10T12:00:00Z', now), '3 years ago')
  assert.equal(ago('not a date', now), '')
})

const texts = (badges: { text: string }[]): string[] => badges.map((badge) => badge.text)

test('a branch is in sync, ahead, behind, without upstream, or with an upstream that is gone', () => {
  assert.deepEqual(sync(clean), [{ text: 'in sync', tone: 'quiet', title: 'Same commit as origin/main, as of the last fetch' }])
  assert.deepEqual(texts(sync({ ...clean, ahead: 2, behind: 1 })), ['↑ 2', '↓ 1'])
  assert.deepEqual(texts(sync({ ...clean, upstream: undefined, ahead: undefined, behind: undefined })), ['no upstream'])
  assert.deepEqual(texts(sync({ ...clean, ahead: undefined, behind: undefined })), ['upstream gone'])
  assert.deepEqual(sync({ ...clean, branch: undefined }), [])
})

test('a working tree is clean, or lists what it holds, conflicts first', () => {
  assert.deepEqual(texts(changes(clean)), ['clean'])
  assert.deepEqual(texts(changes({ ...clean, changed: 3, untracked: 1, conflicts: 2 })), ['2 in conflict', '3 changed', '1 untracked'])
})

test('a repository needs attention when it has something to commit, push, pull or fix', () => {
  assert.equal(needsAttention(clean), false)
  assert.equal(needsAttention({ ...clean, untracked: 1 }), true)
  assert.equal(needsAttention({ ...clean, behind: 1 }), true)
  assert.equal(needsAttention({ ...clean, upstream: undefined }), true)
  assert.equal(needsAttention({ ...clean, error: 'not a git repository' }), true)
  // The most pressing one marks the row.
  assert.equal(tone(clean), 'quiet')
  assert.equal(tone({ ...clean, ahead: 1 }), 'info')
  assert.equal(tone({ ...clean, ahead: 1, changed: 1 }), 'warn')
  assert.equal(tone({ ...clean, ahead: 1, changed: 1, conflicts: 1 }), 'bad')
  // A detached HEAD has no upstream to be late on.
  assert.equal(needsAttention({ ...clean, branch: undefined, upstream: undefined }), false)
})

test('a filter matches every word, in the name, the path or the branch', () => {
  assert.equal(matches(clean, ''), true)
  assert.equal(matches(clean, 'CHADE main'), true)
  assert.equal(matches(clean, 'chade feature'), false)
})

test('the summary counts what there is to do', () => {
  assert.equal(summary([clean]), '1 repository')
  assert.equal(
    summary([clean, { ...clean, changed: 1, ahead: 1 }, { ...clean, behind: 2 }, { ...clean, upstream: undefined }, { ...clean, error: 'broken' }]),
    '5 repositories, 1 with changes, 1 ahead, 1 behind, 1 without upstream, 1 unreadable',
  )
})

test('a size reads in the unit that keeps it short, in powers of 1000', () => {
  assert.equal(bytes(0), '0 B')
  assert.equal(bytes(999), '999 B')
  assert.equal(bytes(1000), '1.0 kB')
  assert.equal(bytes(352523911168), '352.5 GB')
  assert.equal(bytes(2.5e15), '2500.0 TB')
})

test('a duration reads in seconds, then minutes, then hours', () => {
  assert.equal(duration(4_600), '5 s')
  assert.equal(duration(112_000), '1 min 52 s')
  assert.equal(duration(120_000), '2 min')
  assert.equal(duration(3_900_000), '1 h 5 min')
})

test('a check of IstarCI reads as a mark and a sentence', () => {
  assert.deepEqual(checkOf({ status: 'success', durationMs: 112_000, url: '' }), { mark: '✓', tone: 'good', text: 'Passed on IstarCI in 1 min 52 s' })
  assert.equal(checkOf({ status: 'failure', durationMs: 5_000, url: '' }).text, 'Failed on IstarCI after 5 s')
  assert.equal(checkOf({ status: 'running', url: '' }).tone, 'info')
  assert.equal(checkOf({ status: 'not-run', reason: 'A newer commit replaced it in the queue', url: '' }).text, 'Not run by IstarCI: A newer commit replaced it in the queue')
})
