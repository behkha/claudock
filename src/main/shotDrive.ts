import type { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { configDir } from './paths'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export type Session = { id: string; cwd: string }

/** The status JSON Claude Code sends the status line, with `rate_limits` (the fields Claudock reads). */
export function statusInput(fiveHour: number, dir = '/tmp/"rate_limits": {}', week = 61.4): string {
  const now = Date.now()
  const monday = new Date(now)
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7))
  monday.setHours(9, 0, 0, 0)
  return JSON.stringify({
    session_id: 'shot',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: dir, project_dir: dir },
    rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: Math.floor((now + 148 * 60_000) / 1000) },
      seven_day: { used_percentage: week, resets_at: Math.floor(monday.getTime() / 1000) }
    }
  })
}

/** Run `command` in a shell with `input` on stdin; resolves with its stdout, rejects on a non-zero exit. */
function run(command: string, input: string, what: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (b: Buffer) => (text += b.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`${what} exited ${code}`))))
    child.stdin.end(input)
  })
}

/**
 * What screenshot mode (src/main/shot.ts) and recording mode (src/main/record.ts) drive the app with: waiting for a
 * screen to settle, clicking buttons by their text, and playing Claude Code (the status line and the session hooks)
 * on the fixture.
 */
export function driver(win: BrowserWindow) {
  const jsOn = <T,>(w: BrowserWindow, code: string): Promise<T> => w.webContents.executeJavaScript(code) as Promise<T>
  const js = <T,>(code: string): Promise<T> => jsOn<T>(win, code)

  /**
   * Wait until the screen is really ready: the requested theme is on <html> and in prefers-color-scheme, no API call
   * is pending, nothing shows a spinner or aria-busy, and all of that has held for 300 ms. Then wait for two frames so
   * the compositor has painted it. A cold first run can take seconds to answer, so fixed sleeps captured half-loaded
   * screens in the previous theme.
   */
  async function settle(theme: 'light' | 'dark', what: string, w: BrowserWindow = win): Promise<void> {
    const deadline = Date.now() + 30_000
    let quietSince = 0
    let last = ''
    while (Date.now() < deadline) {
      last = await jsOn<string>(
        w,
        `JSON.stringify({ theme: document.documentElement.dataset.theme, dark: matchMedia('(prefers-color-scheme: dark)').matches, ` +
          `pending: window.__claudockPending ?? 0, busy: document.querySelectorAll('.spinner, [aria-busy="true"]').length })`
      )
      const st = JSON.parse(last) as { theme: string; dark: boolean; pending: number; busy: number }
      const ready = st.theme === theme && st.dark === (theme === 'dark') && st.pending === 0 && st.busy === 0
      if (!ready) quietSince = 0
      else if (quietSince === 0) quietSince = Date.now()
      else if (Date.now() - quietSince >= 300) {
        // A hidden window can stop drawing (no vsync while the display sleeps or the machine is busy), and capturePage
        // then returns its first frame. Force a repaint and wait two frames; the timeout keeps a stalled rAF from hanging.
        w.webContents.invalidate()
        await jsOn(w, `new Promise((r) => { const t = setTimeout(r, 1000); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r() })) })`)
        return
      }
      await sleep(100)
    }
    throw new Error(`${theme}-${what} still not ready after 30 s: ${last}`)
  }

  /** Click the first enabled button whose text is `label`, waiting up to 15 s for it. */
  const click = (label: string, scope = 'document', w: BrowserWindow = win): Promise<void> =>
    jsOn(
      w,
      `(async () => {
      const t = Date.now()
      while (Date.now() - t < 15000) {
        const b = [...((${scope})?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled)
        if (b) { b.click(); return }
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('timed out waiting for the button ' + ${JSON.stringify(label)})
    })()`
    )
  const waitFor = (cond: string, what: string, w: BrowserWindow = win): Promise<void> =>
    jsOn(
      w,
      `(async () => {
      const t = Date.now()
      while (Date.now() - t < 15000) { if (${cond}) return; await new Promise((r) => setTimeout(r, 100)) }
      throw new Error('timed out waiting for ' + ${JSON.stringify(what)})
    })()`
    )

  /**
   * Play Claude Code: run the configured statusLine command once with a status JSON that carries rate_limits. The
   * fixture's own status line must print exactly what it prints without Claudock's step in front; that line is returned.
   */
  async function playStatusLine(fiveHour = 42, dir?: string, week?: number): Promise<string> {
    const settings = JSON.parse(await fsp.readFile(path.join(configDir(), 'settings.json'), 'utf8')) as { statusLine?: { command?: string } }
    const command = settings.statusLine?.command
    if (!command) throw new Error('limits: no statusLine command after turning on')
    const input = statusInput(fiveHour, dir, week)
    const out = await run(command, input, 'limits: status line')
    // the second profile has no status line of its own, so there's nothing to compare
    const script = path.join(configDir(), 'statusline.sh')
    if (await fsp.access(script).then(() => true, () => false)) {
      const own = await run(`bash ${JSON.stringify(script)}`, input, "limits: the fixture's status line")
      if (out !== own) throw new Error(`limits: status line printed ${JSON.stringify(out)}, not the fixture's own ${JSON.stringify(own)}`)
    }
    return out.trim()
  }

  /** Play Claude Code firing the session hooks: run `command` once with `input` on stdin, from this process (alive, so the session stays). */
  async function playHook(command: string, input: object): Promise<void> {
    const out = await run(command, JSON.stringify(input), 'connect: hook')
    if (out !== '') throw new Error(`connect: hook printed ${JSON.stringify(out)}`)
  }

  /** The three newest fixture sessions, one per project folder, standing in for running ones. */
  async function fixtureSessions(): Promise<Session[]> {
    const root = path.join(configDir(), 'projects')
    const found: (Session & { mtime: number })[] = []
    for (const folder of await fsp.readdir(root)) {
      const dir = path.join(root, folder)
      for (const f of await fsp.readdir(dir).catch(() => [] as string[])) {
        if (!f.endsWith('.jsonl')) continue
        const text = await fsp.readFile(path.join(dir, f), 'utf8')
        const cwd = (JSON.parse(text.split('\n')[0]) as { cwd?: string }).cwd
        if (cwd) found.push({ id: f.slice(0, -6), cwd, mtime: (await fsp.stat(path.join(dir, f))).mtimeMs })
      }
    }
    const seen = new Set<string>()
    return found
      .sort((a, b) => b.mtime - a.mtime)
      .filter((x) => !seen.has(x.cwd) && seen.add(x.cwd))
      .slice(0, 3)
  }

  /** Claudock's hook commands in settings.json, by step. */
  async function hookSteps(): Promise<Map<string, string>> {
    const settings = JSON.parse(await fsp.readFile(path.join(configDir(), 'settings.json'), 'utf8')) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> }
    const steps = new Map<string, string>()
    for (const groups of Object.values(settings.hooks ?? {})) {
      for (const g of groups) for (const h of g.hooks ?? []) {
        const m = /hook\.sh' (\w+)$/.exec(h.command ?? '')
        if (m) steps.set(m[1], h.command as string)
      }
    }
    for (const step of ['prompt', 'ask', 'notify', 'stop', 'question', 'tool', 'end']) if (!steps.has(step)) throw new Error(`connect: no ${step} hook in settings.json`)
    return steps
  }

  const hookInput = (x: Session, extra: object): object => ({ session_id: x.id, cwd: x.cwd, transcript_path: '', permission_mode: 'default', ...extra })

  /** Three sessions start a turn through the real hooks; all three show as working. */
  async function startSessions(steps: Map<string, string>): Promise<Session[]> {
    const sessions = await fixtureSessions()
    for (const x of sessions) await playHook(steps.get('prompt') as string, hookInput(x, { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the flaky checkout test' }))
    await waitFor(`document.querySelectorAll('.cc__row--working').length === 3`, 'three working sessions')
    return sessions
  }

  /** The started sessions move on: the first ends up waiting on a Bash permission prompt, the second working, the third done. */
  async function advanceSessions(steps: Map<string, string>, [a, b, c]: Session[]): Promise<void> {
    await playHook(steps.get('stop') as string, hookInput(c, { hook_event_name: 'Stop', stop_hook_active: false }))
    await playHook(steps.get('ask') as string, hookInput(a, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    // a tool from another agent finishing leaves the wait alone
    await playHook(steps.get('tool') as string, hookInput(a, { hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'sub-1', tool_response: {} }))
    await playHook(steps.get('notify') as string, hookInput(a, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }))
    // idle_prompt arrives a minute after a finished turn: it must not count as waiting
    await playHook(steps.get('notify') as string, hookInput(c, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }))
    // the working session finishes a tool: its row says what it did last
    await playHook(steps.get('tool') as string, hookInput(b, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_response: {} }))
    await waitFor(`document.querySelector('.cc__row--working .cc__what')?.textContent.startsWith('Edited a file')`, "the working session's last tool")
  }

  /** Three sessions through the real hooks: the first ends up waiting on a Bash permission prompt, the second working, the third done. */
  async function playSessions(steps: Map<string, string>): Promise<Session[]> {
    const sessions = await startSessions(steps)
    await advanceSessions(steps, sessions)
    return sessions
  }

  return { js, jsOn, settle, click, waitFor, playStatusLine, playHook, fixtureSessions, hookSteps, startSessions, advanceSessions, playSessions }
}
