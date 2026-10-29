import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LimitsState } from '@shared/api/limits'
import type { LiveSession } from '@shared/api/sessions'
import { limitsLine } from '../../shared/limits.ts'
import { alertText } from '../connect/sessionModel.ts'
import { buildWorkFixture } from '../demo/workFixture.ts'
import { glance } from '../menubar/glance.ts'
import { cleanName, configFolderRe, nameFor, slug, startCommand } from './model.ts'

const NOW = 1_800_000_000_000
const H = 3_600_000
const home = path.join(path.sep, 'Users', 'me')

const limits = (five: number | null, week: number | null, extra: Partial<LimitsState> = {}): LimitsState => ({
  step: 'on',
  tokens: { fiveHour: { tokens: 0, sessions: 0 }, today: { tokens: 1_234_000, sessions: 3 }, sevenDay: { tokens: 0, sessions: 0 } },
  hits: { fiveHour: null, sevenDay: null },
  live: {
    at: NOW,
    fiveHour: five === null ? null : { usedPercentage: five, resetsAt: NOW + H },
    sevenDay: week === null ? null : { usedPercentage: week, resetsAt: NOW + 50 * H }
  },
  ...extra
})

test('names come from the folder', () => {
  assert.equal(nameFor(path.join(home, '.claude')), 'Default')
  assert.equal(nameFor(path.join(home, '.claude-work')), 'Work')
  assert.equal(nameFor(path.join(home, '.claude_side-project')), 'Side project')
  assert.equal(nameFor(path.join(home, '.fixture', 'claude-work')), 'Work')
  assert.equal(nameFor(path.join(home, 'configs', 'acme')), 'Acme')
})

test('names from the renderer are cleaned or refused', () => {
  assert.equal(cleanName('  Work   account '), 'Work account')
  assert.throws(() => cleanName('   '), /name/)
  assert.throws(() => cleanName('a\u0007b'), /character/)
  assert.throws(() => cleanName('x'.repeat(41)), /40/)
  assert.throws(() => cleanName(42), /name/)
})

test('"New folder" names and found folders', () => {
  assert.equal(slug('Side Project!'), 'side-project')
  assert.equal(slug('Café'), 'cafe')
  assert.equal(slug('***'), 'profile')
  assert.ok(configFolderRe(true).test('.claude-work'))
  assert.ok(configFolderRe(true).test('.claude'))
  assert.ok(!configFolderRe(true).test('.claudock'))
  assert.ok(!configFolderRe(true).test('claude-work'))
  assert.ok(configFolderRe(false).test('claude-work'))
})

test('the start command, for each shell', () => {
  const posix = { plain: false, windows: false }
  const me = '/Users/me'
  assert.equal(startCommand(path.posix.join(me, '.claude'), me, { plain: true, windows: false }), 'claude')
  assert.equal(startCommand(path.posix.join(me, '.claude-work'), me, posix), 'CLAUDE_CONFIG_DIR=~/.claude-work claude')
  assert.equal(startCommand(path.posix.join(me, 'My Configs', 'work'), me, posix), 'CLAUDE_CONFIG_DIR="$HOME/My Configs/work" claude')
  assert.equal(startCommand('/opt/claude/work', me, posix), 'CLAUDE_CONFIG_DIR=/opt/claude/work claude')
  assert.equal(startCommand("/opt/it's", me, posix), `CLAUDE_CONFIG_DIR='/opt/it'\\''s' claude`)
  assert.equal(startCommand('C:\\Users\\me\\.claude-work', 'C:\\Users\\me', { plain: false, windows: true }), '$env:CLAUDE_CONFIG_DIR="C:\\Users\\me\\.claude-work"; claude')
})

test('a profile in a list: its percentage, a reached limit, else today’s tokens', () => {
  assert.equal(limitsLine(limits(42, 61), NOW, false), '61%')
  assert.equal(limitsLine(limits(42, 61), NOW, true), '5-hour 42% · Weekly 61%')
  assert.equal(limitsLine(limits(null, 61), NOW, true), 'Weekly 61%')
  assert.equal(limitsLine(limits(42, 61, { step: 'off' }), NOW, true), '1.2M tokens today')
  assert.equal(limitsLine(limits(null, null), NOW, false), '1.2M')
  assert.equal(limitsLine(limits(42, 61, { hits: { fiveHour: { at: NOW + 1, resetsAt: NOW + H }, sevenDay: null } }), NOW, true), 'Limit reached')
})

const waiting = (name: string, profile?: string): LiveSession => ({
  id: name,
  status: 'waiting',
  since: NOW - 60_000,
  cwd: `/work/${name}`,
  name,
  title: null,
  activity: null,
  kind: 'permission',
  tool: 'Bash',
  message: null,
  ...(profile ? { profile } : {})
})

test('menu bar with several profiles: the open profile’s number, everyone’s waiting sessions and limits', () => {
  const profiles = [
    { name: 'Personal', open: false, limits: limits(42, 61) },
    { name: 'Work', open: true, limits: limits(8, 31) }
  ]
  const g = glance(profiles[1].limits, { hooks: 'on', sessions: [waiting('app', 'Personal')], waiting: 1 }, NOW, profiles)
  assert.equal(g.title, '31%')
  assert.equal(g.icon, 'waiting')
  assert.equal(g.tooltip, 'Personal · app is waiting for you\nWork: 5-hour 8% · Weekly 31%\nPersonal: 5-hour 42% · Weekly 61%')
})

test('alerts name the profile once there are several', () => {
  assert.equal(alertText([waiting('api', 'Work')], 'waiting').title, 'Work · api is waiting for you')
  assert.equal(alertText([waiting('api')], 'waiting').title, 'api is waiting for you')
})

test('the work fixture: marked synthetic, with sessions today', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudock-work-')), 'claude-work')
  try {
    buildWorkFixture(dir)
    assert.ok(fs.existsSync(path.join(dir, '.claudock-fixture')))
    assert.equal(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'), 'FAKE-DO-NOT-READ')
    const projects = fs.readdirSync(path.join(dir, 'projects'))
    const files = projects.flatMap((p) => fs.readdirSync(path.join(dir, 'projects', p)).map((f) => path.join(dir, 'projects', p, f)))
    assert.equal(files.length, 10)
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    assert.ok(files.filter((f) => fs.statSync(f).mtimeMs >= midnight.getTime() - 6 * H).length >= 1)
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true })
  }
})
