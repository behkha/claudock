import type { BrowserWindow } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * The UI audit screenshot mode runs beside each shot (`npm run shot -- --audit`, CLAUDOCK_AUDIT=<path to axe.min.js>):
 * for the page as it stands when the picture is taken it writes `<dir>/audit/<theme>-<what>.json` with
 *   - axe-core's violations (WCAG 2.x A and AA, plus its best-practice rules) and the measured contrast of every text
 *     node axe could measure (lowest ratio, how many are under 4.5:1);
 *   - a keyboard pass: Tab is pressed through the page and every stop is recorded, with whether it shows a focus
 *     ring, which controls were never reached, and whether a modal keeps focus inside;
 *   - what a screen reader gets from Chromium's accessibility tree: controls without a name, the heading outline, the
 *     landmarks and dialogs;
 *   - layout at this window size: sideways page scroll, content outside the window, text cut off without an ellipsis,
 *     and click targets under 24 px.
 * Development only: nothing here runs outside screenshot mode.
 */

const AXE = process.env.CLAUDOCK_AUDIT ?? ''
export const auditing = AXE !== ''
let axeSource: Promise<string> | null = null

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Runs in the page: axe, contrast and layout. Returns plain JSON. */
const PAGE_AUDIT = `(async () => {
  const sel = (el) => {
    if (!el || !el.tagName) return ''
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls + (label ? ' "' + label + '"' : '')
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    const s = getComputedStyle(el)
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
  }
  const modal = document.querySelector('dialog[open]')
  const scope = modal || document.body
  const out = { viewport: [innerWidth, innerHeight], modal: !!modal }

  const r = await axe.run(document, { resultTypes: ['violations', 'incomplete'] })
  out.violations = r.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    count: v.nodes.length,
    nodes: v.nodes.slice(0, 5).map((n) => {
      const d = (n.any[0] && n.any[0].data) || {}
      return { target: String(n.target.join(' ')).slice(0, 110), html: n.html.replace(/\\s+/g, ' ').slice(0, 120), fg: d.fgColor, bg: d.bgColor, ratio: d.contrastRatio, need: d.expectedContrastRatio, size: d.fontSize }
    })
  }))
  out.incomplete = r.incomplete.map((v) => ({ id: v.id, count: v.nodes.length }))

  const c = await axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['passes', 'violations'] })
  const measured = []
  for (const group of [c.passes, c.violations]) for (const v of group) for (const n of v.nodes) {
    const d = (n.any[0] && n.any[0].data) || (n.all[0] && n.all[0].data) || {}
    if (typeof d.contrastRatio === 'number' && d.contrastRatio > 0) measured.push({ ratio: d.contrastRatio, fg: d.fgColor, bg: d.bgColor, size: d.fontSize, target: String(n.target.join(' ')).slice(0, 110) })
  }
  measured.sort((a, b) => a.ratio - b.ratio)
  out.contrast = { measured: measured.length, min: measured.length ? measured[0].ratio : null, under45: measured.filter((m) => m.ratio < 4.5).length, lowest: measured.slice(0, 4) }

  const root = document.scrollingElement
  out.pageScrollX = root.scrollWidth > innerWidth + 1
  const outside = []
  const cut = []
  const small = []
  for (const el of scope.querySelectorAll('*')) {
    if (!visible(el)) continue
    const b = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if ((b.right > innerWidth + 1 || b.left < -1) && b.width < innerWidth * 2) {
      // inside something that scrolls sideways on purpose is fine
      let p = el.parentElement, ok = false
      for (; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') { ok = true; break } }
      if (!ok && outside.length < 6) outside.push({ el: sel(el), right: Math.round(b.right) })
    }
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    // text hidden on purpose for screen readers is not cut text
    if (own && !el.classList.contains('sr-only') && el.scrollWidth > el.clientWidth + 1 && (s.overflowX === 'hidden' || s.overflowX === 'clip') && s.textOverflow !== 'ellipsis' && s.whiteSpace === 'nowrap' && cut.length < 6) cut.push({ el: sel(el), text: el.scrollWidth, box: el.clientWidth })
    if (el.matches('button, a[href], input:not([type=hidden]), select, [role=button], [role=radio], [role=tab], [role=switch], [role=checkbox], [role=menuitem]') && !el.disabled) {
      // a control inside a label takes the label's box; a text link inside a sentence is exempt (WCAG 2.5.8)
      const box = el.closest('label') ? el.closest('label').getBoundingClientRect() : b
      const inline = el.tagName === 'A' && s.display === 'inline'
      if (!inline && Math.min(box.width, box.height) < 24 && small.length < 8) small.push({ el: sel(el), w: Math.round(box.width), h: Math.round(box.height) })
    }
  }
  out.outside = outside
  out.cutText = cut
  out.smallTargets = small
  return out
})()`

/** Marks what Tab should be able to reach (inside the open modal, when there is one) and returns how many. */
const MARK_FOCUSABLE = `(() => {
  const scope = document.querySelector('dialog[open]') || document.body
  let i = 0
  const seenRadio = new Set()
  for (const el of scope.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=true]')) {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    if (el.disabled || el.closest('[inert]') || el.getAttribute('tabindex') === '-1' || r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none') continue
    // one stop per radio group
    if (el.type === 'radio' && el.name) { if (seenRadio.has(el.name)) continue; seenRadio.add(el.name) }
    el.setAttribute('data-audit-tab', String(i++))
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
  return i
})()`

const READ_FOCUS = `(() => {
  const el = document.activeElement
  if (!el || el === document.body || el === document.documentElement) return null
  const s = getComputedStyle(el)
  const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none')
  let id = el.getAttribute('data-audit-tab')
  if (id === null && el.type === 'radio' && el.name) id = document.querySelector('input[type=radio][data-audit-tab][name="' + CSS.escape(el.name) + '"]')?.getAttribute('data-audit-tab') ?? null
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''
  const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
  return { id, el: el.tagName.toLowerCase() + cls + (label ? ' "' + label + '"' : ''), ring: !!ring, editor: !!el.closest('.cm-editor'), inModal: !!el.closest('dialog[open]') }
})()`

const UNMARK = `(() => {
  const left = []
  for (const el of document.querySelectorAll('[data-audit-tab]')) {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''
    const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
    left.push({ id: el.getAttribute('data-audit-tab'), el: el.tagName.toLowerCase() + cls + (label ? ' "' + label + '"' : '') })
    el.removeAttribute('data-audit-tab')
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
  return left
})()`

interface Stop {
  id: string | null
  el: string
  ring: boolean
  editor: boolean
  inModal: boolean
}

/** Press Tab through the page. Stops at a code editor (Tab types there) and after one full lap. */
async function keyboardPass(w: BrowserWindow): Promise<Record<string, unknown>> {
  const wc = w.webContents
  const total = await wc.executeJavaScript(MARK_FOCUSABLE, true)
  wc.focus()
  const stops: Stop[] = []
  let editor = false
  let leftModal = false
  const modal = await wc.executeJavaScript(`!!document.querySelector('dialog[open]')`, true)
  for (let i = 0; i < Math.min(total + 6, 90); i++) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await sleep(25)
    const at = (await wc.executeJavaScript(READ_FOCUS, true)) as Stop | null
    if (!at) continue
    if (at.editor) {
      editor = true
      stops.push(at)
      break
    }
    if (modal && !at.inModal) leftModal = true
    if (stops.length && at.id !== null && at.id === stops[0].id) break
    stops.push(at)
  }
  const marked = (await wc.executeJavaScript(UNMARK, true)) as { id: string; el: string }[]
  const reached = new Set(stops.map((s) => s.id))
  const unreached = editor ? [] : marked.filter((m) => !reached.has(m.id)).map((m) => m.el)
  return {
    focusable: total,
    stops: stops.length,
    noRing: stops.filter((s) => !s.ring).map((s) => s.el).slice(0, 8),
    unreached: unreached.slice(0, 8),
    unreachedCount: unreached.length,
    stoppedAtEditor: editor,
    focusLeftModal: leftModal,
    order: stops.slice(0, 14).map((s) => s.el)
  }
}

interface AXNode {
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  properties?: { name: string; value: { value?: unknown } }[]
}

const CONTROLS = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'listbox', 'option'])
const LANDMARKS = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'region', 'form'])

/** What a screen reader is given: Chromium's accessibility tree, summed up. */
async function screenReaderPass(w: BrowserWindow): Promise<Record<string, unknown>> {
  const dbg = w.webContents.debugger
  const mine = !dbg.isAttached()
  if (mine) dbg.attach('1.3')
  try {
    await dbg.sendCommand('Accessibility.enable')
    const { nodes } = (await dbg.sendCommand('Accessibility.getFullAXTree')) as { nodes: AXNode[] }
    const live = nodes.filter((n) => !n.ignored)
    const role = (n: AXNode): string => n.role?.value ?? ''
    const name = (n: AXNode): string => (n.name?.value ?? '').trim()
    const prop = (n: AXNode, k: string): unknown => n.properties?.find((p) => p.name === k)?.value.value
    const controls = live.filter((n) => CONTROLS.has(role(n)))
    const headings = live.filter((n) => role(n) === 'heading').map((n) => `h${String(prop(n, 'level') ?? '?')} ${name(n).slice(0, 40)}`)
    const levels = headings.map((h) => Number(h[1]))
    return {
      controls: controls.length,
      unnamed: controls.filter((n) => !name(n) && role(n) !== 'option').map(role),
      images: live.filter((n) => role(n) === 'image' || role(n) === 'img').length,
      unnamedImages: live.filter((n) => (role(n) === 'image' || role(n) === 'img') && !name(n)).length,
      headings: headings.slice(0, 10),
      h1: levels.filter((l) => l === 1).length,
      skippedLevel: levels.some((l, i) => i > 0 && l > levels[i - 1] + 1),
      landmarks: [...new Set(live.filter((n) => LANDMARKS.has(role(n))).map((n) => `${role(n)}${name(n) ? ` "${name(n).slice(0, 24)}"` : ''}`))],
      dialogs: live.filter((n) => role(n) === 'dialog' || role(n) === 'alertdialog').map((n) => name(n) || '(no name)'),
      liveRegions: live.filter((n) => role(n) === 'status' || role(n) === 'alert').length
    }
  } finally {
    await dbg.sendCommand('Accessibility.disable').catch(() => undefined)
    if (mine) dbg.detach()
  }
}

/** Audit the page `w` shows now and write `<dir>/audit/<name>.json`. Never throws: a failed part is noted in the file. */
export async function auditPage(w: BrowserWindow, dir: string, name: string): Promise<void> {
  if (!auditing) return
  axeSource ??= fsp.readFile(AXE, 'utf8')
  const out: Record<string, unknown> = { name }
  const wc = w.webContents
  try {
    if (!(await wc.executeJavaScript(`typeof window.axe === 'object'`, true))) await wc.executeJavaScript(`${await axeSource}; void 0`, true)
    Object.assign(out, await wc.executeJavaScript(PAGE_AUDIT, true))
  } catch (e) {
    out.pageError = (e as Error).message.slice(0, 200)
  }
  try {
    out.screenReader = await screenReaderPass(w)
  } catch (e) {
    out.screenReaderError = (e as Error).message.slice(0, 200)
  }
  try {
    out.keyboard = await keyboardPass(w)
  } catch (e) {
    out.keyboardError = (e as Error).message.slice(0, 200)
  }
  await fsp.mkdir(path.join(dir, 'audit'), { recursive: true })
  await fsp.writeFile(path.join(dir, 'audit', `${name}.json`), JSON.stringify(out, null, 1))
  console.log(`AUDIT ${name}`)
}
