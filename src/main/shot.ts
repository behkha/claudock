import type { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SCREENS, type ScreenId } from '@shared/nav'
import { app } from 'electron'
import { connectDir } from './connect/folder'
import { archiveRootOf, list as archiveList, markdownOf, search as archiveSearch, sweepNow } from './domains/archive'
import { listContext } from './domains/context'
import { GROUP_MS } from './connect/sessionModel'
import { postedAlerts } from './alerts'
import { alertPrefs, setAlertPrefs } from './domains/sessions'
import { popoverForShots } from './menubar'
import { countHooks } from './domains/settings'
import { emit } from './ipcx'
import { configDir } from './paths'
import { setTheme } from './theme'
import { driver, sleep } from './shotDrive'

/**
 * Screenshot mode (CLAUDOCK_SHOT=1, driven by scripts/shot.mjs): visits every screen in light then dark through the
 * normal `system:navigate` / `system:theme` events, waits until each is loaded and painted in that theme, saves
 * `<dir>/<theme>-<screen>.png` (plus `connect`, the Connect sheet, `connected`, the Today card after connecting with one played status line run and three sessions played through the real hooks, which must post exactly one alert, `connected-hooks`, the Hooks screen then, where Claudock's hooks are one row and out of the counts, and `disconnect`, the confirm dialog that row's Disconnect… opens, which must leave settings.json byte for byte as it was, `profiles-add`, `profiles-menu` and `profiles-menubar`, profiles with a second folder added and removed again, `archive-search` and `archive-resume`, the Sessions screen with a session Claude Code deleted found and put back, `palette`, `settings-json`, `mods-draft`, the Mods screen with the fixture's draft selected, and `share`, the Today share dialog, and `card.png`, the card itself, and `reveal`, `reveal-connect`, `reveal-connected` and `reveal-empty`, the first-run reveal, and `context-off`, the Context screen with an MCP server and a skill switched off and a row's counted text open, which must leave settings.json byte for byte as it was once they are back on), prints renderer console errors as `CONSOLE_ERROR ...` and failed shots as
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

  const { js, jsOn, settle, click, waitFor, playStatusLine, hookSteps, playSessions } = driver(win)

  /**
   * Capture and save `<theme>-<what>.png`. A pixel near the bottom-right corner must match the background the DOM has
   * there, so a stale frame from before the theme switch is retried instead of saved. Skipped under a translucent
   * overlay (the palette scrim or a modal dialog's backdrop), where the DOM colour is not what gets painted.
   */
  async function capture(theme: 'light' | 'dark', what: string, w: BrowserWindow = win): Promise<void> {
    const want = await jsOn<number[]>(
      w,
      `(() => {
      if (document.querySelector('dialog[open]')) return [] // a modal's backdrop dims the page: the DOM colour is not what is painted
      for (let el = document.elementFromPoint(innerWidth - 4, innerHeight - 4); el; el = el.parentElement) {
        const [r, g, b, a = 1] = (getComputedStyle(el).backgroundColor.match(/[\\d.]+/g) ?? []).map(Number)
        if (a === 1) return [r, g, b]
        if (a > 0) return []
      }
      return []
    })()`)
    for (let attempt = 1; ; attempt++) {
      const img = await w.webContents.capturePage()
      const { width, height } = img.getSize()
      const scale = width / w.getContentSize()[0]
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
      w.webContents.invalidate()
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

  /** Today -> "Share" -> the dialog with the card drawn (the canvas says so with data-ready). */
  const openShare = (): Promise<void> =>
    js(`(async () => {
      const wait = async (f, ms = 15000) => {
        const t = Date.now()
        while (Date.now() - t < ms) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)) }
        throw new Error('share: timed out waiting for ' + f)
      }
      const button = await wait(() => [...document.querySelectorAll('.today__actions button')].find((b) => b.textContent.trim() === 'Share' && !b.disabled))
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


  /**
   * Today -> Connect to Claude Code -> the sheet (shot) -> Connect -> one status line run and three sessions through
   * the real hooks (one ends up waiting on a permission prompt, one working, one done) -> exactly one alert -> the card
   * (shot) -> Hooks: one Claudock row, the list and sidebar counts as before (shot) -> its Disconnect… -> the card's
   * dialog on Today (shot) -> settings.json byte for byte as before, and the connect folder empty of scripts.
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
    const steps = await hookSteps()
    const alerts = postedAlerts().length
    const [a] = await playSessions(steps)
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
      `document.querySelector('dialog[open] .diff') && document.querySelector('.today')`,
      'the Disconnect dialog on Today'
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

  /**
   * The menu bar popover, on the fixture: connect, one status line run and three sessions -> the popover with the
   * waiting session first and both limits (shot `menubar`) -> its settings view (shot `menubar-settings`). In light
   * only, the limit alert at 80%: a reading of 85% posts exactly one alert, a second one at 90% none. Then Disconnect,
   * with settings.json byte for byte as before. The popover is never shown; it is captured like the main window.
   */
  async function menubarFlow(theme: 'light' | 'dark'): Promise<void> {
    const file = path.join(configDir(), 'settings.json')
    const before = await fsp.readFile(file)
    await click('Connect to Claude Code')
    await waitFor(`document.querySelector('dialog[open] .diff')`, 'the Connect sheet')
    await click('Connect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Disconnect')`, 'the connection')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    await playStatusLine()
    const [a] = await playSessions(await hookSteps())
    const pop = await popoverForShots()
    const inPop = (code: string): Promise<unknown> => jsOn(pop, code)
    const waitPop = (cond: string, what: string): Promise<unknown> =>
      inPop(`(async () => {
        const t = Date.now()
        while (Date.now() - t < 15000) { if (${cond}) return; await new Promise((r) => setTimeout(r, 100)) }
        throw new Error('menubar: timed out waiting for ' + ${JSON.stringify(what)})
      })()`)
    emit('menubar:opened', null)
    await waitPop(
      `document.querySelector('.cc__row--waiting')?.textContent.includes(${JSON.stringify(path.basename(a.cwd))}) && document.querySelectorAll('.cc__row').length === 3 && [...document.querySelectorAll('.lim__top b')].map((b) => b.textContent).join(' ') === '42% 61%'`,
      'the waiting session and both limits'
    )
    await shoot(theme, 'menubar', pop)
    await inPop(`document.querySelector('[aria-label="Alert settings"]').click()`)
    await waitPop(`document.querySelector('.pop__back') && document.querySelectorAll('.pop__row').length >= 5`, 'the settings view')
    await shoot(theme, 'menubar-settings', pop)
    await inPop(`document.querySelector('.pop__back').click()`)
    if (theme === 'light') {
      const was = await alertPrefs()
      await setAlertPrefs({ limitPercent: 80 })
      const alerts = postedAlerts().length
      try {
        await playStatusLine(85)
        await waitFor(`[...document.querySelectorAll('.lim__top b')][0]?.textContent === '85%'`, 'the 85% reading')
        await sleep(1000)
        await playStatusLine(90)
        await waitFor(`[...document.querySelectorAll('.lim__top b')][0]?.textContent === '90%'`, 'the 90% reading')
        await sleep(1000)
      } finally {
        await setAlertPrefs({ limitPercent: was.limitPercent })
      }
      const posted = postedAlerts().slice(alerts).filter((t) => t.includes('limit'))
      if (posted.length !== 1 || posted[0] !== '5-hour limit at 85%') throw new Error(`menubar: expected one alert "5-hour limit at 85%", got ${JSON.stringify(posted)}`)
    }
    await click('Disconnect')
    await waitFor(`document.querySelector('dialog[open] .diff')`, 'the Disconnect dialog')
    await click('Disconnect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Connect to Claude Code')`, 'the disconnect')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    if (!before.equals(await fsp.readFile(file))) throw new Error('menubar: settings.json is not byte for byte what it was before connecting')
  }

  /**
   * Profiles (item 42), on the fixture with `~/.claude-work` beside it: connect the default profile, one status line run
   * and three sessions -> the title bar menu -> Add profile, the sheet with the work folder found (shot `profiles-add`)
   * -> Add opens Work -> the menu with both profiles, Default's limit and its waiting dot (shot `profiles-menu`) -> the
   * popover: Default's waiting session named with its profile, Work's Connect, Default as one line (shot
   * `profiles-menubar`) -> back to Default from the menu, Disconnect, Work removed from its row's right-click menu, and
   * settings.json byte for byte as before.
   */
  async function profilesFlow(theme: 'light' | 'dark'): Promise<void> {
    const file = path.join(configDir(), 'settings.json')
    const before = await fsp.readFile(file)
    await click('Connect to Claude Code')
    await waitFor(`document.querySelector('dialog[open] .diff')`, 'the Connect sheet')
    await click('Connect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Disconnect')`, 'the connection')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    await playStatusLine()
    const [a] = await playSessions(await hookSteps())
    const toggleMenu = (): Promise<unknown> => js(`document.querySelector('.titlebar__profile').click()`)
    await toggleMenu()
    await click('Add profile…', `document.querySelector('.profile-menu')`)
    await waitFor(
      `document.querySelector('dialog[open] .add-profile__opt input:checked') && [...document.querySelectorAll('dialog[open] .add-profile__dir')].some((d) => d.textContent.endsWith('.claude-work'))`,
      'the Add profile sheet with the work folder'
    )
    await shoot(theme, 'profiles-add')
    await click('Add', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && document.querySelector('.titlebar__profile-name')?.textContent === 'Work' && document.querySelector('.today')`, 'Work open on Today')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    await toggleMenu()
    await waitFor(`document.querySelectorAll('.profile-row').length === 2 && document.querySelector('.profile-row__dot') && [...document.querySelectorAll('.profile-row__end')].some((e) => e.textContent.includes('61%'))`, 'both profiles, Default waiting at 61%')
    await shoot(theme, 'profiles-menu')
    await toggleMenu()
    const pop = await popoverForShots()
    emit('menubar:opened', null)
    await jsOn(
      pop,
      `(async () => {
        const t = Date.now()
        while (Date.now() - t < 15000) {
          if (document.querySelector('.cc__row--waiting')?.textContent.includes(${JSON.stringify(`Default · ${path.basename(a.cwd)}`)}) && document.querySelector('.pop__other')?.textContent.includes('5-hour 42% · Weekly 61%')) return
          await new Promise((r) => setTimeout(r, 100))
        }
        throw new Error('profiles: timed out waiting for the popover with both profiles')
      })()`
    )
    await shoot(theme, 'profiles-menubar', pop)
    await toggleMenu()
    await js(`[...document.querySelectorAll('.profile-row')].find((r) => r.textContent.includes('Default'))?.click()`)
    await waitFor(`document.querySelector('.titlebar__profile-name')?.textContent === 'Default' && [...document.querySelectorAll('.lim button')].some((b) => b.textContent.trim() === 'Disconnect')`, 'Default open again')
    await click('Disconnect')
    await waitFor(`document.querySelector('dialog[open] .diff')`, 'the Disconnect dialog')
    await click('Disconnect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Connect to Claude Code')`, 'the disconnect')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    await toggleMenu()
    await js(`[...document.querySelectorAll('.profile-row')].find((r) => r.textContent.includes('Work'))?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
    await click('Remove from Claudock', `document.querySelector('.profile-menu')`)
    await waitFor(`!document.querySelector('.titlebar__profile-name')`, 'Work removed')
    await toggleMenu()
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    if (!before.equals(await fsp.readFile(file))) throw new Error('profiles: settings.json is not byte for byte what it was before connecting')
  }

  /**
   * The first-run reveal, shown through `system:reveal` (screenshot mode never shows it on its own): the reveal with the
   * fixture's numbers once they have counted up (shot `reveal`), the Connect sheet over it (`reveal-connect`), Connect
   * -> Today with the card connected (`reveal-connected`), then Disconnect with settings.json byte for byte as before.
   * In light only, the empty version (`reveal-empty`): the fixture copy's stats-cache.json and history.jsonl moved aside
   * and put back, never in a run on a real folder.
   */
  async function revealFlow(theme: 'light' | 'dark'): Promise<void> {
    const file = path.join(configDir(), 'settings.json')
    const before = await fsp.readFile(file)
    emit('system:reveal', null)
    await waitFor(`document.querySelector('.reveal__stats[aria-busy="false"]') && !document.querySelector('.sidebar')`, 'the reveal with its numbers')
    await shoot(theme, 'reveal')
    await click('Connect to Claude Code', `document.querySelector('.reveal')`)
    await waitFor(`document.querySelector('dialog[open] .diff') && document.querySelectorAll('dialog[open] input[type=checkbox]:checked').length === 2`, 'the Connect sheet over the reveal')
    await shoot(theme, 'reveal-connect')
    await click('Connect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('.reveal') && !document.querySelector('dialog[open]') && [...document.querySelectorAll('.lim button')].some((b) => b.textContent.trim() === 'Disconnect')`, 'Today, connected')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    await shoot(theme, 'reveal-connected')
    await click('Disconnect')
    await waitFor(`document.querySelector('dialog[open] .diff')`, 'the Disconnect dialog')
    await click('Disconnect', `document.querySelector('dialog[open]')`)
    await waitFor(`!document.querySelector('dialog[open]') && [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Connect to Claude Code')`, 'the disconnect')
    await js(`document.querySelectorAll('.toast__close').forEach((b) => b.click())`)
    if (!before.equals(await fsp.readFile(file))) throw new Error('reveal: settings.json is not byte for byte what it was before connecting')

    if (theme !== 'light' || process.env.CLAUDOCK_READONLY === '1' || !configDir().includes(`${path.sep}.shots${path.sep}.tmp-`)) return
    const hidden = ['stats-cache.json', 'history.jsonl'].map((n) => path.join(configDir(), n))
    await Promise.all(hidden.map((f) => fsp.rename(f, `${f}.shot`)))
    try {
      emit('system:reveal', null)
      await waitFor(`document.querySelector('.reveal__none') && document.querySelector('.reveal__share')?.disabled`, 'the empty reveal')
      await shoot(theme, 'reveal-empty')
      await click('Not now', `document.querySelector('.reveal')`)
      await waitFor(`!document.querySelector('.reveal') && document.querySelector('.sidebar')`, 'Today after Not now')
    } finally {
      await Promise.all(hidden.map((f) => fsp.rename(`${f}.shot`, f)))
    }
  }

  /**
   * The session archive (the Sessions screen): every transcript is held as a hard link; Claude Code's cleanup is played
   * by deleting the oldest session's transcript and folder from the copy -> it shows as Archived; a search for a word of
   * its title opens it at the line that matched (shot `archive-search`); Copy resume command puts it back byte for byte,
   * dated now (shot `archive-resume`); its Markdown starts with its title. Only ever on the shot's own copy.
   */
  async function archiveFlow(theme: 'light' | 'dark'): Promise<void> {
    if (process.env.CLAUDOCK_READONLY === '1' || !configDir().includes(`${path.sep}.shots${path.sep}.tmp-`)) return
    await sweepNow()
    const rows = (await archiveList()).sessions
    const target = rows.filter((r) => !r.archived && r.title && r.messages > 1).at(-1)
    if (!target) throw new Error('archive: no session in the fixture to delete')
    const live = path.join(configDir(), 'projects', target.projectId, `${target.id}.jsonl`)
    const held = path.join(archiveRootOf(configDir()), 'projects', target.projectId, `${target.id}.jsonl`)
    const bytes = await fsp.readFile(live)
    if ((await fsp.stat(held)).ino !== (await fsp.stat(live)).ino) throw new Error('archive: the transcript is not hard-linked into the archive')
    // Claude Code's cleanup
    await fsp.rm(live)
    await fsp.rm(path.join(configDir(), 'projects', target.projectId, target.id), { recursive: true, force: true })
    await sweepNow()
    if (!(await archiveList()).sessions.find((r) => r.key === target.key)?.archived) throw new Error('archive: the deleted session is not shown as archived')

    const word = target.title.split(/[^A-Za-z]+/).sort((a, b) => b.length - a.length)[0]?.toLowerCase() ?? ''
    emit('system:navigate', { screen: 'archive' })
    await sleep(150)
    await js(`(() => {
      const input = document.querySelector('.ldl__list .search-field__input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(word)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    // a hit row: its title is the session's (another session's snippet may quote it)
    const hitRow = `[...document.querySelectorAll('.list-row')].find((r) => r.querySelector('.ses-snippet') && r.querySelector('.list-row__title')?.textContent === ${JSON.stringify(target.title)})`
    await waitFor(hitRow, 'the search hit')
    await js(`${hitRow}.querySelector('button').click()`)
    await waitFor(`document.querySelector('.detail-pane__title')?.textContent === ${JSON.stringify(target.title)} && document.querySelector('.tx__focus')`, 'the hit opened at its line')
    await shoot(theme, 'archive-search')
    await js(`(() => {
      const input = document.querySelector('.ldl__list .search-field__input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)

    await waitFor(`[...document.querySelectorAll('.detail-pane .badge')].some((b) => b.textContent === 'Archived') && !document.querySelector('.toast')`, 'the Archived badge, no toast left')
    await click('Copy resume command', `document.querySelector('.detail-pane')`)
    // put back: the badge goes once the list reloads
    await waitFor(
      `document.querySelector('.ses-cmd')?.textContent.includes('--resume ${target.id}') && ![...document.querySelectorAll('.detail-pane .badge')].some((b) => b.textContent === 'Archived')`,
      'the session put back and its resume command'
    )
    const back = await fsp.readFile(live)
    if (!back.equals(bytes)) throw new Error('archive: the session put back is not byte for byte what Claude Code deleted')
    if (Date.now() - (await fsp.stat(live)).mtimeMs > 60_000) throw new Error('archive: the session put back is not dated now')
    await shoot(theme, 'archive-resume')

    const md = await markdownOf(target.key)
    if (!md.text.startsWith(`# ${target.title}\n`) || !md.text.includes('\n## You')) throw new Error('archive: the Markdown export is missing its title or prompts')

    // a word of Claude's first reply, not of any title, finds it in the full text and in ⌘K
    const titles = new Set(rows.flatMap((r) => r.title.toLowerCase().split(/[^a-z]+/)))
    const reply = md.text.split('\n## Claude')[1]?.split('\n## ')[0] ?? ''
    const rare = reply.split(/[^A-Za-z]+/).filter((w) => w.length >= 6 && !titles.has(w.toLowerCase())).sort((a, b) => b.length - a.length)[0]
    if (!rare) throw new Error('archive: no word in the first reply to search for')
    const hit = (await archiveSearch(rare)).find((h) => h.key === target.key)
    if (!hit || hit.offset < 0 || !hit.marks.length) throw new Error(`archive: searching "${rare}" did not find the session at a line`)
    emit('system:openPalette', null)
    await sleep(150)
    await js(`(() => {
      const input = document.querySelector('.palette__input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(rare)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await waitFor(`[...document.querySelectorAll('.palette__item')].some((i) => i.textContent.toLowerCase().includes(${JSON.stringify(rare.toLowerCase())}))`, 'a full-text session hit in ⌘K')
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`)
    // nothing of this flow in the shots after it
    await waitFor(`!document.querySelector('.palette') && !document.querySelector('.toast')`, 'the palette and the toast gone')
  }

  /**
   * Context: the numbers come from the fixture's newest session; turn the github server and two skills off from their
   * switches (deniedMcpServers, skillOverrides user-invocable-only; release-notes had "on", which must come back),
   * open a row's counted text, shoot, turn them back on, and fail unless settings.json is byte for byte as before.
   */
  async function contextFlow(theme: 'light' | 'dark'): Promise<void> {
    if (process.env.CLAUDOCK_READONLY === '1' || !configDir().includes(`${path.sep}.shots${path.sep}.tmp-`)) return
    const settingsFile = path.join(configDir(), 'settings.json')
    const before = await fsp.readFile(settingsFile)
    const l = await listContext(true)
    const item = (id: string): (typeof l.items)[number] => {
      const i = l.items.find((x) => x.id === id)
      if (!i) throw new Error(`context: no ${id} row`)
      return i
    }
    const gh = item('mcp:github')
    if (gh.tools !== 28 || gh.measured !== 'session' || !gh.tokens) throw new Error(`context: github is not measured from the session (${JSON.stringify(gh)})`)
    if (item('mcp:docs-search').uses !== 2 || item('mcp:github').uses !== 0) throw new Error('context: MCP tool calls are not counted')
    if (item('mcp:claude.ai Linear').missing !== 'needs-auth') throw new Error('context: the connector that needs a login has a number')
    if (item('skill:release-notes').measured !== 'session' || item('skill:release-notes').uses !== 12) throw new Error('context: release-notes is not measured from the listing')
    if (item('skill:big-assets').on) throw new Error('context: a skill that is off counts')
    const memory = l.items.filter((i) => i.kind === 'memory').map((i) => i.name).sort()
    if (memory.join() !== 'CLAUDE.md,rules/git.md,rules/security.md') throw new Error(`context: the instruction files are ${memory.join()}`)
    if (l.tokens !== l.items.reduce((n, i) => n + (i.on && i.tokens ? i.tokens : 0), 0)) throw new Error('context: the total is not the sum of its rows')

    emit('system:navigate', { screen: 'context' })
    await sleep(150)
    const flip = async (name: string, on: boolean): Promise<void> => {
      const sw = `document.querySelector('[role=switch][aria-label=${JSON.stringify(`${name} in context`)}]')`
      await waitFor(`${sw} && !${sw}.disabled && ${sw}.getAttribute('aria-checked') === ${JSON.stringify(String(!on))}`, `the ${name} switch`)
      await js(`${sw}.click()`)
      await waitFor(`${sw}?.getAttribute('aria-checked') === ${JSON.stringify(String(on))} && !${sw}.disabled`, `${name} switched ${on ? 'on' : 'off'}`)
    }
    await flip('github', false)
    await flip('db-migrations', false)
    await flip('release-notes', false)
    const off = JSON.parse(await fsp.readFile(settingsFile, 'utf8')) as { deniedMcpServers?: unknown; skillOverrides?: Record<string, unknown> }
    if (JSON.stringify(off.deniedMcpServers) !== JSON.stringify([{ serverName: 'github' }])) throw new Error(`context: deniedMcpServers is ${JSON.stringify(off.deniedMcpServers)}`)
    for (const k of ['db-migrations', 'release-notes']) if (off.skillOverrides?.[k] !== 'user-invocable-only') throw new Error(`context: ${k} was not hidden from Claude with /name kept`)
    await js(`[...document.querySelectorAll('.ctx__name')].find((b) => b.querySelector('.ctx__label')?.textContent === 'docs-search')?.click()`)
    await waitFor(`document.querySelector('.ctx__text')?.textContent.includes('mcp__docs-search__search') && !document.querySelector('.toast')`, 'the counted text, no toast left')
    await shoot(theme, 'context-off')
    await js(`document.querySelector('.ctx__row--open .ctx__name')?.click()`)
    await flip('github', true)
    await flip('db-migrations', true)
    await flip('release-notes', true)
    if (!(await fsp.readFile(settingsFile)).equals(before)) throw new Error('context: settings.json is not byte for byte as before after switching back on')
    await waitFor(`!document.querySelector('.toast')`, 'the toasts gone')
  }

  const fail = (e: unknown): void => {
    errors.push(`SHOT_FAILED ${(e as Error).message}`)
    console.log(`SHOT_FAILED ${(e as Error).message}`)
  }
  const shoot = (theme: 'light' | 'dark', what: string, w: BrowserWindow = win): Promise<void> =>
    settle(theme, what, w).then(() => capture(theme, what, w)).catch(fail)

  await fsp.mkdir(opts.dir, { recursive: true })
  const screens = SCREENS.filter((s) => opts.only.length === 0 || opts.only.includes(s.id))

  try {
    // wait for the shell
    const deadline = Date.now() + 30_000
    while (!(await js<boolean>(`!!document.querySelector('[data-app-ready]')`))) {
      if (Date.now() > deadline) throw new Error('app not ready after 30 s')
      await sleep(100)
    }
    // the Sessions screen shows every session read, not the first pass's "Reading…"
    await sweepNow()

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
        emit('system:navigate', { screen: 'today' })
        await sleep(150)
        emit('system:navigate', { screen: (screens[screens.length - 1]?.id ?? 'today') as ScreenId })
        await sleep(150)
      }
      if (process.platform !== 'win32' && (opts.only.length === 0 || opts.only.includes('connect'))) {
        emit('system:navigate', { screen: 'today' })
        await sleep(150)
        await connectFlow(theme).catch(fail)
      }
      if (process.platform !== 'win32' && (opts.only.length === 0 || opts.only.includes('menubar'))) {
        emit('system:navigate', { screen: 'today' })
        await sleep(150)
        await menubarFlow(theme).catch(fail)
      }
      if (process.platform !== 'win32' && (opts.only.length === 0 || opts.only.includes('profiles'))) {
        emit('system:navigate', { screen: 'today' })
        await sleep(150)
        await profilesFlow(theme).catch(fail)
      }
      if (process.platform !== 'win32' && (opts.only.length === 0 || opts.only.includes('reveal'))) {
        emit('system:navigate', { screen: 'today' })
        await sleep(150)
        await revealFlow(theme).catch(fail)
      }
      if (opts.only.length === 0 || opts.only.includes('archive')) {
        await archiveFlow(theme).catch(fail)
      }
      if (opts.only.length === 0 || opts.only.includes('context')) {
        await contextFlow(theme).catch(fail)
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
        emit('system:navigate', { screen: 'today' })
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
