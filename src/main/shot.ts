import type { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SCREENS, type ScreenId } from '@shared/nav'
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { connectDir } from './connect/folder'
import { GROUP_MS } from './connect/sessionModel'
import { postedAlerts } from './domains/sessions'
import { countHooks } from './domains/settings'
import { emit } from './ipcx'
import { configDir } from './paths'
import { setTheme } from './theme'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Screenshot mode (CLAUDOCK_SHOT=1, driven by scripts/shot.mjs): visits every screen in light then dark through the
 * normal `system:navigate` / `system:theme` events, waits until each is loaded and painted in that theme, saves
 * `<dir>/<theme>-<screen>.png` (plus `connect`, the Connect sheet, `connected`, the Overview card after connecting with one played status line run and three sessions played through the real hooks, which must post exactly one alert, `connected-hooks`, the Hooks screen then, where Claudock's hooks are one row and out of the counts, and `disconnect`, the confirm dialog that row's Disconnect… opens, which must leave settings.json byte for byte as it was, `palette`, `settings-json`, `mods-draft`, the Mods screen with the fixture's draft selected, and `share`, the Overview share dialog, and `card.png`, the card itself), prints renderer console errors as `CONSOLE_ERROR ...` and failed shots as
 * `SHOT_FAILED ...`, and exits 0 (clean) or 1 (errors).
 */
export async function runShots(win: BrowserWindow, opts: { dir: string; only: string[] }): Promise<void> {
  const errors: string[] = []
  win.webContents.on('console-message', (details) => {
    const d = details as unknown as { level: string; message: string; sourceId?: string; lineNumber?: number }
    if (d.level === 'error') {
      const line = `CONSOLE_ERROR ${d.message} (${d.sourceId ?? ''}:${d.lineNumber ?? ''})`
      errors.push(line)
      console.log(line)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    errors.push(`RENDERER_GONE ${details.reason}`)
    console.log(`RENDERER_GONE ${details.reason}`)
  })

  const js = <T,>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>

  /**
   * Wait until the screen is really ready: the requested theme is on <html> and in prefers-color-scheme, no API call
   * is pending, nothing shows a spinner or aria-busy, and all of that has held for 300 ms. Then wait for two frames so
   * the compositor has painted it. A cold first run can take seconds to answer, so fixed sleeps captured half-loaded
   * screens in the previous theme.
   */
  async function settle(theme: 'light' | 'dark', what: string): Promise<void> {
    const deadline = Date.now() + 30_000
    let quietSince = 0
    let last = ''
    while (Date.now() < deadline) {
      last = await js<string>(
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
        win.webContents.invalidate()
        await js(`new Promise((r) => { const t = setTimeout(r, 1000); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r() })) })`)
        return
      }
      await sleep(100)
    }
    throw new Error(`${theme}-${what} still not ready after 30 s: ${last}`)
  }

  /**
   * Capture and save `<theme>-<what>.png`. A pixel near the bottom-right corner must match the background the DOM has
   * there, so a stale frame from before the theme switch is retried instead of saved. Skipped under a translucent
   * overlay (the palette scrim or a modal dialog's backdrop), where the DOM colour is not what gets painted.
   */
  async function capture(theme: 'light' | 'dark', what: string): Promise<void> {
    const want = await js<number[]>(`(() => {
      if (document.querySelector('dialog[open]')) return [] // a modal's backdrop dims the page: the DOM colour is not what is painted
      for (let el = document.elementFromPoint(innerWidth - 4, innerHeight - 4); el; el = el.parentElement) {
        const [r, g, b, a = 1] = (getComputedStyle(el).backgroundColor.match(/[\\d.]+/g) ?? []).map(Number)
        if (a === 1) return [r, g, b]
        if (a > 0) return []
      }
      return []
    })()`)
    for (let attempt = 1; ; attempt++) {
      const img = await win.webContents.capturePage()
      const { width, height } = img.getSize()
      const scale = width / win.getContentSize()[0]
      const o = ((height - Math.ceil(4 * scale)) * width + width - Math.ceil(4 * scale)) * 4
      const bgra = img.toBitmap()
      const got = [bgra[o + 2], bgra[o + 1], bgra[o]]
      if (want.length !== 3 || want.every((c, i) => Math.abs(c - got[i]) <= 8)) {
        const file = path.join(opts.dir, `${theme}-${what}.png`)
        await fsp.writeFile(file, img.toPNG())
        console.log(`SHOT ${file} ${width}x${height}`)
        return
      }
      if (attempt === 20) throw new Error(`${theme}-${what}: captured pixel ${got.join(',')} never matched ${want.join(',')}`)
      console.log(`SHOT_RETRY ${theme}-${what}: stale frame (pixel ${got.join(',')}, page ${want.join(',')})`)
      win.webContents.invalidate()
      await sleep(250)
    }
  }

  /**
   * Settings -> JSON view with the completion popup and its docs card open: a half-typed key `"cle` goes into the
   * file (not saved), Ctrl+Space opens the popup, and the warning underline for the fixture's unknown key is waited
   * for. `restoreSettingsJson` puts the text back so the draft does not leak into the other shots.
   */
  const prepareSettingsJson = (): Promise<void> =>
    js(`(async () => {
      const wait = async (f, ms = 15000) => {
        const t = Date.now()
        while (Date.now() - t < ms) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) }
        throw new Error('settings-json: timed out waiting for ' + f)
      }
      const radio = await wait(() => [...document.querySelectorAll('[role=radiogroup][aria-label="View"] [role=radio]')].find((b) => b.textContent.trim() === 'JSON'))
      radio.click()
      const content = await wait(() => document.querySelector('.cm-content'))
      await wait(() => document.querySelector('.st-assist-source'))
      const tile = content.cmTile; const view = (tile && tile.root && tile.root.view) || (content.cmView && content.cmView.view)
      window.__shotJson = { view, text: view.state.doc.toString() }
      const at = 2
      view.dispatch({ changes: { from: at, insert: '  "cle": "",\\n' }, selection: { anchor: at + 6 } })
      view.focus()
      content.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true, cancelable: true }))
      await wait(() => document.querySelector('.cm-completionInfo'))
      await wait(() => document.querySelector('.cm-lintRange-warning'))
    })()`)
  const restoreSettingsJson = (): Promise<void> =>
    js(`(() => { const s = window.__shotJson; if (s) s.view.dispatch({ changes: { from: 0, to: s.view.state.doc.length, insert: s.text } }); window.__shotJson = undefined })()`)

  /** Overview -> "Share stats" -> the dialog with the card drawn (the canvas says so with data-ready). */
  const openShare = (): Promise<void> =>
    js(`(async () => {
      const wait = async (f, ms = 15000) => {
        const t = Date.now()
        while (Date.now() - t < ms) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) }
        throw new Error('share: timed out waiting for ' + f)
      }
      const button = await wait(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Share stats' && !b.disabled))
      button.click()
      await wait(() => document.querySelector('.share__canvas[data-ready="true"]'))
    })()`)
  /** Mods -> the fixture's draft (git-branch), to show Keep and the session it came from. */
  const selectDraft = (): Promise<void> =>
    js(`(async () => {
      const t = Date.now()
      while (Date.now() - t < 15000) {
        const row = [...document.querySelectorAll('.list-row button')].find((b) => b.textContent.includes('git-branch'))
        if (row) { row.click(); return }
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('mods-draft: the draft row never appeared')
    })()`)
  const closeShare = (): Promise<unknown> => js(`document.querySelector('.share [aria-label="Close"]')?.click()`)
  /** The card as the dialog sends it (the same canvas), for review. It does not depend on the app theme. */
  async function saveCard(): Promise<void> {
    const url = await js<string>(`document.querySelector('.share__canvas').toDataURL('image/png')`)
    const file = path.join(opts.dir, 'card.png')
    await fsp.writeFile(file, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'))
    console.log(`SHOT ${file} 2400x1350`)
  }

  /** Click the first enabled button whose text is `label`, waiting up to 15 s for it. */
  const click = (label: string, scope = 'document'): Promise<void> =>
    js(`(async () => {
      const t = Date.now()
      while (Date.now() - t < 15000) {
        const b = [...((${scope})?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled)
        if (b) { b.click(); return }
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('timed out waiting for the button ' + ${JSON.stringify(label)})
    })()`)
  const waitFor = (cond: string, what: string): Promise<void> =>
    js(`(async () => {
      const t = Date.now()
      while (Date.now() - t < 15000) { if (${cond}) return; await new Promise((r) => setTimeout(r, 100)) }
      throw new Error('timed out waiting for ' + ${JSON.stringify(what)})
    })()`)

  /** Play Claude Code: run the configured statusLine command once with a status JSON that carries rate_limits. */
  async function playStatusLine(): Promise<void> {
    const settings = JSON.parse(await fsp.readFile(path.join(configDir(), 'settings.json'), 'utf8')) as { statusLine?: { command?: string } }
    const command = settings.statusLine?.command
    if (!command) throw new Error('limits: no statusLine command after turning on')
    const now = Date.now()
    const monday = new Date(now)
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7))
    monday.setHours(9, 0, 0, 0)
    const input = JSON.stringify({
      session_id: 'shot',
      model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
      workspace: { current_dir: '/tmp/"rate_limits": {}', project_dir: '/tmp' },
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: Math.floor((now + 148 * 60_000) / 1000) },
        seven_day: { used_percentage: 61.4, resets_at: Math.floor(monday.getTime() / 1000) }
      }
    })
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
      let text = ''
      child.stdout.on('data', (b: Buffer) => (text += b.toString()))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolve(text) : reject(new Error(`limits: status line exited ${code}`))))
      child.stdin.end(input)
    })
    // the fixture's own status line must still run, with its output passed through
    if (out.trim() !== 'fixture status') throw new Error(`limits: status line printed ${JSON.stringify(out)}, not the fixture's own line`)
  }

  /** Play Claude Code firing the session hooks: run `command` once with `input` on stdin, from this process (alive, so the session stays). */
  function playHook(command: string, input: object): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (b: Buffer) => (out += b.toString()))
      child.on('error', reject)
      child.on('close', (code) => (code === 0 && out === '' ? resolve() : reject(new Error(`connect: hook exited ${code} with output ${JSON.stringify(out)}`))))
      child.stdin.end(JSON.stringify(input))
    })
  }

  /** The three newest fixture sessions, one per project folder, standing in for running ones. */
  async function fixtureSessions(): Promise<{ id: string; cwd: string }[]> {
    const root = path.join(configDir(), 'projects')
    const found: { id: string; cwd: string; mtime: number }[] = []
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

  /**
   * Overview -> Connect to Claude Code -> the sheet (shot) -> Connect -> one status line run and three sessions through
   * the real hooks (one ends up waiting on a permission prompt, one working, one done) -> exactly one alert -> the card
   * (shot) -> Hooks: one Claudock row, the list and sidebar counts as before (shot) -> its Disconnect… -> the card's
   * dialog, with the Overview tile as before (shot) -> settings.json byte for byte as before, and the connect folder
   * empty of scripts.
   */
  async function connectFlow(theme: 'light' | 'dark'): Promise<void> {
    const file = path.join(configDir(), 'settings.json')
    const before = await fsp.readFile(file)
    await click('Connect to Claude Code')
    await waitFor(`document.querySelector('dialog[open] .diff') && document.querySelectorAll('dialog[open] input[type=checkbox]:checked').length === 2`, 'the Connect sheet')
    await shoot(theme, 'connect')
    await click('Connect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Disconnect')`, 'the connection')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    await playStatusLine()
    const settings = JSON.parse(await fsp.readFile(file, 'utf8')) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> }
    const steps = new Map<string, string>()
    for (const groups of Object.values(settings.hooks ?? {})) {
      for (const g of groups) for (const h of g.hooks ?? []) {
        const m = /hook\.sh' (\w+)$/.exec(h.command ?? '')
        if (m) steps.set(m[1], h.command as string)
      }
    }
    for (const step of ['prompt', 'ask', 'notify', 'stop', 'question', 'tool', 'end']) if (!steps.has(step)) throw new Error(`connect: no ${step} hook in settings.json`)
    const [a, b, c] = await fixtureSessions()
    const alerts = postedAlerts().length
    const input = (x: { id: string; cwd: string }, extra: object): object => ({ session_id: x.id, cwd: x.cwd, transcript_path: '', permission_mode: 'default', ...extra })
    for (const x of [a, b, c]) await playHook(steps.get('prompt') as string, input(x, { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the flaky checkout test' }))
    await waitFor(`document.querySelectorAll('.cc__row--working').length === 3`, 'three working sessions')
    await playHook(steps.get('stop') as string, input(c, { hook_event_name: 'Stop', stop_hook_active: false }))
    await playHook(steps.get('ask') as string, input(a, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } }))
    // a tool from another agent finishing leaves the wait alone
    await playHook(steps.get('tool') as string, input(a, { hook_event_name: 'PostToolUse', tool_name: 'Read', agent_id: 'sub-1', tool_response: {} }))
    await playHook(steps.get('notify') as string, input(a, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }))
    // idle_prompt arrives a minute after a finished turn: it must not count as waiting
    await playHook(steps.get('notify') as string, input(c, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }))
    await waitFor(
      `document.querySelectorAll('.cc__row--waiting').length === 1 && document.querySelectorAll('.cc__row--done').length === 1 && [...document.querySelectorAll('.lim__top b')].map((b) => b.textContent).join(' ') === '42% 61%'`,
      'one waiting, one working, one done session and the limits'
    )
    // the alert goes out once the grouping window closes
    await sleep(GROUP_MS + 1000)
    const posted = postedAlerts().slice(alerts)
    const want = `${path.basename(a.cwd)} is waiting for you`
    if (posted.length !== 1 || posted[0] !== want) throw new Error(`connect: expected one alert "${want}", got ${JSON.stringify(posted)}`)
    await shoot(theme, 'connected')
    const own = String(countHooks((JSON.parse(before.toString('utf8')) as { hooks?: unknown }).hooks).commands)
    emit('system:navigate', { screen: 'hooks' })
    await waitFor(
      `document.querySelector('.list-row--selected')?.textContent.includes('Connect to Claude Code') && document.querySelector('.list-pane__count')?.textContent === ${JSON.stringify(own)} && [...document.querySelectorAll('.nav-item')].find((b) => b.textContent.includes('Hooks'))?.querySelector('.nav-item__count')?.textContent === ${JSON.stringify(own)}`,
      'the Claudock row on Hooks, with the counts as before connecting'
    )
    await shoot(theme, 'connected-hooks')
    await click('Disconnect…')
    await waitFor(
      `document.querySelector('dialog[open] .diff') && document.querySelector('.ov__tile[aria-label^="Hooks: ${own}."]')`,
      'the Disconnect dialog, with the Overview tile as before connecting'
    )
    await shoot(theme, 'disconnect')
    await click('Disconnect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Connect to Claude Code')`, 'the disconnect')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    if (!before.equals(await fsp.readFile(file))) throw new Error('connect: settings.json is not byte for byte what it was before connecting')
    // left behind on purpose: hook.sh as a no-op and statusline.sh, for sessions that still run them until Claude Code reloads
    const left = (await fsp.readdir(connectDir()).catch(() => [] as string[])).filter((n) => n !== 'hook.sh' && n !== 'statusline.sh')
    if (left.length) throw new Error(`connect: the connect folder still holds ${left.join(', ')}`)
    if (!(await fsp.readFile(path.join(connectDir(), 'hook.sh'), 'utf8')).includes('exit 0\n')) throw new Error('connect: hook.sh was not made a no-op')
  }

  const fail = (e: unknown): void => {
    errors.push(`SHOT_FAILED ${(e as Error).message}`)
    console.log(`SHOT_FAILED ${(e as Error).message}`)
  }
  const shoot = (theme: 'light' | 'dark', what: string): Promise<void> => settle(theme, what).then(() => capture(theme, what)).catch(fail)

  await fsp.mkdir(opts.dir, { recursive: true })
  const screens = SCREENS.filter((s) => opts.only.length === 0 || opts.only.includes(s.id))

  try {
    // wait for the shell
    const deadline = Date.now() + 30_000
    while (!(await js<boolean>(`!!document.querySelector('[data-app-ready]')`))) {
      if (Date.now() > deadline) throw new Error('app not ready after 30 s')
      await sleep(100)
    }

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(theme, false)
      for (const s of screens) {
        emit('system:navigate', { screen: s.id as ScreenId })
        await sleep(150)
        await shoot(theme, s.id)
      }
      if (opts.only.length === 0 || opts.only.includes('settings-json')) {
        emit('system:navigate', { screen: 'settings' })
        await sleep(150)
        await prepareSettingsJson().then(() => shoot(theme, 'settings-json'), fail)
        await restoreSettingsJson().catch(() => undefined)
        // leave Settings so it remounts in the Form view, then return to where the loop ended (the start screen when it
        // visited none): the palette shot below sits over that screen
        emit('system:navigate', { screen: 'overview' })
        await sleep(150)
        emit('system:navigate', { screen: (screens[screens.length - 1]?.id ?? 'overview') as ScreenId })
        await sleep(150)
      }
      if (process.platform !== 'win32' && (opts.only.length === 0 || opts.only.includes('connect'))) {
        emit('system:navigate', { screen: 'overview' })
        await sleep(150)
        await connectFlow(theme).catch(fail)
      }
      if (opts.only.length === 0 || opts.only.includes('mods') || opts.only.includes('mods-draft')) {
        emit('system:navigate', { screen: 'mods' })
        await sleep(150)
        await selectDraft().then(() => shoot(theme, 'mods-draft'), fail)
      }
      if (opts.only.length === 0 || opts.only.includes('palette')) {
        emit('system:openPalette', null)
        await sleep(150)
        await shoot(theme, 'palette')
        await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`)
        await sleep(200)
      }
      if (opts.only.length === 0 || opts.only.includes('share')) {
        emit('system:navigate', { screen: 'overview' })
        await sleep(150)
        await openShare().then(() => shoot(theme, 'share'), fail)
        if (theme === 'light') await saveCard().catch(fail)
        await closeShare()
        await sleep(200)
      }
    }
  } catch (e) {
    fail(e)
  }

  console.log(errors.length ? `SHOT_DONE with ${errors.length} error(s)` : 'SHOT_DONE ok')
  app.exit(errors.length ? 1 : 0)
}
