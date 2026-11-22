import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseConfig } from '../src/config.js'
import { DAY_MS, runDue, single, type DailyJob } from '../src/daily.js'

const NOW = Date.parse('2026-11-22T12:00:00Z')

function job(name: string, last: string | undefined, runs: string[], fails = false): DailyJob {
  return {
    name,
    last: async () => last,
    run: async () => {
      runs.push(name)
      if (fails) throw new Error('docker is not running')
    },
  }
}

test('a job runs when it never ran or its last run is a day old, and not before', async () => {
  const runs: string[] = []
  const lines: string[] = []
  const ran = await runDue(
    [job('scan', undefined, runs), job('report', new Date(NOW - DAY_MS).toISOString(), runs), job('fresh', new Date(NOW - DAY_MS + 60_000).toISOString(), runs)],
    (line) => lines.push(line),
    NOW,
  )
  assert.deepEqual(ran, ['scan', 'report'])
  assert.deepEqual(runs, ['scan', 'report'])
  assert.deepEqual(lines, ['daily scan: starting', 'daily scan: done', 'daily report: starting', 'daily report: done'])
})

test('a job that fails is said in the log, and the next ones still run', async () => {
  const runs: string[] = []
  const lines: string[] = []
  const ran = await runDue([job('scan', undefined, runs, true), job('report', undefined, runs)], (line) => lines.push(line), NOW)
  assert.deepEqual(ran, ['report'])
  assert.ok(lines.includes('daily scan: failed, docker is not running'))
})

test('a call while the work runs gets that run, and the next call runs again', async () => {
  let count = 0
  let finish: () => void = () => undefined
  const once = single(
    () =>
      new Promise<number>((resolve) => {
        count++
        finish = () => resolve(count)
      }),
  )
  const first = once()
  const second = once()
  finish()
  assert.deepEqual(await Promise.all([first, second]), [1, 1])
  const third = once()
  finish()
  assert.equal(await third, 2)
})

test('the daily runs are on unless the configuration says daily: false', () => {
  assert.equal(parseConfig('store: /s\n', '/h').daily, undefined)
  assert.equal(parseConfig('store: /s\ndaily: false\n', '/h').daily, false)
  assert.throws(() => parseConfig('store: /s\ndaily: weekly\n', '/h'), /daily is true or false/)
})
