import test from 'node:test'
import assert from 'node:assert/strict'
import { heatLevels } from '../shared/heat.ts'

test('heatLevels: empty days are 0, busy days split into thirds', () => {
  const level = heatLevels([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.equal(level(0), 0)
  assert.deepEqual([1, 4, 5, 7, 8, 9].map(level), [1, 1, 2, 2, 3, 3])
})

test('heatLevels: no activity at all leaves every day at 0', () => {
  const level = heatLevels([0, 0])
  assert.equal(level(5), 0)
})

test('heatLevels: a single busy day is level 1, as on the share card', () => {
  const level = heatLevels([0, 12])
  assert.equal(level(12), 1)
})
