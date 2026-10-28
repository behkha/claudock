import test from 'node:test'
import assert from 'node:assert/strict'
import type { LimitsState, LiveLimits } from '@shared/api/limits'
import type { AlertPrefs, LiveSession, SessionsState } from '@shared/api/sessions'
import { normalizeAlertPrefs } from '../connect/sessionModel.ts'
import { glance } from './glance.ts'
import { LimitAlertRule } from './limitAlert.ts'
import { autostartEntry, execArg, inNpxCache, launchAgent, unstablePath } from './loginFiles.ts'

const NOW = 1_800_000_000_000
const H = 3_600_000
const tokens = { fiveHour: { tokens: 0, sessions: 0 }, today: { tokens: 0, sessions: 0 }, sevenDay: { tokens: 0, sessions: 0 } }

const limits = (five: number | null, week: number | null, step: LimitsState['step'] = 'on', resetsIn = H): LimitsState => ({
  step,
  tokens,
  live: {
    at: NOW,
    fiveHour: five === null ? null : { usedPercentage: five, resetsAt: NOW + resetsIn },
    sevenDay: week === null ? null : { usedPercentage: week, resetsAt: NOW + 50 * H }
  }
})

const session = (name: string, status: LiveSession['status']): LiveSession => ({
  id: name,
  status,
  since: NOW - 60_000,
  cwd: `/work/${name}`,
  name,
  kind: status === 'waiting' ? 'permission' : null,
  tool: status === 'waiting' ? 'Bash' : null,
  message: null
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
  assert.equal(glance({ step: 'on', live: null, tokens }, undefined, NOW).title, '')
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
  fiveHour: five === null ? null : { usedPercentage: five, resetsAt: fiveResets },
  sevenDay: week === null ? null : { usedPercentage: week, resetsAt: NOW + 90 * H }
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
