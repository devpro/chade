import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layout } from '../src/graph.js'

test('a straight history runs down one lane', () => {
  const rows = layout([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  assert.deepEqual(rows, [
    { column: 0, into: [], out: [0], through: [], moved: [], width: 1 },
    { column: 0, into: [0], out: [0], through: [], moved: [], width: 1 },
    { column: 0, into: [0], out: [], through: [], moved: [], width: 1 },
  ])
})

test('a merge opens a lane for its second parent, which closes where the branch started', () => {
  // m merges f into main: m -> (b, f), f -> a, b -> a.
  const rows = layout([
    { hash: 'm', parents: ['b', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  assert.deepEqual(rows[0], { column: 0, into: [], out: [0, 1], through: [], moved: [], width: 2 })
  // The branch commit sits on the second lane, while the line of main passes on the first.
  assert.deepEqual(rows[1], { column: 1, into: [1], out: [1], through: [0], moved: [], width: 2 })
  // The line of the branch comes over to the first lane, where main goes on straight.
  assert.deepEqual(rows[2], { column: 0, into: [0], out: [0], through: [], moved: [[1, 0]], width: 2 })
  assert.deepEqual(rows[3], { column: 0, into: [0], out: [], through: [], moved: [], width: 1 })
})

test('a branch not merged starts a lane of its own, joined to the commit it left from', () => {
  const rows = layout([
    { hash: 'tip', parents: ['a'] },
    { hash: 'main', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  assert.deepEqual(rows[0], { column: 0, into: [], out: [0], through: [], moved: [], width: 1 })
  assert.deepEqual(rows[1], { column: 1, into: [], out: [0], through: [0], moved: [], width: 2 })
  assert.deepEqual(rows[2], { column: 0, into: [0], out: [], through: [], moved: [], width: 1 })
})

test('a history cut before its end leaves its lines running, and a lane freed is used again', () => {
  const rows = layout([
    { hash: 'x', parents: ['gone'] },
    { hash: 'y', parents: [] },
    { hash: 'z', parents: [] },
  ])
  assert.deepEqual(rows[1], { column: 1, into: [], out: [], through: [0], moved: [], width: 2 })
  assert.deepEqual(rows[2], { column: 1, into: [], out: [], through: [0], moved: [], width: 2 })
})
