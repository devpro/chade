import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { activityFile, logged, readActivity, seconds } from '../src/activity.js'

test('a job writes its steps to the log in order, and to the terminal when there is one', async () => {
  const file = activityFile(join(await mkdtemp(join(tmpdir(), 'chade-activity-')), 'sub', 'config.yml'))
  assert.deepEqual(await readActivity(file), [])
  const printed: string[] = []
  const result = await logged(
    file,
    'scan',
    async (progress) => {
      progress('image 1 of 2')
      progress('two\nlines')
      return 42
    },
    (line) => printed.push(line),
  )
  assert.equal(result, 42)
  assert.deepEqual(printed.slice(0, 2), ['started', 'image 1 of 2'])
  await assert.rejects(logged(file, 'report', async () => Promise.reject(new Error('no disk'))), /no disk/)
  const lines = await readActivity(file)
  assert.deepEqual(lines.map((line) => line.job), ['scan', 'scan', 'scan', 'scan', 'report', 'report'])
  assert.equal(lines[2].text, 'two lines')
  assert.match(lines[3].text, /^done in/)
  assert.match(lines[5].text, /^failed after .*: no disk$/)
})

test('the log keeps its last lines only', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'chade-activity-')), 'activity.log')
  await writeFile(file, `2026-11-24T00:00:00.000Z scan ${'x'.repeat(400)}\n`.repeat(4000))
  await logged(file, 'scan', async () => undefined)
  assert.equal((await readFile(file, 'utf8')).trimEnd().split('\n').length, 2002)
  assert.deepEqual([seconds(0, 12_000), seconds(0, 195_000)], ['12 s', '3 min 15 s'])
})
