import test from 'node:test'
import assert from 'node:assert/strict'
import type { LimitsState, LiveLimits } from '@shared/api/limits'
import type { AlertPrefs, LiveSession, SessionsState } from '@shared/api/sessions'
import { normalizeAlertPrefs } from '../connect/sessionModel.ts'
import { glance } from './glance.ts'
import { ContextAlertRule, runningFor } from './contextAlert.ts'
import { LimitAlertRule } from './limitAlert.ts'
import { autostartEntry, execArg, inNpxCache, launchAgent, unstablePath } from './loginFiles.ts'

const NOW = 1_800_000_000_000
const H = 3_600_000
const none = { tokens: 0, sessions: 0 }
const tokens = { today: none, windows: { five_hour: none, seven_day: none } }
const hits = {}
const windows = ['five_hour', 'seven_day']
/** `rate_limits` as Claude Code sends it: only the windows it has. */
const sent = (w: Record<string, { usedPercentage: number; resetsAt: number } | null>): LiveLimits['windows'] =>
  Object.fromEntries(Object.entries(w).filter((e): e is [string, { usedPercentage: number; resetsAt: number }] => e[1] !== null))

const limits = (five: number | null, week: number | null, step: LimitsState['step'] = 'on', resetsIn = H): LimitsState => ({
  step,
  tokens,
  hits,
  windows,
  live: {
    at: NOW,
    windows: sent({
      five_hour: five === null ? null : { usedPercentage: five, resetsAt: NOW + resetsIn },
      seven_day: week === null ? null : { usedPercentage: week, resetsAt: NOW + 50 * H }
    })
  }
})

const session = (name: string, status: LiveSession['status']): LiveSession => ({
  id: name,
  status,
  since: NOW - 60_000,
  cwd: `/work/${name}`,
  name,
  title: null,
  activity: null,
  kind: status === 'waiting' ? 'permission' : null,
  tool: status === 'waiting' ? 'Bash' : null,
  message: null,
  context: null,
  started: null
})
const sessions = (...list: LiveSession[]): SessionsState => ({ hooks: 'on', sessions: list, waiting: list.filter((s) => s.status === 'waiting').length })

/* ------------------------------------------------------------------ glance */

test('glance: the higher limit is the number; hover text names both', () => {
  const g = glance(limits(12, 94), undefined, NOW)
  assert.equal(g.title, '94%')
  assert.equal(g.tooltip, '5-hour 12% · Weekly 94%')
  assert.equal(g.icon, 'plain')
  assert.equal(glance(limits(42.4, null), undefined, NOW).title, '42%')
})

test('glance: no number while the step is off, before Claude Code reports, or once a window has reset', () => {
  assert.equal(glance(limits(42, 61, 'off'), undefined, NOW).title, '')
  assert.equal(glance({ step: 'on', live: null, tokens, hits, windows }, undefined, NOW).title, '')
  assert.equal(glance(undefined, undefined, NOW).title, '')
  // the 5-hour window reset ten minutes ago: only the weekly reading is still true
  const g = glance(limits(99, 30, 'on', -10 * 60_000), undefined, NOW)
  assert.equal(g.title, '30%')
  assert.equal(g.tooltip, 'Weekly 30%')
  assert.equal(glance(limits(42, 61, 'unsupported'), undefined, NOW).tooltip, 'Claudock')
})

test('glance: the dot only while a session waits; hover text says who', () => {
  assert.equal(glance(undefined, sessions(session('app', 'working'), session('notes', 'done')), NOW).icon, 'plain')
  const one = glance(limits(42, 61), sessions(session('api-server', 'waiting'), session('app', 'working')), NOW)
  assert.equal(one.icon, 'waiting')
  assert.equal(one.tooltip, 'api-server is waiting for you\n5-hour 42% · Weekly 61%')
  const two = glance(undefined, sessions(session('a', 'waiting'), session('b', 'waiting')), NOW)
  assert.equal(two.tooltip, '2 sessions are waiting for you')
  // hooks removed: whatever the list says, nothing waits
  assert.equal(glance(undefined, { ...sessions(session('a', 'waiting')), hooks: 'off' }, NOW).icon, 'plain')
})

/* ------------------------------------------------------------------ limit alerts */

const prefs = (over: Partial<AlertPrefs> = {}): AlertPrefs => ({ ...normalizeAlertPrefs(undefined), limitPercent: 80, ...over })
const reading = (five: number | null, week: number | null = null, fiveResets = NOW + 2 * H): LiveLimits => ({
  at: NOW,
  windows: sent({
    five_hour: five === null ? null : { usedPercentage: five, resetsAt: fiveResets },
    seven_day: week === null ? null : { usedPercentage: week, resetsAt: NOW + 90 * H }
  })
})
const titles = (a: { title: string }[]): string[] => a.map((x) => x.title)

test('limit alert: once when a window crosses the line, never again in that window', () => {
  const r = new LimitAlertRule()
  assert.deepEqual(r.update(reading(40), prefs(), NOW), [])
  assert.deepEqual(titles(r.update(reading(85), prefs(), NOW)), ['5-hour limit at 85%'])
  assert.deepEqual(r.update(reading(90), prefs(), NOW), [])
  // a dip and a second crossing in the same window stay quiet
  assert.deepEqual(r.update(reading(70), prefs(), NOW), [])
  assert.deepEqual(r.update(reading(82), prefs(), NOW), [])
  // the weekly window first read at 81% starts there
  assert.deepEqual(titles(r.update(reading(82, 81), prefs(), NOW)), [])
  assert.deepEqual(titles(r.update(reading(82, 79), prefs(), NOW)), [])
})

test('limit alert: the weekly window crosses on its own; the body says when it resets', () => {
  const r = new LimitAlertRule()
  r.update(reading(10, 70), prefs(), NOW)
  const a = r.update(reading(10, 80), prefs(), NOW)
  assert.deepEqual(titles(a), ['Weekly limit at 80%'])
  assert.match(a[0].body, /^Resets /)
})

test('limit alert: a window already over the line at launch is the starting point; a new window starts from 0', () => {
  const r = new LimitAlertRule()
  assert.deepEqual(r.update(reading(90), prefs(), NOW), [])
  assert.deepEqual(r.update(reading(95), prefs(), NOW), [])
  // the next 5-hour window, first read already over the line while Claudock runs: that is a crossing
  assert.deepEqual(titles(r.update(reading(85, null, NOW + 7 * H), prefs(), NOW + 3 * H)), ['5-hour limit at 85%'])
})

test('limit alert: off, paused, and a reading of a window that has already reset raise nothing', () => {
  const off = new LimitAlertRule()
  off.update(reading(40), prefs({ limitPercent: null }), NOW)
  assert.deepEqual(off.update(reading(90), prefs({ limitPercent: null }), NOW), [])

  const paused = new LimitAlertRule()
  paused.update(reading(40), prefs({ pausedUntil: NOW + H }), NOW)
  assert.deepEqual(paused.update(reading(90), prefs({ pausedUntil: NOW + H }), NOW), [])
  // what was skipped while paused stays skipped
  assert.deepEqual(paused.update(reading(91), prefs(), NOW + 2 * H - 1), [])

  const late = new LimitAlertRule()
  late.update(reading(40, null, NOW + 60_000), prefs(), NOW)
  assert.deepEqual(late.update(reading(90, null, NOW + 60_000), prefs(), NOW + 120_000), [])
})

test('limit alert: reset alerts once, only after 100% in that window, and only when turned on', () => {
  const r = new LimitAlertRule()
  const on = prefs({ limitPercent: null, limitReset: true })
  r.update(reading(60), on, NOW)
  assert.deepEqual(r.update(reading(100), on, NOW), [])
  assert.deepEqual(r.update(reading(100), on, NOW + 2 * H - 1), [])
  assert.deepEqual(titles(r.update(reading(100), on, NOW + 2 * H)), ['Your 5-hour limit has reset'])
  assert.deepEqual(r.update(reading(100), on, NOW + 3 * H), [])

  const never = new LimitAlertRule()
  never.update(reading(99), on, NOW)
  assert.deepEqual(never.update(reading(99), on, NOW + 3 * H), [])

  const offRule = new LimitAlertRule()
  offRule.update(reading(100), prefs({ limitReset: false }), NOW)
  assert.deepEqual(offRule.update(reading(100), prefs({ limitReset: false }), NOW + 3 * H), [])
})

test('limit alert: a reset is still said when the next window\'s first reading comes before the tick', () => {
  const r = new LimitAlertRule()
  const on = prefs({ limitPercent: null, limitReset: true })
  r.update(reading(60), on, NOW)
  r.update(reading(100), on, NOW)
  assert.deepEqual(titles(r.update(reading(3, null, NOW + 7 * H), on, NOW + 2 * H + 30_000)), ['Your 5-hour limit has reset'])
  assert.deepEqual(r.update(reading(4, null, NOW + 7 * H), on, NOW + 2 * H + 90_000), [])
})

test('limit alert: readings a minute or two apart in their reset time are the same window', () => {
  const r = new LimitAlertRule()
  r.update(reading(85, null, NOW + 2 * H), prefs(), NOW)
  assert.deepEqual(r.update(reading(86, null, NOW + 2 * H + 90_000), prefs(), NOW), [])
})

/* ------------------------------------------------------------------ context alert */

const K = 1000
const lined = (over: Partial<AlertPrefs> = {}): AlertPrefs => ({ ...normalizeAlertPrefs(undefined), contextLine: 500 * K, ...over })
/** A running session carrying `context` tokens, begun 78 minutes ago. */
const sized = (name: string, context: number | null, over: Partial<LiveSession> = {}): LiveSession => ({ ...session(name, 'working'), context, started: NOW - 78 * 60_000, ...over })

test('context alert: the first reading is the starting point, then one alert when a session reaches the line', () => {
  const r = new ContextAlertRule()
  // already over the line when Claudock starts: no alert, now or as it grows
  assert.deepEqual(r.update([sized('big', 726 * K), sized('web', 450 * K, { title: 'Migrate settings form' })], lined(), NOW), [])
  assert.deepEqual(r.update([sized('big', 730 * K), sized('web', 480 * K, { title: 'Migrate settings form' })], lined(), NOW), [])
  const a = r.update([sized('big', 731 * K), sized('web', 507 * K, { title: 'Migrate settings form' })], lined(), NOW)
  assert.deepEqual(a, [{ title: 'Migrate settings form is at 500k context', body: 'web · 1 h 18 min in', id: 'web' }])
  assert.deepEqual(r.update([sized('big', 731 * K), sized('web', 520 * K)], lined(), NOW), [])
  // a session with no name of its own is called by its folder; exactly at the line counts
  const b = new ContextAlertRule()
  b.update([sized('docs', 499_999)], lined(), NOW)
  assert.deepEqual(titles(b.update([sized('docs', 500 * K)], lined(), NOW)), ['docs is at 500k context'])
})

test('context alert: ready again only after the session falls below half the line', () => {
  const r = new ContextAlertRule()
  r.update([sized('web', 400 * K)], lined(), NOW)
  assert.equal(r.update([sized('web', 510 * K)], lined(), NOW).length, 1)
  // a dip that stays above half, then over again: quiet
  assert.deepEqual(r.update([sized('web', 300 * K)], lined(), NOW), [])
  assert.deepEqual(r.update([sized('web', 505 * K)], lined(), NOW), [])
  // compacted to 96k (under 250k), and it grows past the line again
  assert.deepEqual(r.update([sized('web', 96 * K)], lined(), NOW), [])
  assert.equal(r.update([sized('web', 501 * K)], lined(), NOW).length, 1)
  // a session over the line at the start is ready after falling below half too
  const big = new ContextAlertRule()
  big.update([sized('big', 726 * K)], lined(), NOW)
  big.update([sized('big', 480 * K)], lined(), NOW)
  assert.deepEqual(big.update([sized('big', 510 * K)], lined(), NOW), [])
  big.update([sized('big', 96 * K)], lined(), NOW)
  assert.equal(big.update([sized('big', 510 * K)], lined(), NOW).length, 1)
})

test('context alert: off and paused raise nothing; what was skipped stays skipped', () => {
  const off = new ContextAlertRule()
  off.update([sized('web', 400 * K)], lined({ contextLine: null }), NOW)
  assert.deepEqual(off.update([sized('web', 900 * K)], lined({ contextLine: null }), NOW), [])
  // the line is picked while the session is already over it: that is where it starts
  assert.deepEqual(off.update([sized('web', 905 * K)], lined(), NOW), [])

  const paused = new ContextAlertRule()
  paused.update([sized('web', 400 * K)], lined({ pausedUntil: NOW + H }), NOW)
  assert.deepEqual(paused.update([sized('web', 510 * K)], lined({ pausedUntil: NOW + H }), NOW), [])
  assert.deepEqual(paused.update([sized('web', 520 * K)], lined(), NOW + 2 * H), [])
})

test('context alert: a session that is gone is forgotten, and one with no reply yet starts at its first reading', () => {
  const r = new ContextAlertRule()
  r.update([sized('web', 400 * K)], lined(), NOW)
  r.update([], lined(), NOW)
  // the same id again (a session resumed later): its first reading is a starting point, not a crossing
  assert.deepEqual(r.update([sized('web', 510 * K)], lined(), NOW), [])
  const fresh = new ContextAlertRule()
  fresh.update([sized('new', null)], lined(), NOW)
  assert.deepEqual(fresh.update([sized('new', 600 * K)], lined(), NOW), [])
})

test('context alert: with several profiles the body leads with the profile', () => {
  const r = new ContextAlertRule()
  r.update([sized('web', 400 * K, { profile: 'Work' }), sized('api', 100 * K, { profile: 'Default' })], lined(), NOW)
  const a = r.update([sized('web', 507 * K, { profile: 'Work' }), sized('api', 100 * K, { profile: 'Default' })], lined(), NOW)
  assert.deepEqual(a, [{ title: 'web is at 500k context', body: 'Work · web · 1 h 18 min in', id: 'web' }])
})

test('context alert: how long a session has run', () => {
  assert.equal(runningFor(NOW - 3 * 60_000, NOW), '3 min in')
  assert.equal(runningFor(NOW - 2 * H, NOW), '2 h in')
  assert.equal(runningFor(NOW - 27 * H, NOW), '1 d 3 h in')
  assert.equal(runningFor(NOW - 30_000, NOW), '')
  assert.equal(runningFor(null, NOW), '')
})

/* ------------------------------------------------------------------ open at login */

test('login files: the LaunchAgent runs the command once at login, with its arguments and folder escaped', () => {
  const text = launchAgent(['/Users/a b/Library/Application Support/Claudock/Claudock.app/Contents/MacOS/Electron', '--login'], { CLAUDE_CONFIG_DIR: '/Users/a b/.claude-<work>&co' })
  assert.match(text, /<string>app\.claudock\.login<\/string>/)
  assert.match(text, /<string>\/Users\/a b\/Library\/Application Support\/Claudock\/Claudock\.app\/Contents\/MacOS\/Electron<\/string>\n {4}<string>--login<\/string>/)
  assert.match(text, /<key>CLAUDE_CONFIG_DIR<\/key>\n {4}<string>\/Users\/a b\/\.claude-&lt;work&gt;&amp;co<\/string>/)
  assert.match(text, /<key>RunAtLoad<\/key>\n {2}<true\/>/)
  assert.doesNotMatch(launchAgent(['/x', '--login']), /EnvironmentVariables/)
})

test('login files: the autostart entry quotes what needs it and doubles percent signs', () => {
  assert.equal(execArg('/usr/bin/claudock'), '/usr/bin/claudock')
  assert.equal(execArg('/home/a b/$HOME/"x"'), '"/home/a b/\\$HOME/\\"x\\""')
  // in the file each of those backslashes is written twice (the Exec value is itself an escaped string)
  assert.match(autostartEntry(['/home/a b/$x'], {}), /^Exec="\/home\/a b\/\\\\\$x"$/m)
  const entry = autostartEntry(['/opt/Claudock/claudock', '--login'], { CLAUDE_CONFIG_DIR: '/home/a/100% work' })
  assert.match(entry, /^Exec=env "CLAUDE_CONFIG_DIR=\/home\/a\/100%% work" \/opt\/Claudock\/claudock --login$/m)
  assert.match(entry, /^Type=Application$/m)
})

test('login files: paths that move (npx cache, disk images, translocated apps) are refused', () => {
  assert.equal(inNpxCache('/Users/a/.npm/_npx/3f9a/node_modules/claudock'), true)
  assert.equal(inNpxCache('C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\3f9a\\node_modules\\claudock'), true)
  assert.equal(inNpxCache('/usr/local/lib/node_modules/claudock'), false)
  assert.equal(unstablePath('/Volumes/Claudock 0.2.0/Claudock.app/Contents/MacOS/Claudock'), true)
  assert.equal(unstablePath('/private/var/folders/x/T/AppTranslocation/9F2/d/Claudock.app/Contents/MacOS/Claudock'), true)
  assert.equal(unstablePath('/Applications/Claudock.app/Contents/MacOS/Claudock'), false)
})
