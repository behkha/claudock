#!/usr/bin/env node
/**
 * Plays Claude Code running three sessions on the fixture, through the session hooks "Connect to Claude Code" added to
 * the fixture's settings.json: the first ends up waiting on a Bash permission prompt, the second working, the third done.
 * It stays running like Claude Code does (Claudock drops a session once its process exits), the working one finishing a
 * tool every 6 s; Ctrl+C ends the sessions.
 *   npm run fixture:hooks [-- --group]   (--group: all three start waiting at once, for the grouped alert)
 * Run `npm run dev`, press "Connect to Claude Code", then run this. Refuses any config folder that is not
 * .fixture/claude, so the real ~/.claude is never involved.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(root, '.fixture', 'claude'))
if (path.basename(dir) !== 'claude' || path.basename(path.dirname(dir)) !== '.fixture') {
  console.error(`refusing ${dir}: the hooks only run on a .fixture/claude folder`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.error('the session hooks are not available on Windows yet')
  process.exit(1)
}
const group = process.argv.includes('--group')

let settings
try {
  settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
} catch {
  console.error(`cannot read ${path.join(dir, 'settings.json')} (run npm run fixture first)`)
  process.exit(1)
}

// Claudock's hook commands, by step: sh '<connect dir>/hook.sh' <step>
const steps = {}
for (const groups of Object.values(settings.hooks ?? {})) {
  for (const g of Array.isArray(groups) ? groups : []) {
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      const m = typeof h?.command === 'string' && /^sh '.*\/hook\.sh' (prompt|ask|question|tool|notify|stop|end)$/.exec(h.command)
      if (m) steps[m[1]] = h.command
    }
  }
}
if (!steps.prompt || !steps.ask || !steps.notify || !steps.stop || !steps.end) {
  console.error('the fixture is not connected: run npm run dev and press "Connect to Claude Code" first')
  process.exit(1)
}

// the three newest fixture sessions stand in for the running ones
const sessions = []
{
  const projects = path.join(dir, 'projects')
  const found = []
  for (const folder of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const fp = path.join(projects, folder)
    if (!fs.statSync(fp).isDirectory()) continue
    for (const f of fs.readdirSync(fp)) {
      if (!f.endsWith('.jsonl')) continue
      let cwd = null
      try {
        cwd = JSON.parse(fs.readFileSync(path.join(fp, f), 'utf8').split('\n')[0]).cwd ?? null
      } catch {
        /* no cwd */
      }
      found.push({ id: f.slice(0, -'.jsonl'.length), transcript: path.join(fp, f), cwd, mtime: fs.statSync(path.join(fp, f)).mtimeMs })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  // one per project folder, so the three read as three different sessions
  const seen = new Set()
  for (const s of found) {
    if (seen.has(s.cwd)) continue
    seen.add(s.cwd)
    sessions.push(s)
    if (sessions.length === 3) break
  }
}
if (sessions.length < 3) {
  console.error('the fixture has fewer than three sessions (run npm run fixture)')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function fire(step, s, extra = {}) {
  const input = JSON.stringify({ session_id: s.id, transcript_path: s.transcript, cwd: s.cwd, permission_mode: 'default', ...extra })
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', steps[step]], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('close', resolve)
  })
}
const prompt = (s) => fire('prompt', s, { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the flaky checkout test' })
const permission = async (s) => {
  await fire('ask', s, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } })
  await fire('notify', s, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })
}

const [a, b, c] = sessions
await Promise.all(sessions.map(prompt))
await sleep(1500)
if (group) {
  await Promise.all(sessions.map(permission))
} else {
  await fire('stop', c, { hook_event_name: 'Stop', stop_hook_active: false })
  await permission(a)
}
const name = (s) => path.basename(s.cwd ?? s.id)
console.log(group ? `${sessions.map(name).join(', ')}: waiting` : `${name(a)}: waiting · ${name(b)}: working · ${name(c)}: done`)
console.log('Ctrl+C ends the sessions')

let ending = false
async function end() {
  if (ending) return
  ending = true
  await Promise.all(sessions.map((s) => fire('end', s, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })))
  process.exit(0)
}
process.on('SIGINT', end)
process.on('SIGTERM', end)
// the working session keeps finishing tools, as Claude Code does, so its row shows what it did last
const TOOLS = ['Read', 'Grep', 'Edit', 'Bash', 'mcp__claude-in-chrome__navigate']
let next = 0
setInterval(() => {
  if (!group && !ending) void fire('tool', b, { hook_event_name: 'PostToolUse', tool_name: TOOLS[next++ % TOOLS.length], tool_input: {}, tool_response: {} })
}, 6000)
