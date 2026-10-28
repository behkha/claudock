import { BrowserWindow, Menu, Tray, app, nativeImage, nativeTheme, screen, type NativeImage } from 'electron'
import type { LimitsState } from '@shared/api/limits'
import type { MenubarState } from '@shared/api/menubar'
import type { SessionsState } from '@shared/api/sessions'
import { isPaused } from './connect/sessionModel'
import { postAlert } from './alerts'
import { currentLimits, onLimitsChanged } from './domains/limits'
import { alertPrefs, currentAlertPrefs, currentSessions, onSessionsChanged, setAlertPrefs } from './domains/sessions'
import { emit } from './ipcx'
import { isOpenAtLogin, loginItemAvailable, openedAtLogin, setOpenAtLogin } from './loginItem'
import { glance, type Glance } from './menubar/glance'
import { LimitAlertRule } from './menubar/limitAlert'
import { loadPrefs, savePrefs } from './prefs'
import { guard, loadPage, mainWindow, preloadPath, setHideDockOnClose, showMainWindow } from './windows'
import trayTemplate from '../../resources/trayTemplate.png?asset'
import trayWaiting from '../../resources/trayWaiting.png?asset'
import trayPlain from '../../resources/tray.png?asset'
import trayDot from '../../resources/trayDot.png?asset'

/**
 * The menu bar item (the tray icon on Windows and Linux) and its popover. The item shows the Claudock mark and the
 * higher of the two limits, and while a session waits for you the mark turns clay with a dot (src/main/menubar/glance.ts).
 * Clicking it opens the popover, a small window drawn by src/renderer/popover; right-clicking it opens a short native
 * menu. Linux trays mostly show only a menu, so there the menu is all there is. The limit alerts run here too
 * (src/main/menubar/limitAlert.ts), on every new reading and once a minute, so a reset is noticed on time.
 *
 * On macOS a template image follows the menu bar's own colour, including a light bar turned dark by the desktop
 * picture. A clay dot can't be a template, so while something waits the whole mark is drawn in clay, which reads on
 * a light and a dark bar alike.
 */

const MAC = process.platform === 'darwin'
const LINUX = process.platform === 'linux'
const SHOT = process.env.CLAUDOCK_SHOT === '1'
const TICK_MS = 60_000
const WIDTH = 320
/** A click on the item right after the popover hid itself (on that same click) must not open it again. */
const REOPEN_GUARD_MS = 250
const PAUSE_MS = 3_600_000
/** Taller than any screen: place() fits it to the work area anyway. */
const MAX_HEIGHT = 2000

let shown = true
let tray: Tray | null = null
let pop: BrowserWindow | null = null
let hiddenAt = 0
let contentHeight = 360
let limits: LimitsState | undefined
let sessions: SessionsState | undefined
let last: Glance | null = null
const rule = new LimitAlertRule()

const noop = (): void => undefined

/* ------------------------------------------------------------------ the item */

const images = new Map<string, NativeImage>()
function image(kind: Glance['icon']): NativeImage {
  const file = MAC ? (kind === 'waiting' ? trayWaiting : trayTemplate) : kind === 'waiting' ? trayDot : trayPlain
  let img = images.get(file)
  if (!img) {
    // the @2x file beside it is picked up by itself; a name ending in "Template" makes macOS tint it
    img = nativeImage.createFromPath(file)
    images.set(file, img)
  }
  return img
}

function render(force = false): void {
  const g = glance(limits, sessions, Date.now())
  const prev = last
  last = g
  if (tray) {
    if (force || g.icon !== prev?.icon) tray.setImage(image(g.icon))
    if ((force || g.title !== prev?.title) && (MAC || LINUX)) tray.setTitle(g.title, { fontType: 'monospacedDigit' })
    if (force || g.tooltip !== prev?.tooltip) tray.setToolTip(g.tooltip)
    // a Linux tray shows only its menu: rebuilt each time, so the lines and "Pause"/"Resume" stay current
    if (LINUX) tray.setContextMenu(contextMenu())
  }
}

function contextMenu(): Menu {
  const paused = isPaused(currentAlertPrefs(), Date.now())
  return Menu.buildFromTemplate([
    ...(LINUX && last ? last.tooltip.split('\n').map((label) => ({ label, enabled: false })) : []),
    ...(LINUX && last ? [{ type: 'separator' as const }] : []),
    { label: 'Open Claudock', click: () => showMainWindow() },
    {
      label: paused ? 'Resume alerts' : 'Pause alerts for 1 hour',
      click: () => void setAlertPrefs({ pausedUntil: paused ? null : Date.now() + PAUSE_MS }).then(() => render(), noop)
    },
    { type: 'separator' },
    { label: 'Quit Claudock', click: () => app.quit() }
  ])
}

function createTray(): void {
  tray = new Tray(image('plain'))
  tray.on('click', toggle)
  tray.on('right-click', () => tray?.popUpContextMenu(contextMenu()))
  render(true)
}

/** Show or remove the item to match `shown`. Screenshot mode never adds one to the real menu bar. */
function apply(): void {
  if (shown && !tray && !SHOT) createTray()
  if (!shown && tray) {
    tray.destroy()
    tray = null
    pop?.destroy()
    pop = null
  }
  setHideDockOnClose(shown && !SHOT)
}

/* ------------------------------------------------------------------ the popover */

const background = (): string => (nativeTheme.shouldUseDarkColors ? '#30302E' : '#FFFFFF')

function popover(): BrowserWindow {
  if (pop && !pop.isDestroyed()) return pop
  const w = new BrowserWindow({
    width: WIDTH,
    height: contentHeight,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Claudock',
    backgroundColor: background(),
    // a panel shows over full-screen apps without taking you out of their Space
    ...(MAC ? { type: 'panel', hiddenInMissionControl: true } : {}),
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !SHOT }
  })
  guard(w)
  if (MAC) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  w.setAlwaysOnTop(true, 'pop-up-menu')
  w.on('blur', () => {
    if (!SHOT) hide()
  })
  w.on('closed', () => {
    if (pop === w) pop = null
  })
  loadPage(w, 'popover')
  pop = w
  return w
}

/** Under the item on its display (above it for a taskbar at the bottom), kept inside the work area. */
function place(w: BrowserWindow): void {
  const b = tray?.getBounds()
  // some Linux trays report no bounds: open at the pointer instead
  const at = b && b.width > 0 ? { x: b.x + b.width / 2, top: b.y, bottom: b.y + b.height } : (({ x, y }) => ({ x, top: y, bottom: y }))(screen.getCursorScreenPoint())
  const wa = screen.getDisplayNearestPoint({ x: Math.round(at.x), y: Math.round(at.top) }).workArea
  const height = Math.max(120, Math.min(Math.round(contentHeight), wa.height - 16))
  const x = Math.min(Math.max(Math.round(at.x - WIDTH / 2), wa.x + 8), wa.x + wa.width - WIDTH - 8)
  const below = at.top < wa.y + wa.height / 2
  const y = below ? Math.max(wa.y + 4, at.bottom + 4) : Math.max(wa.y + 8, at.top - height - 6)
  w.setBounds({ x, y, width: WIDTH, height })
}

function open(): void {
  const w = popover()
  w.setBackgroundColor(background())
  place(w)
  emit('menubar:opened', null)
  // a panel takes the keyboard without bringing Claudock's other windows over the app you were in
  w.show()
  w.focus()
}

function hide(): void {
  if (!pop?.isVisible()) return
  pop.hide()
  hiddenAt = Date.now()
}

function toggle(): void {
  if (pop?.isVisible()) return hide()
  if (Date.now() - hiddenAt < REOPEN_GUARD_MS) return
  open()
}

/* ------------------------------------------------------------------ limit alerts */

function checkLimits(): void {
  const prefs = currentAlertPrefs()
  const live = limits?.step === 'on' ? limits.live : null
  for (const a of rule.update(live, prefs, Date.now())) postAlert(a, { sound: prefs.sound, onClick: () => showMainWindow() })
}

/* ------------------------------------------------------------------ state */

/** The menu bar item is shown (the pref, also in screenshot mode where no item is added). */
export const menuBarShown = (): boolean => shown

const changeListeners = new Set<() => void>()
/** For the app menu's "Show in Menu Bar" and "Open at Login" check marks. */
export const onMenuBarChanged = (cb: () => void): void => void changeListeners.add(cb)

/** Open at login as last read; null when this copy can't. For the app menu, which is built synchronously. */
let atLogin: boolean | null = null
export const openAtLoginShown = (): boolean | null => atLogin

export async function menuBarState(): Promise<MenubarState> {
  atLogin = loginItemAvailable() ? await isOpenAtLogin() : null
  return { shown, openAtLogin: atLogin }
}

export async function setMenuBar(patch: { shown?: boolean; openAtLogin?: boolean }): Promise<MenubarState> {
  if (typeof patch.shown === 'boolean' && patch.shown !== shown) {
    shown = patch.shown
    await savePrefs({ menuBar: shown })
    // hidden from its own popover: the window is the way back in
    if (!shown && !mainWindow()) showMainWindow()
    apply()
  }
  if (typeof patch.openAtLogin === 'boolean') await setOpenAtLogin(patch.openAtLogin)
  const state = await menuBarState()
  for (const cb of changeListeners) cb()
  emit('menubar:changed', state)
  return state
}

export function openWindow(palette = false): void {
  hide()
  const had = mainWindow()
  showMainWindow()
  if (!palette) return
  const w = mainWindow()
  if (!w) return
  const send = (): void => w.webContents.send('system:openPalette', null)
  if (had && !w.webContents.isLoading()) send()
  else w.webContents.once('did-finish-load', send)
}

export function fitPopover(height: number): void {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return
  contentHeight = Math.min(Math.ceil(height), MAX_HEIGHT)
  if (pop?.isVisible()) place(pop)
  else pop?.setSize(WIDTH, Math.max(120, contentHeight))
}

export const closePopover = (): void => hide()

/** The popover window, loaded, for screenshot mode (src/main/shot.ts): it is never shown there. */
export async function popoverForShots(): Promise<BrowserWindow> {
  const w = popover()
  if (w.webContents.isLoading()) await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()))
  return w
}

/** What the menu bar item shows now (its title and icon), for recording mode, where no item is added. */
export const glanceForShots = (): Glance | null => last

export { openedAtLogin }

export async function startMenuBar(): Promise<void> {
  shown = (await loadPrefs()).menuBar
  // the limit rule reads the alert settings on every tick
  await alertPrefs()
  onSessionsChanged((s) => {
    sessions = s
    render()
  })
  onLimitsChanged((l) => {
    limits = l
    render()
    checkLimits()
  })
  void currentSessions().then((s) => {
    sessions = s
    render()
  }, noop)
  void currentLimits().then((l) => {
    limits = l
    render()
    checkLimits()
  }, noop)
  setInterval(() => {
    render()
    checkLimits()
  }, TICK_MS)
  nativeTheme.on('updated', () => pop?.setBackgroundColor(background()))
  void menuBarState().then(() => changeListeners.forEach((cb) => cb()), noop)
  apply()
  // started at login: no window, so no Dock icon either
  if (MAC && shown && !SHOT && openedAtLogin()) app.dock?.hide()
}
