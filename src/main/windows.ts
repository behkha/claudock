import { BrowserWindow, app, shell } from 'electron'
import path from 'node:path'
import icon from '../../resources/icon.png?asset'

/**
 * Claudock's windows: the main window, and what every window shares (the page it loads, the navigation guard). The
 * menu bar popover (src/main/menubar.ts) is the other window. On macOS, while the menu bar item is shown, closing the
 * main window also hides the Dock icon, and opening it again brings the icon back.
 */

const mac = process.platform === 'darwin'
const shotMode = process.env.CLAUDOCK_SHOT === '1'

let main: BrowserWindow | null = null
let hideDockOnClose = false

/** The renderer never navigates and never opens windows; http(s) links go to the system browser. */
export function guard(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
}

/** Load one of the renderer's pages: `index` (the main window) or `popover`. */
export function loadPage(win: BrowserWindow, page: 'index' | 'popover'): void {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) void win.loadURL(page === 'index' ? dev : `${dev.replace(/\/$/, '')}/${page}.html`)
  else void win.loadFile(path.join(__dirname, `../renderer/${page}.html`))
}

export const preloadPath = (): string => path.join(__dirname, '../preload/index.js')

export const mainWindow = (): BrowserWindow | null => (main && !main.isDestroyed() ? main : null)

export function createMainWindow(opts: { show?: boolean } = {}): BrowserWindow {
  // the menu bar may have hidden the Dock icon before the first window (setHideDockOnClose at launch)
  if (mac && !shotMode) void app.dock?.show()
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: !shotMode && opts.show !== false,
    title: 'Claudock',
    backgroundColor: '#FAF9F5',
    // macOS takes the icon from the bundle; Windows and Linux windows need it set (Linux has no icon otherwise).
    ...(mac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : { icon }),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !shotMode
    }
  })
  guard(win)
  win.on('closed', () => {
    if (main === win) main = null
    if (mac && hideDockOnClose && !mainWindow()) app.dock?.hide()
  })
  loadPage(win, 'index')
  main = win
  return win
}

/** Bring the main window forward, opening it (and on macOS the Dock icon) if it was closed. */
export function showMainWindow(): void {
  void (async () => {
    // the Dock icon first: a window shown while the app is still an accessory can open behind the app you are in
    if (mac && !shotMode) await app.dock?.show()
    const w = mainWindow() ?? createMainWindow()
    if (shotMode) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
    if (mac) app.focus({ steal: true })
  })()
}

/** Set by the menu bar: while its item is shown, a closed main window takes the Dock icon with it (macOS). */
export function setHideDockOnClose(on: boolean): void {
  hideDockOnClose = on
  if (mac && !on && !shotMode) void app.dock?.show()
}
