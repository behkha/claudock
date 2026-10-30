import type { BrowserWindow, WebContents } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app, clipboard } from 'electron'
import { postedAlertTexts } from './alerts'
import { GROUP_MS } from './connect/sessionModel'
import { list as archiveList, sweepNow } from './domains/archive'
import { setAlertPrefs } from './domains/sessions'
import { emit } from './ipcx'
import { glanceForShots, popoverForShots, resetLimitAlertsForShots } from './menubar'
import { configDir, snapshotsDir } from './paths'
import { setTheme } from './theme'
import { driver, sleep } from './shotDrive'

/** Takes play at an eighth of real speed, so a capture (about 10 ms) never misses a frame; frames are kept at 60 fps. */
const RATE = 1 / 8
const FPS = 60
/** The window's content size: 2560×1440 on a 2× display, 1920×1080 for the screenshots once scaled down. */
const SIZE = { width: 1280, height: 720 }
/** The weekly % fed to the status line: under the 5-hour one, so the menu bar (which shows the higher) reads 42%. */
const WEEK = 28
/** The first prompt of the old session the Sessions take finds: no other transcript on the fixture has its words. */
const OLD_PROMPT = 'Why did the nightly invoice job charge twice in July?'
const OLD_ID = '7e1f0c52-3a94-4d6b-8f21-c0de5e551011'

type Box = { x: number; y: number; w: number; h: number }
type Mark = { t: number; kind: 'click' | 'cue'; label: string; box?: Box }

/**
 * Slows the app down for a take: CSS animations and transitions through DevTools' Animation domain, and the page's JS
 * clock (performance.now, requestAnimationFrame, setTimeout and setInterval) through a small patch, which also ticks
 * requestAnimationFrame from a timer, since a hidden window gets no vsync. `now()` is the
 * same slowed clock in this process, so a frame captured at real time r is stamped with when it happens at full speed.
 */
class SlowMo {
  private rate = 1
  private r0 = Date.now()
  private v0 = 0
  private readonly targets = new Set<WebContents>()

  now(real = Date.now()): number {
    return this.v0 + (real - this.r0) * this.rate
  }

  /** Wait `ms` of slowed time. */
  hold(ms: number): Promise<void> {
    return sleep(ms / this.rate)
  }

  async add(wc: WebContents): Promise<void> {
    if (this.targets.has(wc)) return
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Animation.enable')
    await wc.executeJavaScript(`(() => {
      if (window.__slow) return
      const real = performance.now.bind(performance), st = setTimeout.bind(window), si = setInterval.bind(window)
      const s = { rate: 1, r0: real(), v0: real() }
      const v = (r) => s.v0 + (r - s.r0) * s.rate
      window.__slow = (rate) => { const r = real(); s.v0 = v(r); s.r0 = r; s.rate = rate }
      performance.now = () => v(real())
      // a hidden window gets no vsync, so requestAnimationFrame would stall: tick it from a timer instead
      window.requestAnimationFrame = (cb) => st(() => cb(v(real())), 16)
      window.cancelAnimationFrame = (id) => clearTimeout(id)
      window.setTimeout = (fn, ms, ...a) => st(fn, (ms || 0) / s.rate, ...a)
      window.setInterval = (fn, ms, ...a) => si(fn, (ms || 0) / s.rate, ...a)
    })()`)
    this.targets.add(wc)
    await this.apply(wc)
  }

  async set(rate: number): Promise<void> {
    const r = Date.now()
    this.v0 = this.now(r)
    this.r0 = r
    this.rate = rate
    await Promise.all([...this.targets].map((wc) => this.apply(wc)))
  }

  private async apply(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) return void this.targets.delete(wc)
    await wc.debugger.sendCommand('Animation.setPlaybackRate', { playbackRate: this.rate })
    await wc.executeJavaScript(`window.__slow(${this.rate})`)
  }
}

/**
 * Recording mode (CLAUDOCK_SHOT=1 and CLAUDOCK_RECORD=1, driven by scripts/record.mjs): plays the launch film's takes
 * on the fixture, in light then dark, and saves each as `<dir>/<theme>-<take>/` (JPEG frames, and `take.json` with each
 * frame's time and the clicks and cues in it, in CSS px of a 1280×720 window), the six screenshots as
 * `<dir>/stills/<theme>-<name>.png`, and what the film draws around the app (the status line's output, the menu bar
 * title, the alerts) in `<dir>/strings.json`. Takes: `reveal` (the reveal fills in, Connect), `today` (one status line
 * run, three sessions, one starts waiting), `popover` (the menu bar popover, then its settings: Limit reaches goes from
 * Off to 80%), `limit` (the 5-hour limit crosses 80%, then the weekly one, one alert each), `profiles` (the title bar
 * menu with both profiles, a switch to Work), `profiles-pop` (the popover with both profiles), `skills` (a skill off,
 * settings.json, on again), `context` (the skills ranked, one off and the total drops, on again), `restore`
 * (settings.json broken, yesterday's snapshot restored), `sessions` (a session Claude Code deleted found by a word of
 * its first prompt, opened at that line, its resume command copied), `share` (the week's card, a week back, the cursor
 * on Post on X). Exits 0 (clean) or 1.
 */
export async function runRecord(win: BrowserWindow, opts: { dir: string; only: string[] }): Promise<void> {
  const errors: string[] = []
  const fail = (e: unknown): void => {
    errors.push((e as Error).message)
    console.log(`RECORD_FAILED ${(e as Error).message}`)
  }
  win.webContents.on('console-message', (details) => {
    const d = details as unknown as { level: string; message: string }
    if (d.level === 'error') fail(new Error(`console: ${d.message}`))
  })

  const { js, jsOn, settle, click, waitFor, playStatusLine, hookSteps, startSessions, advanceSessions } = driver(win)
  const slow = new SlowMo()
  // the menu bar clock the film draws: the sessions on screen are dated from now
  const strings: Record<string, unknown> = { clock: new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(',', ' ') }
  const settingsFile = path.join(configDir(), 'settings.json')
  // the Sessions take copies a resume command: the clipboard goes back to what it held
  const clipboardBefore = await clipboard.readText()

  win.setContentSize(SIZE.width, SIZE.height)
  await slow.add(win.webContents)

  /** Save the window as it is now, full size, as `stills/<theme>-<name>.png`. */
  async function still(theme: string, name: string, w: BrowserWindow = win): Promise<void> {
    const img = await w.webContents.capturePage()
    const file = path.join(opts.dir, 'stills', `${theme}-${name}.png`)
    await fsp.mkdir(path.dirname(file), { recursive: true })
    await fsp.writeFile(file, img.toPNG())
    console.log(`STILL ${file} ${img.getSize().width}x${img.getSize().height}`)
  }

  /**
   * Record one take of window `w`: frames are captured while `script` runs, each stamped with its slowed time since the
   * take began, at most 60 per second of it. `script` clicks through `ctx`, so each click's target and time are kept for
   * the film's cursor.
   */
  async function take(theme: string, name: string, w: BrowserWindow, script: (ctx: TakeCtx) => Promise<void>): Promise<void> {
    const dir = path.join(opts.dir, `${theme}-${name}`)
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.mkdir(dir, { recursive: true })
    const frames: { f: string; t: number }[] = []
    const marks: Mark[] = []
    const writes: Promise<void>[] = []
    await slow.add(w.webContents)
    await slow.set(RATE)
    const start = slow.now()
    const at = (): number => Math.round((slow.now() - start) * 10) / 10
    let stop = false
    const loop = (async () => {
      let next = 0
      while (!stop) {
        const wait = (next - (slow.now() - start)) / RATE
        if (wait > 0) await sleep(wait)
        const before = Date.now()
        const img = await w.webContents.capturePage()
        const t = Math.round((slow.now((before + Date.now()) / 2) - start) * 10) / 10
        const f = `f${String(frames.length).padStart(5, '0')}.jpg`
        frames.push({ f, t })
        writes.push(fsp.writeFile(path.join(dir, f), img.toJPEG(92)))
        next = t + 1000 / FPS
      }
    })()

    const boxOf = (el: string, label: string, on: BrowserWindow): Promise<Box> =>
      jsOn<Box>(
        on,
        `(async () => {
        const t = Date.now()
        while (Date.now() - t < 15000) {
          const el = ${el}
          if (el) { el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
          await new Promise((r) => setTimeout(r, 100))
        }
        throw new Error('timed out waiting for ' + ${JSON.stringify(label)})
      })()`
      )
    const ctx: TakeCtx = {
      box: (el, label) => boxOf(el, label, w),
      hold: (ms) => slow.hold(ms),
      cue: (label, box) => void marks.push({ t: at(), kind: 'cue', label, ...(box ? { box } : {}) }),
      clickEl: async (el, label, on = w) => {
        const box = await boxOf(el, label, on)
        marks.push({ t: at(), kind: 'click', label, box })
        await jsOn(on, `(${el}).click()`)
      },
      clickButton: async (label, scope = 'document', on = w) => {
        const el = `[...((${scope})?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled)`
        await ctx.clickEl(el, label, on)
      },
      still: (name2) => still(theme, name2, w)
    }
    try {
      await script(ctx)
    } finally {
      stop = true
      await loop
      await Promise.all(writes)
      await slow.set(1)
    }
    const [cw, ch] = w.getContentSize()
    await fsp.writeFile(path.join(dir, 'take.json'), JSON.stringify({ name, theme, size: { width: cw, height: ch }, frames, marks }, null, 1))
    console.log(`TAKE ${dir} ${frames.length} frames, ${(frames.at(-1)?.t ?? 0) / 1000} s`)
  }

  const closeToasts = (): Promise<unknown> => js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
  const go = async (screen: 'today' | 'skills' | 'settings' | 'backups' | 'context' | 'archive', theme: 'light' | 'dark'): Promise<void> => {
    emit('system:navigate', { screen })
    await sleep(150)
    await settle(theme, screen)
  }

  /** Connect the open profile from the Today card, off camera. */
  async function connect(): Promise<void> {
    await click('Connect to Claude Code')
    await waitFor(`document.querySelector('dialog[open] .diff')`, 'the Connect sheet')
    await click('Connect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('.lim button')].some((b) => b.textContent.trim() === 'Disconnect')`, 'the connection')
    await closeToasts()
  }

  const openProfile = async (name: string): Promise<void> => {
    await js(`document.querySelector('.titlebar__profile').click()`)
    await waitFor(`document.querySelectorAll('.profile-row').length === 2`, 'the profile menu')
    await js(`[...document.querySelectorAll('.profile-row')].find((r) => r.textContent.includes(${JSON.stringify(name)})).click()`)
    await waitFor(`document.querySelector('.titlebar__profile-name')?.textContent === ${JSON.stringify(name)} && document.querySelector('.today')`, `${name} open on Today`)
  }

  /**
   * Off camera, an old session for the Sessions take, which Claude Code has since deleted: the fixture's oldest
   * transcript under a new id and a first prompt no other transcript has, archived by the sweep, then its live copy gone.
   */
  async function seedDeletedSession(): Promise<string> {
    if (process.env.CLAUDOCK_READONLY === '1') throw new Error('record: never on a real config')
    await sweepNow()
    const rows = (await archiveList()).sessions.filter((r) => r.title && r.messages > 1 && r.id !== OLD_ID)
    const from = rows.at(-1)
    if (!from) throw new Error('record: no session on the fixture to copy')
    const dir = path.join(configDir(), 'projects', from.projectId)
    const text = await fsp.readFile(path.join(dir, `${from.id}.jsonl`), 'utf8')
    const live = path.join(dir, `${OLD_ID}.jsonl`)
    await fsp.writeFile(live, text.replaceAll(from.id, OLD_ID).replaceAll(from.title, OLD_PROMPT))
    const when = new Date(Date.now() - 110 * 86_400_000)
    await fsp.utimes(live, when, when)
    await sweepNow()
    await fsp.rm(live)
    await fsp.rm(path.join(dir, OLD_ID), { recursive: true, force: true })
    await sweepNow()
    const row = (await archiveList()).sessions.find((r) => r.id === OLD_ID)
    if (!row?.archived || row.title !== OLD_PROMPT) throw new Error(`record: the old session is ${JSON.stringify(row)}`)
    return live
  }

  /** Disconnect from the Today card, then put settings.json back as it was before the takes, for the next theme. */
  async function disconnect(before: Buffer): Promise<void> {
    await go('today', (await js<string>('document.documentElement.dataset.theme')) as 'light' | 'dark')
    await click('Disconnect')
    await waitFor(`document.querySelector('dialog[open] .diff')`, 'the Disconnect dialog')
    await click('Disconnect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Connect to Claude Code')`, 'the disconnect')
    await closeToasts()
    await fsp.writeFile(settingsFile, before)
  }

  try {
    const deadline = Date.now() + 30_000
    while (!(await js<boolean>(`!!document.querySelector('[data-app-ready]')`))) {
      if (Date.now() > deadline) throw new Error('app not ready after 30 s')
      await sleep(100)
    }

    // `--only light` or `--only dark` records one theme
    const themes = (['light', 'dark'] as const).filter((t) => opts.only.length === 0 || opts.only.includes(t))
    for (const theme of themes) {
      // each theme starts with no snapshots, so the second one's Backups list doesn't hold the first one's changes
      await fsp.rm(snapshotsDir(), { recursive: true, force: true })
      await setAlertPrefs({ limitPercent: null })
      resetLimitAlertsForShots()
      await setTheme(theme, false)
      await go('today', theme)
      const pristine = await fsp.readFile(settingsFile)

      // 1. reveal: the heat map fills in and the numbers count up, then Connect from the reveal
      await take(theme, 'reveal', win, async (c) => {
        await c.hold(500)
        c.cue('reveal')
        emit('system:reveal', null)
        await waitFor(`document.querySelector('.reveal__stats[aria-busy="false"]') && !document.querySelector('.sidebar')`, 'the reveal with its numbers')
        c.cue('stats')
        await c.hold(2200)
        await c.still('reveal')
        await c.clickButton('Connect to Claude Code', `document.querySelector('.reveal')`)
        await waitFor(`document.querySelector('dialog[open] .diff') && document.querySelectorAll('dialog[open] input[type=checkbox]:checked').length === 2`, 'the Connect sheet over the reveal')
        c.cue('sheet')
        await c.hold(1500)
        await c.clickButton('Connect', `document.querySelector('dialog[open]')`)
        await waitFor(`!document.querySelector('.reveal') && !document.querySelector('dialog[open]') && [...document.querySelectorAll('.lim button')].some((b) => b.textContent.trim() === 'Disconnect')`, 'Today, connected')
        c.cue('connected')
        await c.hold(1500)
      })
      await closeToasts()

      // 2. today: Claude Code runs the status line once, three sessions start, one stops to ask for permission
      const steps = await hookSteps()
      let sessions: Awaited<ReturnType<typeof startSessions>> = []
      await take(theme, 'today', win, async (c) => {
        await c.hold(800)
        const line = await playStatusLine(42, '/Users/me/code/app', WEEK)
        strings.statusLine = line
        await waitFor(`[...document.querySelectorAll('.lim__top b')].map((b) => b.textContent).join(' ') === '42% 28%'`, 'the limits at 42% and 28%')
        c.cue('limits')
        strings.trayTitle = glanceForShots()?.title
        await c.hold(1500)
        sessions = await startSessions(steps)
        c.cue('working')
        await c.hold(1500)
        const alerts = postedAlertTexts().length
        await advanceSessions(steps, sessions)
        await waitFor(`document.querySelectorAll('.cc__row--waiting').length === 1`, 'one waiting session')
        c.cue('waiting')
        strings.trayWaiting = glanceForShots()
        // the alert goes out once the grouping window closes (real time)
        await sleep(GROUP_MS + 1000)
        const posted = postedAlertTexts().slice(alerts)
        if (posted.length !== 1) throw new Error(`record: expected one alert, got ${JSON.stringify(posted)}`)
        strings.waitingAlert = posted[0]
        c.cue('alert')
        await c.hold(2500)
        await c.still('today')
      })

      // 3. popover: the menu bar popover with the waiting session first, then its settings view, where the limit alert
      // goes from Off to 80% (a native menu is not in a capture: the film draws it), and back
      const pop = await popoverForShots()
      emit('menubar:opened', null)
      await settle(theme, 'popover', pop)
      await take(theme, 'popover', pop, async (c) => {
        await c.hold(1800)
        await c.still('menubar')
        await c.clickEl(`document.querySelector('[aria-label="Alert settings"]')`, 'Alert settings')
        await waitFor(`document.querySelector('.pop__back')`, 'the settings view', pop)
        await c.hold(1400)
        const limitChoice = `[...document.querySelectorAll('.pop__row')].find((r) => r.textContent.startsWith('Limit reaches')).querySelector('select')`
        await c.clickEl(limitChoice, 'Limit reaches')
        await c.hold(900)
        await jsOn(pop, `(() => {
          const s = ${limitChoice}
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '80')
          s.dispatchEvent(new Event('change', { bubbles: true }))
        })()`)
        await waitFor(`${limitChoice}.value === '80'`, 'Limit reaches at 80%', pop)
        c.cue('80')
        await c.hold(1600)
        await c.clickEl(`document.querySelector('.pop__back')`, 'Back')
        await c.hold(1200)
      })

      // 4. limit: the 5-hour limit passes 80% and its alert goes out, then the weekly one and its own
      await take(theme, 'limit', pop, async (c) => {
        await c.hold(1000)
        const alerts = postedAlertTexts().length
        await playStatusLine(80, '/Users/me/code/app', WEEK)
        await waitFor(`[...document.querySelectorAll('.lim__top b')][0]?.textContent === '80%'`, 'the 80% reading', pop)
        c.cue('80')
        await sleep(1000)
        const posted = postedAlertTexts().slice(alerts)
        if (posted.length !== 1) throw new Error(`record: expected one limit alert, got ${JSON.stringify(posted)}`)
        strings.limitAlert = posted[0]
        strings.trayLimit = glanceForShots()?.title
        c.cue('alert')
        await c.hold(2500)
        const before = postedAlertTexts().length
        await playStatusLine(80, '/Users/me/code/app', 80)
        await waitFor(`[...document.querySelectorAll('.lim__top b')][1]?.textContent === '80%'`, 'the 80% weekly reading', pop)
        c.cue('week')
        await sleep(1000)
        const weekly = postedAlertTexts().slice(before)
        if (weekly.length !== 1) throw new Error(`record: expected one weekly limit alert, got ${JSON.stringify(weekly)}`)
        strings.weeklyAlert = weekly[0]
        c.cue('alert week')
        await c.hold(2500)
      })
      // the reading V2 starts from, then back to where the film rests
      await playStatusLine(38, '/Users/me/code/app', WEEK)
      await waitFor(`[...document.querySelectorAll('.lim__top b')].map((b) => b.textContent).join(' ') === '38% 28%'`, 'the limits at 38% and 28%')
      await sleep(300)
      strings.trayBefore = glanceForShots()?.title
      await playStatusLine(42, '/Users/me/code/app', WEEK)
      await waitFor(`[...document.querySelectorAll('.lim__top b')].map((b) => b.textContent).join(' ') === '42% 28%'`, 'the limits back at 42% and 28%')

      // 5. profiles: Work added and connected off camera, then the title bar menu with both, a switch to Work, the popover
      await js(`document.querySelector('.titlebar__profile').click()`)
      await click('Add profile…', `document.querySelector('.profile-menu')`)
      await waitFor(`document.querySelector('dialog[open] .add-profile__opt input:checked') && [...document.querySelectorAll('dialog[open] .add-profile__dir')].some((d) => d.textContent.endsWith('.claude-work'))`, 'the Add profile sheet with the work folder')
      await click('Add', `document.querySelector('dialog[open]')`)
      await waitFor(`!document.querySelector('dialog[open]') && document.querySelector('.titlebar__profile-name')?.textContent === 'Work' && document.querySelector('.today')`, 'Work open on Today')
      await closeToasts()
      const workFile = path.join(configDir(), 'settings.json')
      const workBefore = await fsp.readFile(workFile)
      await connect()
      await playStatusLine(18, '/Users/me/work/billing', 33)
      await waitFor(`[...document.querySelectorAll('.lim__top b')].map((b) => b.textContent).join(' ') === '18% 33%'`, "Work's limits")
      await openProfile('Default')
      await settle(theme, 'today')
      await take(theme, 'profiles', win, async (c) => {
        await c.hold(900)
        await c.clickEl(`document.querySelector('.titlebar__profile')`, 'folder')
        await waitFor(`document.querySelector('.profile-row__dot') && [...document.querySelectorAll('.profile-row__end')].map((e) => e.textContent).join(' ').includes('42%') && [...document.querySelectorAll('.profile-row__end')].map((e) => e.textContent).join(' ').includes('33%')`, 'both profiles, with their limits and the waiting dot')
        c.cue('menu')
        await c.hold(2000)
        await c.still('profiles')
        await c.clickEl(`[...document.querySelectorAll('.profile-row')].find((r) => r.textContent.includes('Work'))`, 'Work')
        await waitFor(`document.querySelector('.titlebar__profile-name')?.textContent === 'Work' && document.querySelector('.today') && document.querySelectorAll('.lim__top b').length === 2`, 'Work open on Today')
        c.cue('work')
        await c.hold(2800)
      })
      emit('menubar:opened', null)
      await settle(theme, 'popover', pop)
      await take(theme, 'profiles-pop', pop, async (c) => {
        await c.hold(600)
        await waitFor(`document.querySelector('.cc__row--waiting')?.textContent.includes('Default') && document.querySelector('.pop__other')`, 'the popover with both profiles', pop)
        c.cue('both')
        strings.trayWork = glanceForShots()?.title
        await c.hold(3000)
      })
      // Work disconnected and removed, off camera, leaving its settings.json as it was
      await click('Disconnect')
      await waitFor(`document.querySelector('dialog[open] .diff')`, 'the Disconnect dialog')
      await click('Disconnect', `document.querySelector('dialog[open]')`)
      await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Connect to Claude Code')`, 'Work disconnected')
      await closeToasts()
      await fsp.writeFile(workFile, workBefore)
      await openProfile('Default')
      await js(`document.querySelector('.titlebar__profile').click()`)
      await waitFor(`document.querySelectorAll('.profile-row').length === 2`, 'the profile menu')
      await js(`[...document.querySelectorAll('.profile-row')].find((r) => r.textContent.includes('Work'))?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
      await click('Remove from Claudock', `document.querySelector('.profile-menu')`)
      await waitFor(`!document.querySelector('.titlebar__profile-name')`, 'Work removed')
      await js(`document.querySelector('.titlebar__profile').click()`)
      await closeToasts()

      // 6. skills: one skill off, settings.json's skillOverrides, then on again
      await go('skills', theme)
      const row = `[...document.querySelectorAll('.list-row button')].find((b) => b.textContent.includes('release-notes'))`
      await jsOn(win, `(${row}).click()`)
      await waitFor(`document.querySelector('[role=switch][aria-checked="true"]')`, 'release-notes, on')
      await settle(theme, 'skills')
      await take(theme, 'skills', win, async (c) => {
        await c.hold(1000)
        await c.clickEl(`document.querySelector('[role=switch]')`, 'Turn off')
        await waitFor(`document.querySelector('[role=switch][aria-checked="false"]')`, 'release-notes, off')
        c.cue('off')
        await c.hold(2200)
        await c.still('skills')
        emit('system:navigate', { screen: 'settings' })
        await c.clickEl(`[...document.querySelectorAll('[role=radiogroup][aria-label="View"] [role=radio]')].find((b) => b.textContent.trim() === 'JSON')`, 'JSON')
        // CodeMirror draws only the lines in view: read the document from the editor itself
        const view = `((c) => c && ((c.cmTile && c.cmTile.root && c.cmTile.root.view) || (c.cmView && c.cmView.view)))(document.querySelector('.cm-content'))`
        await waitFor(`${view}?.state.doc.toString().includes('"release-notes": "off"')`, 'settings.json with release-notes off')
        // skillOverrides near the top of the editor, the release-notes line selected
        await js(`(() => {
          const view = ${view}
          const doc = view.state.doc.toString()
          view.dispatch({ selection: { anchor: doc.indexOf('"release-notes": "off"') } })
          view.scrollDOM.scrollTop = view.lineBlockAt(doc.indexOf('"skillOverrides"')).top - 3 * view.defaultLineHeight
        })()`)
        await c.hold(300)
        const line = await js<Box>(`(() => {
          const view = ${view}
          const r = view.coordsAtPos(view.state.doc.toString().indexOf('"release-notes": "off"'))
          return { x: r.left, y: r.top, w: 200, h: r.bottom - r.top }
        })()`)
        c.cue('json', line)
        await c.hold(2600)
        emit('system:navigate', { screen: 'skills' })
        await c.hold(300)
        await c.clickEl(row, 'release-notes')
        await waitFor(`document.querySelector('[role=switch][aria-checked="false"]')`, 'release-notes, off again')
        await c.hold(900)
        await c.clickEl(`document.querySelector('[role=switch]')`, 'Turn on')
        await waitFor(`document.querySelector('[role=switch][aria-checked="true"]')`, 'release-notes, on again')
        c.cue('on')
        await c.hold(2000)
      })
      await closeToasts()

      // 7. context: the skills ranked, one off and the total drops, on again
      const beforeContext = await fsp.readFile(settingsFile)
      await go('context', theme)
      await still(theme, 'context')
      const total = `document.querySelector('.ctx__total b')?.textContent`
      const contextSwitch = `document.querySelector('[role=switch][aria-label="release-notes in context"]')`
      const totalOn = await js<string>(total)
      await take(theme, 'context', win, async (c) => {
        await c.hold(1000)
        await c.clickEl(`[...document.querySelectorAll('.chip--button')].find((b) => b.textContent.startsWith('Skills'))`, 'Skills')
        await c.hold(1500)
        c.cue('total', await c.box(`document.querySelector('.ctx__total')`, 'the total'))
        await c.clickEl(contextSwitch, 'Turn off')
        await waitFor(`${contextSwitch}?.getAttribute('aria-checked') === 'false' && !${contextSwitch}.disabled && ${total} !== ${JSON.stringify(totalOn)}`, 'release-notes off and the total down')
        c.cue('off')
        await c.hold(2600)
        await c.clickEl(contextSwitch, 'Turn on')
        await waitFor(`${contextSwitch}?.getAttribute('aria-checked') === 'true' && !${contextSwitch}.disabled && ${total} === ${JSON.stringify(totalOn)}`, 'release-notes on and the total back')
        c.cue('on')
        await c.hold(1500)
      })
      await closeToasts()
      if (!beforeContext.equals(await fsp.readFile(settingsFile))) throw new Error('record: the Context take did not leave settings.json byte for byte')

      // 8. settings: the form, for the screenshot
      await go('settings', theme)
      await still(theme, 'settings')

      // 9. restore: settings.json breaks (a bad hand edit), yesterday's snapshot puts it back
      const good = await fsp.readFile(settingsFile)
      const yesterday = new Date(Date.now() - 86_400_000)
      yesterday.setHours(18, 42, 7, 0)
      const id = yesterday.toISOString().replace(/:/g, '-')
      await fsp.mkdir(path.join(snapshotsDir(), id), { recursive: true })
      await fsp.writeFile(path.join(snapshotsDir(), id, 'settings.json'), good)
      await fsp.writeFile(path.join(snapshotsDir(), id, 'manifest.json'), JSON.stringify({ at: yesterday.toISOString(), reason: 'Edit settings.json in Claudock', files: ['settings.json'] }, null, 2) + '\n')
      const broken = good.toString('utf8').replace(/"effortLevel": "high",\n/, '"effortLevel": "high"\n  "outputStyle": "Explanatory",\n')
      if (broken === good.toString('utf8')) throw new Error('record: could not break settings.json (no effortLevel line)')
      await fsp.writeFile(settingsFile, broken)
      strings.brokenSettings = broken
      await go('backups', theme)
      await take(theme, 'restore', win, async (c) => {
        c.cue('backups')
        await c.hold(900)
        await c.clickEl(`[...document.querySelectorAll('.list-row button')].find((b) => b.textContent.includes('Edit settings.json in Claudock'))`, 'yesterday')
        await waitFor(`document.querySelector('.bk__diff') && !document.querySelector('.bk__compare[aria-busy]')`, 'the diff')
        c.cue('diff')
        await c.hold(2400)
        await c.still('backups')
        await c.clickButton('Restore this file')
        await waitFor(`document.querySelector('dialog[open]')`, 'the restore dialog')
        c.cue('dialog')
        await c.hold(1400)
        await c.clickButton('Restore', `document.querySelector('dialog[open]')`)
        await waitFor(`!document.querySelector('dialog[open]') && document.querySelector('.toast')`, 'the restored toast')
        c.cue('restored')
        await c.hold(2500)
      })
      if (!good.equals(await fsp.readFile(settingsFile))) throw new Error('record: the restore did not bring settings.json back byte for byte')
      await closeToasts()
      await fsp.rm(path.join(snapshotsDir(), id), { recursive: true, force: true })

      // 10. sessions: a session Claude Code deleted, found by a word of its first prompt, its resume command copied
      const oldSession = await seedDeletedSession()
      await go('archive', theme)
      const hit = `[...document.querySelectorAll('.list-row')].find((r) => r.querySelector('.ses-snippet') && r.querySelector('.list-row__title')?.textContent === ${JSON.stringify(OLD_PROMPT)})`
      await take(theme, 'sessions', win, async (c) => {
        await c.hold(900)
        c.cue('search', await c.box(`document.querySelector('.ldl__list .search-field__input')`, 'the search field'))
        for (const n of [1, 2, 3, 4, 5, 6, 7]) {
          await js(`(() => {
            const input = document.querySelector('.ldl__list .search-field__input')
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify('invoice'.slice(0, n))})
            input.dispatchEvent(new Event('input', { bubbles: true }))
          })()`)
          await c.hold(90)
        }
        await waitFor(`document.querySelectorAll('.ses-snippet').length === 1 && ${hit}`, 'the one search hit')
        c.cue('hit')
        await c.hold(1100)
        await c.clickEl(`${hit}.querySelector('button')`, 'hit')
        await waitFor(`document.querySelector('.detail-pane__title')?.textContent === ${JSON.stringify(OLD_PROMPT)} && document.querySelector('.tx__focus')`, 'the hit opened at its line')
        c.cue('open')
        await c.hold(2400)
        await c.still('sessions')
        await c.clickButton('Copy resume command', `document.querySelector('.detail-pane')`)
        await waitFor(`document.querySelector('.ses-cmd')?.textContent.includes('--resume ${OLD_ID}')`, 'the resume command')
        c.cue('resume', await c.box(`document.querySelector('.ses-cmd')`, 'the resume command'))
        await c.hold(2600)
      })
      await closeToasts()
      // put back and dated now, it would be the next theme's newest session
      await fsp.rm(oldSession)

      // 11. share: the week's card beside a plan (set off camera), a week back, the cursor on Post on X, which isn't clicked
      await go('today', theme)
      const shareOpen = `[...document.querySelectorAll('.today__actions button')].find((b) => b.textContent.trim() === 'Share' && !b.disabled)`
      const cardReady = `document.querySelector('.share__canvas[data-ready="true"]')`
      await js(`${shareOpen}.click()`)
      await waitFor(cardReady, 'the week card')
      await js(`(() => {
        const s = document.querySelector('.share select')
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'max20')
        s.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
      await sleep(400)
      await js(`document.querySelector('.share [aria-label="Close"]').click()`)
      await waitFor(`!document.querySelector('dialog[open]')`, 'Share closed')
      await settle(theme, 'today')
      await take(theme, 'share', win, async (c) => {
        await c.hold(900)
        await c.clickEl(shareOpen, 'Share')
        await waitFor(cardReady, 'the week card')
        c.cue('week')
        await c.hold(2600)
        await c.still('share')
        const range = await js<string>(`document.querySelector('.share__range').textContent`)
        await c.clickEl(`document.querySelector('.share [aria-label="Previous week"]')`, 'back')
        await waitFor(`document.querySelector('.share__range').textContent !== ${JSON.stringify(range)} && ${cardReady}`, 'the week before')
        c.cue('before')
        await c.hold(2200)
        c.cue('post', await c.box(`[...document.querySelectorAll('.share button')].find((b) => b.textContent.trim() === 'Post on X')`, 'Post on X'))
        await c.hold(1600)
      })
      await js(`document.querySelector('.share [aria-label="Close"]').click()`)
      await waitFor(`!document.querySelector('dialog[open]')`, 'Share closed')

      await disconnect(pristine)
    }
  } catch (e) {
    fail(e)
    // what the window showed when the take failed
    await fsp.writeFile(path.join(opts.dir, 'failed.png'), (await win.webContents.capturePage()).toPNG()).catch(() => undefined)
  }

  await clipboard.writeText(clipboardBefore)
  await fsp.writeFile(path.join(opts.dir, 'strings.json'), JSON.stringify(strings, null, 2) + '\n')
  console.log(errors.length ? `RECORD_DONE with ${errors.length} error(s)` : 'RECORD_DONE ok')
  app.exit(errors.length ? 1 : 0)
}

type TakeCtx = {
  /** The box of the element `el` (a JS expression) evaluates to, waiting for it. */
  box: (el: string, label: string) => Promise<Box>
  /** Wait this long in the take's (slowed) time. */
  hold: (ms: number) => Promise<void>
  /** Name this moment, for the film's timing, with the box it is about if any. */
  cue: (label: string, box?: Box) => void
  /** Click the element `el` (a JS expression) evaluates to, keeping its box for the cursor. */
  clickEl: (el: string, label: string, on?: BrowserWindow) => Promise<void>
  /** Click the enabled button with this text inside `scope`. */
  clickButton: (label: string, scope?: string, on?: BrowserWindow) => Promise<void>
  /** Save the take's window, full size, as a screenshot. */
  still: (name: string) => Promise<void>
}
