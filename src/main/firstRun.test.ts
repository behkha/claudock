import test from 'node:test'
import assert from 'node:assert/strict'
import type { ConnectStatus } from '@shared/api/connect'
import { shouldReveal } from './firstRun.ts'

const off: ConnectStatus = { statusLine: 'off', hooks: 'off' }
const base = { revealed: false, connect: off, forced: false, shot: false }

test('shouldReveal shows it once to anyone not connected', () => {
  assert.equal(shouldReveal(base), true)
  assert.equal(shouldReveal({ ...base, revealed: true }), false)
})

test('shouldReveal skips anyone with either part on', () => {
  assert.equal(shouldReveal({ ...base, connect: { statusLine: 'on', hooks: 'off' } }), false)
  assert.equal(shouldReveal({ ...base, connect: { statusLine: 'off', hooks: 'on' } }), false)
})

test('shouldReveal shows it on Windows, where Connect is unsupported', () => {
  assert.equal(shouldReveal({ ...base, connect: { statusLine: 'unsupported', hooks: 'unsupported' } }), true)
})

test('shouldReveal: screenshot mode never shows it on its own; CLAUDOCK_REVEAL always does', () => {
  assert.equal(shouldReveal({ ...base, shot: true }), false)
  assert.equal(shouldReveal({ ...base, forced: true, revealed: true, connect: { statusLine: 'on', hooks: 'on' } }), true)
  assert.equal(shouldReveal({ ...base, forced: true, shot: true }), true)
})
