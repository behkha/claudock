import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LimitsState } from '@shared/api/limits'
import type { AlertPrefs } from '@shared/api/sessions'
import { DEFAULT_WINDOWS, WINDOW_RETIRE_MS, limitRows, limitShown, limitsLine, liveFrom, quotaHit, rememberWindows, windowInfo, windowsToDraw } from '../shared/limits.ts'
import { stepScript } from './connect/limitScript.ts'
import { normalizeAlertPrefs } from './connect/sessionModel.ts'
import { glance } from './menubar/glance.ts'
import { LimitAlertRule } from './menubar/limitAlert.ts'

const NOW = 1_800_000_000_000
const H = 3_600_000
const S = NOW / 1000

/** The status line JSON Claude Code 2.1.318 sent on 10 Nov 2026, captured as is (session id and paths replaced). */
const REAL = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'connect/fixtures/statusline-2.1.318.json'), 'utf8')) as {
  version: string
  rate_limits: Record<string, { used_percentage: number; resets_at: number }>
}

test('quotaHit: a refused request names its window and reset time; anything else is no hit', () => {
  assert.deepEqual(quotaHit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: S + 3600 }, NOW), { window: 'five_hour', hit: { at: NOW, resetsAt: NOW + H } })
  assert.equal(quotaHit({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: S + 3600 }, NOW)?.window, 'seven_day')
  assert.equal(quotaHit({ status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: S + 3600 }, NOW)?.window, 'seven_day_opus', 'a model-specific weekly limit is its own window')
  assert.equal(quotaHit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: S + 3600 }, NOW), null)
  assert.equal(quotaHit({ status: 'rejected', rateLimitType: 'five_hour' }, NOW), null)
  assert.equal(quotaHit({ status: 'rejected', rateLimitType: 7, resetsAt: S + 3600 }, NOW), null)
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

/* ------------------------------------------------------------------ any window, named by Claude Code */

test('windowInfo: a key is read, not looked up', () => {
  assert.deepEqual(windowInfo('five_hour'), { name: '5-hour', spanMs: 5 * H, tokenSpan: 'last 5 hours' })
  assert.deepEqual(windowInfo('seven_day'), { name: 'Weekly', spanMs: 168 * H, tokenSpan: 'last 7 days' })
  assert.deepEqual(windowInfo('seven_day_opus'), { name: 'Weekly Opus', spanMs: 168 * H, tokenSpan: null }, 'one model: all tokens would not be its share')
  assert.deepEqual(windowInfo('spend_limit'), { name: 'Spend', spanMs: null, tokenSpan: null })
  assert.equal(windowInfo('nine_hour').name, '9-hour')
  assert.equal(windowInfo('one_day').name, 'Daily')
  assert.equal(windowInfo('monthly_tokens').name, 'Monthly Tokens')
  assert.equal(windowInfo('x').name, 'X')
})

/** Play Claude Code: run the step's script with `input` on stdin; returns what it saved and what it printed. */
function runStep(input: unknown): { saved: unknown; printed: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claudock limits' "))
  try {
    fs.writeFileSync(path.join(dir, 'statusline.sh'), stepScript(null, dir), { mode: 0o755 })
    const r = spawnSync('sh', [path.join(dir, 'statusline.sh')], { input: JSON.stringify(input), encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    const file = path.join(dir, 'limits.json')
    return { saved: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null, printed: r.stdout.trim() }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const stateFor = (live: LimitsState['live'], seen: Record<string, number> | null = null): LimitsState => {
  const windows = windowsToDraw(rememberWindows(seen, live), {})
  return { step: 'on', live, hits: {}, windows, tokens: { today: { tokens: 0, sessions: 0 }, windows: Object.fromEntries(windows.filter((k) => windowInfo(k).tokenSpan).map((k) => [k, { tokens: 1200, sessions: 1 }])) } }
}

test('the real 2.1.318 payload: the step saves it and every surface draws its two windows', { skip: process.platform === 'win32' }, () => {
  assert.deepEqual(Object.keys(REAL.rate_limits), ['five_hour', 'seven_day'])
  const { saved, printed } = runStep(REAL)
  assert.equal(printed, '5h 2% · week 43%')
  const live = liveFrom(saved)
  assert.ok(live)
  assert.deepEqual(live.windows, { five_hour: { usedPercentage: 2, resetsAt: 1794359400_000 }, seven_day: { usedPercentage: 43, resetsAt: 1794571200_000 } })
  const at = 1794343874_000
  const l = stateFor({ ...live, at })
  assert.deepEqual(limitRows(l, at).map((r) => [r.name, r.shown.kind === 'percent' && r.shown.view.percent]), [['5-hour', 2], ['Weekly', 43]])
  assert.equal(glance(l, undefined, at).title, '43%')
  assert.equal(limitsLine(l, at, true), '5-hour 2% · Weekly 43%')
})

test('a window that does not exist today is saved, named, drawn and alerted on with no code for it', { skip: process.platform === 'win32' }, () => {
  // tomorrow's Claude Code: no five_hour, a nine_hour window instead, a per-model weekly one and a gateway spend limit
  const rate_limits = {
    seven_day_fable: { used_percentage: 12.4, resets_at: S + 90 * 3600 },
    nine_hour: { used_percentage: 85, resets_at: S + 2 * 3600 },
    seven_day: REAL.rate_limits.seven_day && { used_percentage: 43, resets_at: S + 60 * 3600 },
    spend_limit: { used_percentage: 63, resets_at: S + 400 * 3600, used_usd: 314.12, limit_usd: 500, period: 'monthly' }
  }
  const { saved, printed } = runStep({ ...REAL, rate_limits })
  assert.equal(printed, 'week fable 12% · 9h 85% · week 43% · spend 63%')
  const live = { ...liveFrom(saved)!, at: NOW }
  const l = stateFor(live)
  assert.deepEqual(l.windows, ['nine_hour', 'seven_day', 'seven_day_fable', 'spend_limit'], 'shortest first; five_hour was never sent, so it is not drawn')
  assert.deepEqual(
    limitRows(l, NOW).map((r) => `${r.name} ${r.shown.kind === 'percent' ? r.shown.view.percent : r.shown.kind}`),
    ['9-hour 85', 'Weekly 43', 'Weekly Fable 12', 'Spend 63']
  )
  assert.equal(glance(l, undefined, NOW).title, '85%')
  assert.equal(glance(l, undefined, NOW).tooltip, '9-hour 85% · Weekly 43% · Weekly Fable 12% · Spend 63%')
  // the alert rule: first reading is the starting point, the next one crosses 80%
  const prefs: AlertPrefs = { ...normalizeAlertPrefs(undefined), limitPercent: 80, limitReset: true }
  const rule = new LimitAlertRule()
  const at = (pct: number): LimitsState['live'] => ({ at: NOW, windows: { ...live.windows, nine_hour: { ...live.windows.nine_hour, usedPercentage: pct } } })
  assert.deepEqual(rule.update(at(40), prefs, NOW), [])
  assert.deepEqual(rule.update(at(100), prefs, NOW + 60_000).map((a) => a.title), ['9-hour limit at 100%'])
  assert.deepEqual(rule.update(null, prefs, NOW + 3 * H).map((a) => a.title), ['Your 9-hour limit has reset'])
  // tokens stand in only for a window whose key gives its length and nothing else
  const idle = { ...l, live: null }
  assert.deepEqual(limitRows(idle, NOW).map((r) => [r.name, r.tokenSpan, r.tokens]), [['9-hour', 'last 9 hours', 1200], ['Weekly', 'last 7 days', 1200]])
  // a refused request in a window never seen before draws it too
  const hit = quotaHit({ status: 'rejected', rateLimitType: 'three_day_haiku', resetsAt: S + 3600 }, NOW)!
  const reached = limitRows({ ...idle, hits: { [hit.window]: hit.hit }, windows: windowsToDraw(null, { [hit.window]: hit.hit }) }, NOW)
  assert.deepEqual(reached.find((r) => r.key === 'three_day_haiku')?.shown, { kind: 'reached', resetsAt: NOW + H })
  assert.equal(reached.find((r) => r.key === 'three_day_haiku')?.name, '3-day Haiku')
})

test('older Claude Code and no status line at all: five_hour and seven_day', () => {
  // 2.1.80, the first version with rate_limits, sent exactly these two
  const old = liveFrom({ v: 1, at: S, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: S + 3600 }, seven_day: { used_percentage: 41.2, resets_at: S + 86400 } } })
  assert.deepEqual(limitRows(stateFor(old), NOW).map((r) => r.name), ['5-hour', 'Weekly'])
  // nothing sent yet (the step is off, or only desktop-app sessions ran): the windows the docs name, as tokens
  assert.deepEqual(windowsToDraw(null, {}), [...DEFAULT_WINDOWS])
  assert.deepEqual(limitRows(null, NOW).map((r) => [r.name, r.shown.kind, r.tokens]), [['5-hour', 'tokens', null], ['Weekly', 'tokens', null]])
  assert.equal(liveFrom({ v: 1, at: S, rate_limits: {} }), null)
  assert.equal(liveFrom({ v: 1, at: S, rate_limits: { five_hour: { used_percentage: 'x', resets_at: S } } }), null)
})

test('rememberWindows: a window that reset stays; one Claude Code stopped sending goes after two weeks of readings without it', () => {
  const w = { usedPercentage: 10, resetsAt: NOW + H }
  const first = rememberWindows(null, { at: NOW, windows: { five_hour: w, seven_day: w } })
  assert.deepEqual(first, { five_hour: NOW, seven_day: NOW })
  // the 5-hour window reset and Claude Code left it out of the next reading
  const next = rememberWindows(first, { at: NOW + 6 * H, windows: { seven_day: w } })
  assert.deepEqual(windowsToDraw(next, {}), ['five_hour', 'seven_day'])
  // no readings at all (away for a month) forgets nothing
  assert.deepEqual(rememberWindows(next, null), next)
  // still left out after two weeks of readings: gone
  const later = rememberWindows(next, { at: NOW + WINDOW_RETIRE_MS + H, windows: { seven_day: w } })
  assert.deepEqual(windowsToDraw(later, {}), ['seven_day'])
})
