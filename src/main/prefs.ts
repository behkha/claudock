import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AlertPrefs } from '@shared/api/sessions'
import { THEME_PREFS, type ThemePref } from '@shared/types'
import { DEFAULT_ALERT_PREFS, normalizeAlertPrefs } from './connect/sessionModel'
import { userDataDir } from './paths'

/** App preferences (NOT the Claude config): <userData>/prefs.json. */
interface Prefs {
  theme: ThemePref
  /** The "needs me" alert rule (src/main/domains/sessions.ts). */
  alerts: AlertPrefs
  /** The menu bar item (the tray icon on Windows and Linux) is shown. On by default, except on Windows, where Connect
   *  (sessions and live limits) isn't available yet and the icon would show nothing but its tooltip. */
  menuBar: boolean
  /** The first-run reveal was left (Connect, Not now, Continue, a navigation, or an error in it), so it never shows again (src/main/firstRun.ts). */
  revealed: boolean
}

const DEFAULTS: Prefs = { theme: 'system', alerts: DEFAULT_ALERT_PREFS, menuBar: process.platform !== 'win32', revealed: false }
let cache: Prefs | null = null

const file = (): string => path.join(userDataDir(), 'prefs.json')

export async function loadPrefs(): Promise<Prefs> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await fsp.readFile(file(), 'utf8')) as Partial<Prefs>
    cache = {
      ...DEFAULTS,
      ...(THEME_PREFS.includes(raw.theme as ThemePref) ? { theme: raw.theme as ThemePref } : {}),
      alerts: normalizeAlertPrefs(raw.alerts),
      ...(typeof raw.menuBar === 'boolean' ? { menuBar: raw.menuBar } : {}),
      ...(raw.revealed === true ? { revealed: true } : {})
    }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function savePrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await loadPrefs()), ...patch }
  cache = next
  await fsp.mkdir(path.dirname(file()), { recursive: true })
  // a name of its own per save: two saves at once (theme and alerts) must not rename each other's file
  const tmp = `${file()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
  await fsp.rename(tmp, file())
  return next
}
