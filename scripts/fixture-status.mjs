#!/usr/bin/env node
/**
 * Plays Claude Code calling the status line, on the fixture: runs `statusLine.command` from the fixture's settings.json
 * and writes the status JSON (with sample `rate_limits`) to its stdin. Run `npm run fixture` first.
 *   npm run fixture:status [-- --five 80] [-- --week 90] [-- --no-limits] [-- --expired]
 * Refuses any config folder that is not .fixture/claude, so the real ~/.claude is never involved.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(root, '.fixture', 'claude'))
if (path.basename(dir) !== 'claude' || path.basename(path.dirname(dir)) !== '.fixture') {
  console.error(`refusing ${dir}: the status line only runs on a .fixture/claude folder`)
  process.exit(1)
}

const args = process.argv.slice(2)
const num = (flag, fallback) => {
  const i = args.indexOf(flag)
  if (i < 0) return fallback
  const v = Number(args[i + 1])
  if (!Number.isFinite(v)) {
    console.error(`${flag} needs a number`)
    process.exit(1)
  }
  return v
}

let command
try {
  command = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).statusLine?.command
} catch {
  console.error(`cannot read ${path.join(dir, 'settings.json')} (run npm run fixture first)`)
  process.exit(1)
}
if (!command) {
  console.error('no statusLine in the fixture settings')
  process.exit(1)
}

// the newest fixture transcript stands in for the live session
let sessionId = crypto.randomUUID()
let transcriptPath = ''
let cwd = root
{
  let newest = 0
  const projects = path.join(dir, 'projects')
  for (const folder of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const fp = path.join(projects, folder)
    if (!fs.statSync(fp).isDirectory()) continue
    for (const f of fs.readdirSync(fp)) {
      if (!f.endsWith('.jsonl')) continue
      const m = fs.statSync(path.join(fp, f)).mtimeMs
      if (m > newest) {
        newest = m
        transcriptPath = path.join(fp, f)
        sessionId = f.slice(0, -'.jsonl'.length)
      }
    }
  }
  try {
    cwd = JSON.parse(fs.readFileSync(transcriptPath, 'utf8').split('\n')[0]).cwd || cwd
  } catch {
    /* keep the repo root */
  }
}

const now = Date.now()
const nextMonday = new Date(now)
nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7))
nextMonday.setHours(9, 0, 0, 0)

const status = {
  session_id: sessionId,
  transcript_path: transcriptPath,
  cwd,
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  workspace: { current_dir: cwd, project_dir: cwd },
  version: '2.1.300',
  cost: { total_cost_usd: 3.42, total_duration_ms: 1_845_000, total_api_duration_ms: 612_000, total_lines_added: 214, total_lines_removed: 57 },
  context_window: { total_input_tokens: 84_210, total_output_tokens: 19_640, context_window_size: 200_000, used_percentage: 38, remaining_percentage: 62 }
}
if (!args.includes('--no-limits')) {
  status.rate_limits = {
    five_hour: { used_percentage: num('--five', 42), resets_at: Math.floor((args.includes('--expired') ? now - 10 * 60_000 : now + (2 * 60 + 28) * 60_000) / 1000) },
    seven_day: { used_percentage: num('--week', 61), resets_at: Math.floor(nextMonday.getTime() / 1000) }
  }
}

// commands written as $HOME/.claude/... or ~/.claude/... should find the fixture, not the real folder: a throwaway HOME beside it
const home = path.join(path.dirname(dir), 'home')
fs.mkdirSync(home, { recursive: true })
fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true })
fs.symlinkSync(dir, path.join(home, '.claude'))

const child = spawn('/bin/sh', ['-c', command], { cwd: root, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: dir }, stdio: ['pipe', 'inherit', 'inherit'] })
child.stdin.on('error', () => {})
child.stdin.end(JSON.stringify(status))
child.on('close', (code) => {
  console.error(`status line ran (exit ${code ?? 1})`)
  process.exit(code ?? 1)
})
