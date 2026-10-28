import { app, ipcMain, session } from 'electron'
import path from 'node:path'
import { registerAll } from './domains'
import { buildMenu } from './menu'
import { initTheme, onThemeChanged } from './theme'
import { runRecord } from './record'
import { runShots } from './shot'
import { startSettingsDocsFetch } from './settingsDocs'
import { menuBarShown, onMenuBarChanged, openedAtLogin, startMenuBar } from './menubar'
import { installKind } from './paths'
import { createMainWindow, mainWindow, showMainWindow } from './windows'
import icon from '../../resources/icon.png?asset'

// Keep app data separate from the Electron default and from other apps. CLAUDOCK_USER_DATA lets tests/screenshots isolate it.
app.setName('Claudock')
app.setPath('userData', process.env.CLAUDOCK_USER_DATA || path.join(app.getPath('appData'), 'Claudock'))

const shotMode = process.env.CLAUDOCK_SHOT === '1'

/**
 * Content-Security-Policy for the renderer. Production (file://): scripts, styles, images and fonts from the app only,
 * no network, no frames, no plugins. Dev adds what Vite's HMR needs (inline preamble script, websocket to the dev
 * server), and only for the dev server's own origin. The built pages (index.html, popover.html) carry the same strict policy in a meta tag.
 */
function cspFor(devUrl: string | undefined): string {
  const base = ["default-src 'self'", "img-src 'self' data:", "font-src 'self' data:", "object-src 'none'", "frame-src 'none'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'"]
  if (!devUrl) return [...base, "script-src 'self'", "style-src 'self' 'unsafe-inline'", "connect-src 'self'"].join('; ')
  const u = new URL(devUrl)
  return [...base, "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", `connect-src 'self' ws://${u.host} http://${u.host}`].join('; ')
}
const mac = process.platform === 'darwin'

// One copy per user: a second `npx claudock` (or a login launch while it runs) brings the first one forward instead of
// adding a second menu bar item. A git clone skips this, so `npm run dev` can run beside an installed copy.
const single = !shotMode && installKind() !== 'dev'
const primary = !single || app.requestSingleInstanceLock()
if (!primary) app.quit()
app.on('second-instance', () => void app.whenReady().then(showMainWindow))

void app.whenReady().then(async () => {
  // the second copy only hands over to the first: no tray, no window, no login item rewrite
  if (!primary) return
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  const policy = cspFor(process.env['ELECTRON_RENDERER_URL'])
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    const headers = { ...details.responseHeaders }
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-security-policy') delete headers[k]
    headers['Content-Security-Policy'] = [policy]
    cb({ responseHeaders: headers })
  })
  await initTheme()
  registerAll(ipcMain)
  startSettingsDocsFetch()
  onThemeChanged(buildMenu)
  onMenuBarChanged(buildMenu)
  // A packaged app gets its Dock icon from the bundle; `npm run dev` would show Electron's.
  if (mac && !app.isPackaged) app.dock?.setIcon(icon)
  await startMenuBar()
  buildMenu()
  // started at login: only the menu bar item, unless it is hidden (then there would be nothing to see)
  const win = openedAtLogin() && menuBarShown() ? null : createMainWindow()
  if (shotMode && win) {
    win.webContents.once('did-finish-load', () => {
      void (process.env.CLAUDOCK_RECORD === '1' ? runRecord : runShots)(win, {
        dir: process.env.CLAUDOCK_SHOT_DIR || path.join(process.cwd(), '.shots'),
        only: (process.env.CLAUDOCK_SHOT_ONLY || '').split(',').filter(Boolean)
      })
    })
  }

  // the Dock icon (macOS): reopen the window
  app.on('activate', () => {
    if (!mainWindow()) showMainWindow()
  })
})

// With the menu bar item shown, macOS and Windows keep running for the alerts. Linux quits as before: many desktops
// show no tray at all, and Electron can't tell, so a closed window could leave Claudock running with nothing on screen.
app.on('window-all-closed', () => {
  if (mac) return
  if (process.platform === 'win32' && menuBarShown()) return
  app.quit()
})
