import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AlertPrefs, LiveSession, SessionStatus, WaitKind } from '@shared/api/sessions'
import { baselineAfterConnect, disconnectPlan, type Baseline } from './baseline.ts'
import { HOOKS, hookCommand, hookEntry, hookScript, shQuote } from './hookScript.ts'
import {
  AlertRule,
  GRACE_MS,
  GROUP_MS,
  alertText,
  applyLines,
  isGone,
  normalizeAlertPrefs,
  parseEvent,
  sessionName,
  shownWait,
  toLiveSessions,
  transitions,
  type AlertClock,
  type SessionFold
} from './sessionModel.ts'
import { addHooks, hasHooks, hooksProblem, missingGroups, removeHooks, type HookGroup } from './settingsHooks.ts'

/* ------------------------------------------------------------------ the hook script, run with sh */

const WIN = process.platform === 'win32'

/** A connect folder with the script in it. The folder name has a quote and a space, as a real userData path might. */
function folder(): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudock-hook-')), "it's here")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'hook.sh'), hookScript(dir), { mode: 0o755 })
  return dir
}

const commandFor = (dir: string, step: string): string => `sh ${shQuote(path.join(dir, 'hook.sh'))} ${step}`

function run(dir: string, step: string, input: unknown, env: Record<string, string> = {}): { stdout: string; status: number | null } {
  const r = spawnSync('/bin/sh', ['-c', commandFor(dir, step)], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...process.env, ...env }, encoding: 'utf8' })
  return { stdout: r.stdout, status: r.status }
}

const SID = '7f3c2a10-1b2c-4d5e-8f90-0123456789ab'
const file = (dir: string, id = SID): string => path.join(dir, 'sessions', `${id}.jsonl`)
const lines = (dir: string, id = SID): Record<string, unknown>[] =>
  fs.existsSync(file(dir, id)) ? fs.readFileSync(file(dir, id), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : []
const base = { session_id: SID, transcript_path: '/tmp/t.jsonl', cwd: '/Users/me/code/api-server', permission_mode: 'default' }

test('hook script: each step appends one line, prints nothing, exits 0; SessionEnd removes the file', { skip: WIN }, () => {
  const dir = folder()
  const prompt = 'SECRET PROMPT TEXT {"session_id":"evil"} \' $(rm -rf /)'
  const steps: [string, object][] = [
    ['prompt', { hook_event_name: 'UserPromptSubmit', prompt }],
    ['ask', { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } }],
    ['notify', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }],
    ['tool', { hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'sub-1', tool_input: { command: 'npm test' }, tool_response: { stdout: 'x' } }],
    ['question', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }],
    ['stop', { hook_event_name: 'Stop', stop_hook_active: false }]
  ]
  for (const [step, extra] of steps) {
    const r = run(dir, step, { ...base, ...extra })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
  const got = lines(dir)
  assert.deepEqual(
    got.map((l) => [l.e, l.tool, l.agent, l.nt]),
    [
      ['prompt', null, null, null],
      ['ask', 'Bash', null, null],
      ['notify', null, null, 'permission_prompt'],
      ['tool', 'Bash', 'sub-1', null],
      ['question', 'AskUserQuestion', null, null],
      ['stop', null, null, null]
    ]
  )
  assert.equal(got[2].message, 'Claude needs your permission to use Bash')
  assert.ok(got.every((l) => l.v === 2 && typeof l.at === 'number'))
  assert.ok((got[0].pid as number) > 0 && got[0].cwd === '/Users/me/code/api-server', 'records the process and folder')
  assert.ok((got[3].pid as number) > 0 && got[3].cwd === null && got[3].message === null, 'a finished tool keeps its line short, with the process')
  assert.ok(!fs.readFileSync(file(dir), 'utf8').includes('SECRET'), 'the prompt is never stored')
  assert.ok(!fs.readFileSync(file(dir), 'utf8').includes('npm test'), 'nor tool input')
  assert.ok(got.every((l) => parseEvent(JSON.stringify(l)) !== null))
  run(dir, 'end', { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })
  assert.equal(fs.existsSync(file(dir)), false)
})

test('hook script: hooks running at the same time each add one whole line', { skip: WIN }, async () => {
  const dir = folder()
  const n = 48
  await Promise.all(
    Array.from(
      { length: n },
      (_, i) =>
        new Promise<void>((resolve) => {
          const child = spawn('/bin/sh', ['-c', commandFor(dir, i % 2 ? 'tool' : 'ask')], { stdio: ['pipe', 'ignore', 'ignore'] })
          child.on('close', () => resolve())
          child.stdin.end(JSON.stringify({ ...base, tool_name: `T${i}`, message: 'm'.repeat(590), cwd: '/x/' + 'c'.repeat(1000) }))
        })
    )
  )
  const got = lines(dir)
  assert.equal(got.length, n)
  assert.deepEqual(got.map((l) => l.tool).sort(), Array.from({ length: n }, (_, i) => `T${i}`).sort())
})

test('hook script: refuses session ids that are not plain ids, unknown steps, and odd input', { skip: WIN }, () => {
  const dir = folder()
  for (const id of ['../x', '../../etc/passwd', 'a/b', '', 'a b', 'x"y', '$(id)']) {
    const r = run(dir, 'prompt', { ...base, session_id: id })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
  for (const input of ['', 'not json', '[]', '{"session_id": 42}', '{"nested": {"session_id": "abc"}}']) assert.equal(run(dir, 'prompt', input).status, 0)
  run(dir, 'bogus', base)
  run(dir, 'end', { ...base, session_id: '../x' })
  const files = fs.existsSync(path.join(dir, 'sessions')) ? fs.readdirSync(path.join(dir, 'sessions')) : []
  assert.deepEqual(files, [], 'nothing written for a bad id, a nested session_id or an unknown step')
  assert.deepEqual(fs.readdirSync(path.dirname(dir)).sort(), ["it's here"], 'nothing written outside the folder')
})

test('hook script: odd but valid strings round-trip into valid JSON', { skip: WIN }, () => {
  const dir = folder()
  const cwd = '/Users/me/code/"quoted" {braces} [x] \\back\\slash \u00e9 50% ok'
  run(dir, 'notify', { hook_event_name: 'Notification', message: 'Allow "rm -rf"? {x} %s', cwd, notification_type: 'elicitation_dialog', session_id: SID, extra: { cwd: 'nested, ignored' } })
  const [l] = lines(dir)
  assert.equal(l.cwd, cwd)
  assert.equal(l.message, 'Allow "rm -rf"? {x} %s')
  const ev = parseEvent(fs.readFileSync(file(dir), 'utf8').trim())
  assert.deepEqual([ev?.e, ev?.nt, ev?.cwd], ['notify', 'elicitation_dialog', cwd])
})

test('hook script: a large payload costs no parsing time', { skip: WIN }, () => {
  const dir = folder()
  const t = Date.now()
  run(dir, 'tool', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: { content: '{"a":"b"}\n'.repeat(150_000) } })
  run(dir, 'prompt', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'p'.repeat(2_000_000) })
  run(dir, 'notify', { ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x'.repeat(700) })
  run(dir, 'tool', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'a'.repeat(300) })
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`)
  assert.deepEqual(lines(dir).map((l) => [l.e, l.tool, l.message]), [['tool', 'Read', null], ['prompt', null, null], ['notify', null, null], ['tool', 'Read', null]], 'an over-long message is left out')
  assert.equal(lines(dir)[3].agent, '?', 'an over-long agent id matches nothing, never the main agent')
})

test('hook script: records the terminal app only when it looks like a bundle id', { skip: WIN }, () => {
  const dir = folder()
  run(dir, 'prompt', base, { __CFBundleIdentifier: 'com.googlecode.iterm2' })
  run(dir, 'prompt', base, { __CFBundleIdentifier: 'evil"},"x":"' })
  run(dir, 'prompt', base, { __CFBundleIdentifier: '-a' })
  assert.deepEqual(lines(dir).map((l) => l.app), ['com.googlecode.iterm2', null, null])
})

/* ------------------------------------------------------------------ hooks in settings.json */

const DIR = '/Users/me/Library/Application Support/Claudock/connect/02ffe442ba9d'
const groups: HookGroup[] = HOOKS.map((h) => ({ event: h.event, matcher: h.matcher, entry: hookEntry(DIR, h) }))
const ours = new Set(HOOKS.map((h) => hookCommand(DIR, h.step)))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

test('settings hooks: add then remove gives back the same object, for a grid of starting points', () => {
  const user = { matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/guard.sh' }] }
  const starts: Record<string, unknown>[] = [
    {},
    { model: 'opus' },
    { hooks: {} },
    { hooks: { Stop: [] } },
    { hooks: { PreToolUse: [user], Stop: [{ hooks: [{ type: 'command', command: 'afplay x.aiff' }] }] }, statusLine: { type: 'command', command: 'x' } },
    { hooks: { Notification: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }], CustomEvent: [{ hooks: [] }] } }
  ]
  for (const start of starts) {
    const s = clone(start)
    const added = addHooks(s, groups)
    assert.ok(hasHooks(s, ours))
    assert.deepEqual(missingGroups(s, groups), [], 'all present after adding')
    assert.ok(removeHooks(s, ours, added))
    assert.deepEqual(s, start, JSON.stringify(start))
    assert.ok(!hasHooks(s, ours))
  }
})

test('settings hooks: user groups keep their order and come first; adding twice adds nothing', () => {
  const s: Record<string, unknown> = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }
  addHooks(s, groups)
  const stop = (s.hooks as Record<string, unknown[]>).Stop
  assert.equal(stop.length, 2)
  assert.deepEqual(stop[0], { hooks: [{ type: 'command', command: 'mine' }] })
  const again = clone(s)
  const added = addHooks(again, groups)
  assert.deepEqual(again, s)
  assert.deepEqual(added.events, [])
  assert.equal(added.hooksKey, false)
  assert.deepEqual((s.hooks as Record<string, unknown[]>).Notification, [{ matcher: 'permission_prompt|elicitation_dialog|elicitation_url_dialog', hooks: [hookEntry(DIR, HOOKS.find((h) => h.event === 'Notification') as (typeof HOOKS)[number])] }])
})

test('settings hooks: removal finds ours where the user moved it, and keeps their entries', () => {
  const mine = { type: 'command', command: 'mine' }
  const s: Record<string, unknown> = { hooks: { Stop: [{ hooks: [mine, { type: 'command', command: hookCommand(DIR, 'stop') }] }] } }
  assert.ok(removeHooks(s, ours, null))
  assert.deepEqual(s, { hooks: { Stop: [{ hooks: [mine] }] } })
  assert.equal(removeHooks(s, ours, null), false, 'nothing left to remove')
})

test('settings hooks: without a record of what was created, empty containers stay', () => {
  const s: Record<string, unknown> = {}
  addHooks(s, groups)
  removeHooks(s, ours, null)
  assert.deepEqual(Object.keys(s.hooks as object).sort(), [...new Set(HOOKS.map((h) => h.event))].sort())
})

test('settings hooks: odd shapes are refused, not rewritten', () => {
  assert.equal(hooksProblem({}), null)
  assert.match(hooksProblem({ hooks: [] }) ?? '', /isn't an object/)
  assert.match(hooksProblem({ hooks: { Stop: {} } }) ?? '', /hooks\.Stop/)
  assert.throws(() => addHooks({ hooks: 'x' }, groups))
  const odd = { hooks: { Stop: ['x', { nohooks: 1 }] } }
  const copy = clone(odd)
  assert.equal(removeHooks(copy, ours, null), false)
  assert.deepEqual(copy, odd)
})

test('hook commands quote the folder for sh', () => {
  assert.equal(hookCommand("/a/it's", 'stop'), `sh '/a/it'\\''s/hook.sh' stop`)
  assert.equal(HOOKS.find((h) => h.event === 'SessionEnd')?.async, false)
  assert.ok(!HOOKS.some((h) => h.event === 'Notification' && (h.matcher ?? '').includes('idle_prompt')))
})

/* ------------------------------------------------------------------ working out the state from the lines */

type Ev = Partial<{ e: string; tool: string | null; agent: string | null; nt: string | null; message: string | null; pid: number; cwd: string | null; at: number }>
let clockS = 1_761_550_000
const line = (ev: Ev): string => JSON.stringify({ v: 2, at: ev.at ?? clockS++, tool: null, agent: null, nt: null, message: null, cwd: '/x/api', pid: 0, app: null, ...ev })
const fold = (...evs: Ev[]): SessionFold | null => applyLines(null, 'a', evs.map(line))
const view = (f: SessionFold | null): [string | undefined, string | null | undefined, string | null | undefined] => {
  const w = f && f.status === 'waiting' ? shownWait(f) : null
  return [f?.status, w?.kind ?? null, w?.tool ?? null]
}

test('parseEvent accepts what the script writes and nothing else', () => {
  const ok = '{"v":2,"at":1761550000,"e":"ask","tool":"Bash","agent":"researcher@team","nt":null,"message":null,"cwd":"/a/b","pid":42,"app":"com.apple.Terminal"}'
  assert.deepEqual(parseEvent(ok), { at: 1761550000000, e: 'ask', tool: 'Bash', agent: 'researcher@team', nt: null, message: null, cwd: '/a/b', pid: 42, app: 'com.apple.Terminal' })
  for (const bad of ['{"v":1,"at":1,"e":"ask"}', '{"v":2,"at":1,"e":"end"}', '{"v":2,"e":"ask"}', 'nope', '[]', '{"v":2,"at":-1,"e":"ask"}']) assert.equal(parseEvent(bad), null, bad)
  const odd = parseEvent('{"v":2,"at":1,"e":"tool","tool":"a\\"b","agent":"x y","pid":-3,"app":"-a"}')
  assert.deepEqual([odd?.tool, odd?.agent, odd?.pid, odd?.app], ['?', '?', 0, null], 'odd names become "?", bad pid and app are dropped')
})

test('state: a permission dialog becomes a wait only once Claude Code says it still needs you', () => {
  assert.deepEqual(view(fold({ e: 'prompt' }, { e: 'ask', tool: 'Bash' })), ['working', null, null], 'quick deny: no hook, no wait')
  assert.deepEqual(view(fold({ e: 'prompt' }, { e: 'ask', tool: 'Bash' }, { e: 'tool', tool: 'Bash' })), ['working', null, null], 'quick approve')
  const waiting = fold({ e: 'prompt' }, { e: 'ask', tool: 'Bash' }, { e: 'notify', nt: 'permission_prompt', message: 'm' })
  assert.deepEqual(view(waiting), ['waiting', 'permission', 'Bash'])
  assert.equal(waiting && shownWait(waiting)?.message, 'm')
})

test('state: a wait ends only when its own tool finishes, in the same agent', () => {
  const start = [{ e: 'prompt' }, { e: 'ask', tool: 'Bash' }, { e: 'notify', nt: 'permission_prompt' }]
  assert.equal(fold(...start, { e: 'tool', tool: 'Read' })?.status, 'waiting', 'another tool')
  assert.equal(fold(...start, { e: 'tool', tool: 'Bash', agent: 'sub-1' })?.status, 'waiting', "a subagent's Bash")
  assert.equal(fold(...start, { e: 'tool', tool: 'Bash', agent: '?' })?.status, 'waiting', 'an id that could not be read')
  assert.equal(fold(...start, { e: 'tool', tool: 'Bash' })?.status, 'working')
  const sub = [{ e: 'prompt' }, { e: 'ask', tool: 'Edit', agent: 'sub-1' }, { e: 'notify', nt: 'permission_prompt' }]
  assert.equal(fold(...sub, { e: 'tool', tool: 'Edit' })?.status, 'waiting', "the main agent's Edit")
  assert.equal(fold(...sub, { e: 'tool', tool: 'Edit', agent: 'researcher@team' })?.status, 'waiting', 'a teammate')
  assert.equal(fold(...sub, { e: 'tool', tool: 'Edit', agent: 'sub-1' })?.status, 'working')
})

test('state: without a PermissionRequest (older Claude Code, or a dialog already answered) only the main agent ends the wait', () => {
  const old = [{ e: 'prompt' }, { e: 'notify', nt: 'permission_prompt' }]
  assert.deepEqual(view(fold(...old)), ['waiting', 'permission', null])
  assert.equal(fold(...old, { e: 'tool', tool: 'Read', agent: 'sub-2' })?.status, 'waiting')
  assert.equal(fold(...old, { e: 'tool', tool: 'Read', agent: '?' })?.status, 'waiting')
  assert.equal(fold(...old, { e: 'tool', tool: 'Read' })?.status, 'working')
  // an answered dialog is forgotten, so a later notification can't pin the wait on its tool
  assert.deepEqual(view(fold({ e: 'prompt', at: 10 }, { e: 'ask', tool: 'Bash', at: 11 }, { e: 'tool', tool: 'Bash', at: 12 }, { e: 'notify', nt: 'permission_prompt', at: 40 })), ['waiting', 'permission', null])
})

test('state: a question holds whatever order its hooks land in', () => {
  for (const order of [
    [{ e: 'question', tool: 'AskUserQuestion' }, { e: 'ask', tool: 'AskUserQuestion' }],
    [{ e: 'ask', tool: 'AskUserQuestion' }, { e: 'question', tool: 'AskUserQuestion' }]
  ]) {
    const f = fold({ e: 'prompt' }, ...order, { e: 'notify', nt: 'permission_prompt' })
    assert.deepEqual(view(f), ['waiting', 'question', 'AskUserQuestion'])
    assert.equal(fold({ e: 'prompt' }, ...order, { e: 'tool', tool: 'Bash' })?.status, 'waiting')
    assert.equal(fold({ e: 'prompt' }, ...order, { e: 'tool', tool: 'AskUserQuestion' })?.status, 'working', 'answered')
  }
  assert.deepEqual(view(fold({ e: 'prompt' }, { e: 'ask', tool: 'Bash' }, { e: 'notify', nt: 'permission_prompt' }, { e: 'question' })), ['waiting', 'permission', 'Bash'], 'the older wait shows first')
})

test('state: MCP input waits, ignored notifications, and the end of a turn', () => {
  assert.deepEqual(view(fold({ e: 'prompt' }, { e: 'notify', nt: 'elicitation_url_dialog', message: 'Sign in' })), ['waiting', 'input', null])
  for (const nt of ['idle_prompt', 'auth_success', null]) assert.equal(fold({ e: 'stop' }, { e: 'notify', nt })?.status, 'done', String(nt))
  const waiting = [{ e: 'prompt' }, { e: 'ask', tool: 'Bash' }, { e: 'notify', nt: 'permission_prompt' }]
  assert.equal(fold(...waiting, { e: 'stop' })?.status, 'done', 'Stop and StopFailure end a wait')
  assert.equal(fold(...waiting, { e: 'prompt' })?.status, 'working')
  assert.equal(fold({ e: 'prompt' }, { e: 'stop' }, { e: 'tool', tool: 'Bash' }, { e: 'ask', tool: 'Bash' })?.status, 'done', 'late lines from the stopped turn')
  assert.equal(fold({ e: 'tool', tool: 'Read' })?.status, 'working', 'connected mid-session')
})

test('state: since moves only when the status does; bad lines are skipped', () => {
  const f = fold({ e: 'prompt', at: 100 }, { e: 'prompt', at: 105 }, { e: 'tool', tool: 'Read', at: 106 })
  assert.deepEqual([f?.status, f?.since, f?.at], ['working', 100_000, 106_000])
  assert.equal(fold({ e: 'prompt', at: 100 }, { e: 'notify', nt: 'permission_prompt', at: 107 })?.since, 107_000)
  const g = applyLines(null, 'a', ['', 'garbage', line({ e: 'prompt', pid: 7 }), '{"v":2'])
  assert.deepEqual([g?.status, g?.pid], ['working', 7])
  const h = applyLines(g, 'a', [line({ e: 'tool', tool: 'Read' })])
  assert.equal(h?.pid, 7, 'a tool line (pid 0) keeps the known process')
})

test('state: a second dialog during a wait is kept, and the session waits until both are answered', () => {
  const two = [{ e: 'prompt' }, { e: 'ask', tool: 'Bash', agent: 'a1' }, { e: 'notify', nt: 'permission_prompt' }, { e: 'ask', tool: 'Write', agent: 'b1' }]
  assert.deepEqual(view(fold(...two, { e: 'tool', tool: 'Bash', agent: 'a1' })), ['working', null, null], 'b1 not notified yet')
  const both = [...two, { e: 'notify', nt: 'permission_prompt' }]
  assert.deepEqual(view(fold(...both)), ['waiting', 'permission', 'Bash'], 'the oldest shows')
  const bothF = fold(...both)
  const after = applyLines(bothF, 'a', [line({ e: 'tool', tool: 'Bash', agent: 'a1' })])
  assert.deepEqual(view(after), ['waiting', 'permission', 'Write'], 'b1 still needs you')
  assert.equal(after?.since, bothF?.since, 'still the same wait-time: no second alert')
  assert.equal(fold(...both, { e: 'tool', tool: 'Bash', agent: 'a1' }, { e: 'tool', tool: 'Write', agent: 'b1' })?.status, 'working')
  // a question over a permission wait: both kept, the clock keeps running
  const q = fold({ e: 'prompt', at: 40 }, { e: 'ask', tool: 'Bash', agent: 'a1', at: 41 }, { e: 'notify', nt: 'permission_prompt', at: 50 }, { e: 'question', agent: 'a2', at: 51 })
  assert.deepEqual([...view(q), q?.since], ['waiting', 'permission', 'Bash', 50_000])
  assert.deepEqual(view(applyLines(q, 'a', [line({ e: 'tool', tool: 'AskUserQuestion', agent: 'a2' })])), ['waiting', 'permission', 'Bash'])
  assert.deepEqual(view(applyLines(q, 'a', [line({ e: 'tool', tool: 'Bash', agent: 'a1' })])), ['waiting', 'question', 'AskUserQuestion'])
})

test('state: a tool line that beats the notification for the dialog it answered starts no wait', () => {
  const f = fold({ e: 'prompt', at: 10 }, { e: 'ask', tool: 'Bash', at: 11 }, { e: 'tool', tool: 'Bash', at: 17 }, { e: 'notify', nt: 'permission_prompt', at: 17 })
  assert.equal(f?.status, 'working')
  const later = fold({ e: 'prompt', at: 10 }, { e: 'ask', tool: 'Bash', at: 11 }, { e: 'tool', tool: 'Bash', at: 12 }, { e: 'notify', nt: 'permission_prompt', at: 30 })
  assert.deepEqual(view(later), ['waiting', 'permission', null], 'a notification long after is a new wait')
  // a denied dialog (no hook) stays noted until the turn ends; the newest dialog takes the notification
  const denied = fold({ e: 'prompt' }, { e: 'ask', tool: 'Bash' }, { e: 'ask', tool: 'Edit' }, { e: 'notify', nt: 'permission_prompt' })
  assert.deepEqual(view(denied), ['waiting', 'permission', 'Edit'])
  assert.deepEqual(fold({ e: 'prompt' }, { e: 'ask', tool: 'Bash' }, { e: 'prompt' })?.waits, [], 'a new prompt clears noted dialogs')
})

test('state: a question that Claude Code also notifies about ends when it is answered', () => {
  for (const order of [
    [{ e: 'question' }, { e: 'ask', tool: 'AskUserQuestion' }, { e: 'notify', nt: 'permission_prompt' }],
    [{ e: 'ask', tool: 'AskUserQuestion' }, { e: 'question' }, { e: 'notify', nt: 'permission_prompt' }],
    [{ e: 'question' }, { e: 'notify', nt: 'permission_prompt' }, { e: 'ask', tool: 'AskUserQuestion' }]
  ]) {
    const f = fold({ e: 'prompt' }, ...order)
    assert.deepEqual(view(f), ['waiting', 'question', 'AskUserQuestion'])
    const done = applyLines(f, 'a', [line({ e: 'tool', tool: 'AskUserQuestion' })])
    assert.deepEqual([done?.status, done?.waits.length], ['working', 0], JSON.stringify(order))
  }
})

test('state: a late notification never lands on a dialog older than the one just answered', () => {
  // a background subagent's auto-denied dialog (no tool line), then a dialog answered just as its notification fires
  const f = fold({ e: 'prompt', at: 10 }, { e: 'ask', tool: 'Bash', agent: 'bg1', at: 11 }, { e: 'ask', tool: 'Edit', at: 20 }, { e: 'tool', tool: 'Edit', at: 26 }, { e: 'notify', nt: 'permission_prompt', at: 26 })
  assert.equal(f?.status, 'working')
  // much later, a notification with only that stale dialog noted is a wait for an unknown tool, not for bg1's Bash
  const g = applyLines(f, 'a', [line({ e: 'notify', nt: 'permission_prompt', at: 60 })])
  assert.deepEqual(view(g), ['waiting', 'permission', null])
  assert.equal(applyLines(g, 'a', [line({ e: 'tool', tool: 'Read', at: 61 })])?.status, 'working')
})

test('state: dialogs noted in the same second keep their order', () => {
  const two = [{ e: 'prompt', at: 99 }, { e: 'ask', tool: 'Bash', agent: 'a1', at: 100 }, { e: 'ask', tool: 'Edit', agent: 'a2', at: 100 }, { e: 'tool', tool: 'Bash', agent: 'a1', at: 101 }]
  const f = fold(...two, { e: 'notify', nt: 'permission_prompt', at: 106 })
  assert.deepEqual(view(f), ['waiting', 'permission', 'Edit'], 'the notification is for the dialog still open')
  const g = applyLines(f, 'a', [line({ e: 'tool', tool: 'Edit', agent: 'a2', at: 110 })])
  assert.deepEqual([g?.status, g?.waits.length], ['working', 0], 'both answered: nothing left')
  const q = fold({ e: 'prompt', at: 98 }, { e: 'question', agent: 'a3', at: 99 }, ...two.slice(1), { e: 'notify', nt: 'permission_prompt', at: 106 })
  const h = applyLines(q, 'a', [line({ e: 'tool', tool: 'AskUserQuestion', agent: 'a3', at: 120 })])
  assert.deepEqual(view(h), ['waiting', 'permission', 'Edit'], 'the open dialog still needs you after the question is answered')
})

test('isGone: a known process decides; without one, 12 hours of quiet', () => {
  const now = 100 * 3_600_000
  const f = fold({ e: 'prompt', pid: 5 }) as SessionFold
  assert.equal(isGone(f, now, () => true), false)
  assert.equal(isGone(f, now, () => false), true)
  assert.equal(isGone({ ...f, pid: 0, at: now - 11 * 3_600_000 }, now, () => false), false)
  assert.equal(isGone({ ...f, pid: 0, at: now - 13 * 3_600_000 }, now, () => true), true)
})

const ls = (id: string, status: SessionStatus, since: number, kind: WaitKind | null = status === 'waiting' ? 'permission' : null, cwd = `/x/${id}`): LiveSession => ({
  id,
  status,
  since,
  cwd,
  name: sessionName(cwd, id),
  kind,
  tool: null,
  message: null
})

test('sessions are ordered waiting (longest first), working, done (latest first); names come from the folder', () => {
  const f = (id: string, status: SessionStatus, since: number): SessionFold => ({ ...(fold({ e: 'prompt' }) as SessionFold), id, status, since, cwd: `/x/${id}` })
  assert.deepEqual(toLiveSessions([f('d', 'done', 5), f('w1', 'waiting', 9), f('k', 'working', 3), f('w2', 'waiting', 4), f('d2', 'done', 8)]).map((s) => s.id), ['w2', 'w1', 'k', 'd2', 'd'])
  assert.equal(sessionName('/Users/me/code/api-server/', 'x'), 'api-server')
  assert.equal(sessionName('C:\\code\\app', 'x'), 'app')
  assert.equal(sessionName(null, '7f3c2a10-1b2c'), '7f3c2a10')
})

test('transitions: only a change into waiting alerts, never the first read; done only from working', () => {
  assert.deepEqual(transitions(null, [ls('a', 'waiting', 1)]), { waiting: [], done: [] }, 'already waiting at launch: no alert')
  const prev = new Map([ls('a', 'waiting', 1), ls('b', 'working', 1), ls('c', 'waiting', 1), ls('m', 'working', 1)].map((s) => [s.id, s]))
  const t = transitions(prev, [ls('a', 'waiting', 1), ls('b', 'waiting', 2), ls('c', 'done', 2), ls('n', 'waiting', 2), ls('m', 'done', 2)])
  assert.deepEqual(t.waiting.map((s) => s.id).sort(), ['b', 'n'])
  assert.deepEqual(t.done.map((s) => s.id), ['m'])
})

test('alertText: one session names it, several are grouped', () => {
  const a = { ...ls('a', 'waiting', 1, 'permission', '/x/api-server'), tool: 'Bash' }
  const b = ls('b', 'waiting', 2, 'question', '/x/app')
  const c = { ...ls('c', 'waiting', 3, 'input', '/x/notes'), message: 'Sign in to Linear' }
  assert.deepEqual(alertText([a], 'waiting'), { title: 'api-server is waiting for you', body: 'Claude needs your permission to use Bash' })
  assert.deepEqual(alertText([b], 'waiting'), { title: 'app is waiting for you', body: 'Claude has a question' })
  assert.deepEqual(alertText([c], 'waiting').body, 'Sign in to Linear')
  assert.deepEqual(alertText([a, b], 'waiting'), { title: '2 sessions are waiting for you', body: 'api-server and app' })
  assert.deepEqual(alertText([a, b, c], 'waiting'), { title: '3 sessions are waiting for you', body: 'api-server, app and notes' })
  assert.equal(alertText([c], 'reminder').title, 'notes is still waiting for you')
  assert.equal(alertText([a], 'done').title, 'api-server is done')
})

test('normalizeAlertPrefs: defaults are the approved rule; bad values keep the previous ones', () => {
  assert.deepEqual(normalizeAlertPrefs(undefined), { pausedUntil: null, reminderMinutes: null, doneAlert: false, sound: false, limitPercent: null, limitReset: false })
  const p = normalizeAlertPrefs({ pausedUntil: 5000, reminderMinutes: 10, doneAlert: true, sound: true, limitPercent: 80, limitReset: true })
  assert.deepEqual(p, { pausedUntil: 5000, reminderMinutes: 10, doneAlert: true, sound: true, limitPercent: 80, limitReset: true })
  assert.deepEqual(normalizeAlertPrefs({ pausedUntil: -1, reminderMinutes: 0.5, doneAlert: 'yes', sound: 1, limitPercent: 101, limitReset: 'on' }, p), p)
  assert.equal(normalizeAlertPrefs({ limitPercent: null }, p).limitPercent, null)
  assert.deepEqual(normalizeAlertPrefs({ pausedUntil: null, reminderMinutes: null }, p), { ...p, pausedUntil: null, reminderMinutes: null })
  assert.equal(normalizeAlertPrefs({ reminderMinutes: 100_000 }).reminderMinutes, null)
})

/* ------------------------------------------------------------------ byte-identical Disconnect */

test('baseline: set by the first Connect, kept while only Claudock writes, dropped once anything else does', () => {
  const b0 = baselineAfterConnect(null, true, 'orig', 'w1', 'snap-1')
  assert.deepEqual(b0, { existed: true, snapshotId: 'snap-1', sha: 'w1' })
  assert.deepEqual(baselineAfterConnect(null, true, null, 'w1', null), { existed: false, snapshotId: null, sha: 'w1' }, 'no file before: Disconnect trashes it')
  assert.deepEqual(baselineAfterConnect(b0, false, 'w1', 'w2', 'snap-2'), { existed: true, snapshotId: 'snap-1', sha: 'w2' }, 'second part: the original snapshot stays')
  assert.equal(baselineAfterConnect(b0, false, 'edited', 'w2', 'snap-2'), null, 'someone edited in between')
  assert.equal(baselineAfterConnect(b0, false, null, 'w2', null), null, 'file deleted in between')
  assert.equal(baselineAfterConnect(null, false, 'w1', 'w2', 'snap-2'), null, 'no baseline to keep')
})

test('disconnectPlan: restore or trash only when the file is exactly what Claudock wrote', () => {
  const b: Baseline = { existed: true, snapshotId: 'snap-1', sha: 'w' }
  assert.equal(disconnectPlan(b, 'w'), 'restore')
  assert.equal(disconnectPlan(b, 'other'), 'keys')
  assert.equal(disconnectPlan(b, null), 'keys')
  assert.equal(disconnectPlan(null, 'w'), 'keys')
  assert.equal(disconnectPlan({ ...b, existed: false, snapshotId: null }, 'w'), 'trash')
  assert.equal(disconnectPlan({ ...b, snapshotId: null }, 'w'), 'keys')
})

/* ------------------------------------------------------------------ the alert rule with a fake clock */

function fakeClock(): AlertClock & { advance(ms: number): void } {
  let t = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: t + ms, fn })
      return seq
    },
    clearTimeout: (id) => void timers.delete(id as number),
    advance(ms) {
      const end = t + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        timers.delete(next[0])
        t = next[1].at
        next[1].fn()
      }
      t = end
    }
  }
}

function harness(over: Partial<AlertPrefs> = {}) {
  const clock = fakeClock()
  const prefs: AlertPrefs = { ...normalizeAlertPrefs(undefined), ...over }
  const posted: string[] = []
  const rule = new AlertRule(clock, () => prefs, (t) => posted.push(`${t.title} | ${t.body}`))
  let prev: Map<string, LiveSession> | null = null
  const feed = (list: LiveSession[]): void => {
    rule.update(list, transitions(prev, list))
    prev = new Map(list.map((s) => [s.id, s]))
  }
  return { clock, prefs, posted, feed }
}

test('alert rule: a permission wait alerts after the grouping window, once; none at launch; several grouped', () => {
  const h = harness()
  h.feed([ls('old', 'waiting', 1)])
  h.clock.advance(10_000)
  assert.deepEqual(h.posted, [], 'already waiting at launch')
  h.feed([ls('old', 'waiting', 1), ls('a', 'working', 2), ls('b', 'working', 3)])
  h.feed([ls('old', 'waiting', 1), ls('a', 'waiting', 4), ls('b', 'working', 3)])
  h.clock.advance(GROUP_MS - 1)
  h.feed([ls('old', 'waiting', 1), ls('a', 'waiting', 4), ls('b', 'waiting', 5)])
  assert.deepEqual(h.posted, [], 'not before the window closes')
  h.clock.advance(1)
  assert.deepEqual(h.posted, ['2 sessions are waiting for you | a and b'])
  h.clock.advance(60_000)
  assert.equal(h.posted.length, 1, 'still waiting: silence')
})

test('alert rule: a question or input request gets a grace period; a wait that ends first raises nothing', () => {
  const h = harness()
  h.feed([ls('a', 'working', 1)])
  h.feed([ls('a', 'waiting', 2)])
  h.clock.advance(GROUP_MS - 100)
  h.feed([ls('a', 'working', 3)])
  h.clock.advance(GRACE_MS + GROUP_MS)
  assert.deepEqual(h.posted, [], 'answered before the alert went out')
  for (const kind of ['question', 'input'] as const) {
    const g = harness()
    g.feed([ls('a', 'working', 1)])
    g.feed([ls('a', 'waiting', 4, kind)])
    g.clock.advance(GRACE_MS + GROUP_MS - 1)
    assert.deepEqual(g.posted, [], kind)
    g.clock.advance(1)
    assert.equal(g.posted.length, 1, kind)
    const q = harness()
    q.feed([ls('a', 'working', 1)])
    q.feed([ls('a', 'waiting', 4, kind)])
    q.clock.advance(GRACE_MS - 100)
    q.feed([ls('a', 'working', 5)])
    q.clock.advance(GRACE_MS * 2)
    assert.deepEqual(q.posted, [], `${kind} answered within the grace period`)
  }
})

test('alert rule: paused means silent; the reminder comes once and only while still the same wait', () => {
  const h = harness({ reminderMinutes: 5 })
  h.feed([ls('a', 'working', 1)])
  h.prefs.pausedUntil = h.clock.now() + 60_000
  h.feed([ls('a', 'waiting', 2)])
  h.clock.advance(GROUP_MS)
  assert.deepEqual(h.posted, [], 'paused')
  h.prefs.pausedUntil = null
  h.clock.advance(5 * 60_000)
  assert.deepEqual(h.posted, ['a is still waiting for you | Claude needs your permission'])
  h.clock.advance(60 * 60_000)
  assert.equal(h.posted.length, 1, 'one reminder, then silence')
  h.feed([ls('a', 'working', 3)])
  h.feed([ls('a', 'waiting', 4)])
  h.clock.advance(GROUP_MS)
  h.feed([ls('a', 'working', 5)])
  h.clock.advance(10 * 60_000)
  assert.equal(h.posted.length, 2, 'the second wait alerted; its reminder was cancelled when it ended')
})

test('alert rule: done alerts only when opted in', () => {
  const off = harness()
  off.feed([ls('a', 'working', 1)])
  off.feed([ls('a', 'done', 2)])
  off.clock.advance(GROUP_MS)
  assert.deepEqual(off.posted, [])
  const on = harness({ doneAlert: true })
  on.feed([ls('a', 'working', 1)])
  on.feed([ls('a', 'done', 2)])
  on.clock.advance(GROUP_MS)
  assert.deepEqual(on.posted, ['a is done | Claude finished'])
})
