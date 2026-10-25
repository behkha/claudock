import { BrowserWindow, app, ipcMain, session, shell } from 'electron'
import path from 'node:path'
import { registerAll } from './domains'
import { buildMenu } from './menu'
import { initTheme, onThemeChanged } from './theme'
import { runShots } from './shot'
import { startSettingsDocsFetch } from './settingsDocs'
import icon from '../../resources/icon.png?asset'

// Keep app data separate from the Electron default and from other apps. CLAUDOCK_USER_DATA lets tests/screenshots isolate it.
app.setName('Claudock')
app.setPath('userData', process.env.CLAUDOCK_USER_DATA || path.join(app.getPath('appData'), 'Claudock'))

const shotMode = process.env.CLAUDOCK_SHOT === '1'

/**
 * Content-Security-Policy for the renderer. Production (file://): scripts, styles, images and fonts from the app only,
 * no network, no frames, no plugins. Dev adds what Vite's HMR needs (inline preamble script, websocket to the dev
 * server), and only for the dev server's own origin. The built index.html carries the same strict policy in a meta tag.
 */
function cspFor(devUrl: string | undefined): string {
  const base = ["default-src 'self'", "img-src 'self' data:", "font-src 'self' data:", "object-src 'none'", "frame-src 'none'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'"]
  if (!devUrl) return [...base, "script-src 'self'", "style-src 'self' 'unsafe-inline'", "connect-src 'self'"].join('; ')
  const u = new URL(devUrl)
  return [...base, "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", `connect-src 'self' ws://${u.host} http://${u.host}`].join('; ')
}
const mac = process.platform === 'darwin'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: !shotMode,
    title: 'Claudock',
    backgroundColor: '#FAF9F5',
    // macOS takes the icon from the bundle; Windows and Linux windows need it set (Linux has no icon otherwise).
    ...(mac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : { icon }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !shotMode
    }
  })

  // The renderer never navigates and never opens windows; http(s) links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return win
}

void app.whenReady().then(async () => {
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
  buildMenu()
  // A packaged app gets its Dock icon from the bundle; `npm run dev` would show Electron's.
  if (mac && !app.isPackaged) app.dock?.setIcon(icon)
  const win = createWindow()
  if (shotMode) {
    win.webContents.once('did-finish-load', () => {
      void runShots(win, {
        dir: process.env.CLAUDOCK_SHOT_DIR || path.join(process.cwd(), '.shots'),
        only: (process.env.CLAUDOCK_SHOT_ONLY || '').split(',').filter(Boolean)
      })
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!mac) app.quit()
})
