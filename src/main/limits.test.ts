import test from 'node:test'
import assert from 'node:assert/strict'
import { limitShown, quotaHit } from '../shared/limits.ts'

const NOW = 1_800_000_000_000
const H = 3_600_000
const S = NOW / 1000

test('quotaHit: a refused request names its window and reset time; anything else is no hit', () => {
  assert.deepEqual(quotaHit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: S + 3600 }, NOW), { window: 'fiveHour', hit: { at: NOW, resetsAt: NOW + H } })
  assert.equal(quotaHit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: S + 3600 }, NOW)?.window, 'sevenDay')
  assert.equal(quotaHit({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: S + 3600 }, NOW), null, 'a model-specific weekly limit is not the weekly limit')
  assert.equal(quotaHit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: S + 3600 }, NOW), null)
  assert.equal(quotaHit({ status: 'rejected', rateLimitType: 'five_hour' }, NOW), null)
  assert.equal(quotaHit(null, NOW), null)
  assert.equal(quotaHit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: S + 3600 }, NaN), null)
})

test('limitShown: tokens without a percentage, the percentage while its window lasts, then tokens again', () => {
  const w = { usedPercentage: 42.4, resetsAt: NOW + H }
  assert.deepEqual(limitShown(null, undefined, null, NOW), { kind: 'tokens' })
  const p = limitShown(w, NOW - 60_000, null, NOW)
  assert.equal(p.kind === 'percent' && p.view.percent, 42)
  assert.deepEqual(limitShown({ ...w, resetsAt: NOW - 1 }, NOW - H, null, NOW), { kind: 'tokens' }, 'a reading from a window that has reset')
})

test('limitShown: a reached limit shows until it resets, unless a newer percentage came after it', () => {
  const hit = { at: NOW - 10 * 60_000, resetsAt: NOW + H }
  assert.deepEqual(limitShown(null, undefined, hit, NOW), { kind: 'reached', resetsAt: NOW + H })
  assert.deepEqual(limitShown({ usedPercentage: 90, resetsAt: NOW + H }, NOW - H, hit, NOW), { kind: 'reached', resetsAt: NOW + H }, 'the hit is newer')
  assert.equal(limitShown({ usedPercentage: 3, resetsAt: NOW + 5 * H }, NOW - 60_000, hit, NOW).kind, 'percent', 'a newer reading from a new window')
  assert.deepEqual(limitShown(null, undefined, { ...hit, resetsAt: NOW - 1 }, NOW), { kind: 'tokens' }, 'reset since')
})
