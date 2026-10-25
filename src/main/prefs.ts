import fsp from 'node:fs/promises'
import path from 'node:path'
import { THEME_PREFS, type ThemePref } from '@shared/types'
import { userDataDir } from './paths'

/** App preferences (NOT the Claude config): <userData>/prefs.json. */
interface Prefs {
  theme: ThemePref
}

const DEFAULTS: Prefs = { theme: 'system' }
let cache: Prefs | null = null

const file = (): string => path.join(userDataDir(), 'prefs.json')

export async function loadPrefs(): Promise<Prefs> {
  if (cache) return cache
  try {
    const raw = JSON.parse(await fsp.readFile(file(), 'utf8')) as Partial<Prefs>
    cache = { ...DEFAULTS, ...(THEME_PREFS.includes(raw.theme as ThemePref) ? { theme: raw.theme as ThemePref } : {}) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function savePrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await loadPrefs()), ...patch }
  cache = next
  await fsp.mkdir(path.dirname(file()), { recursive: true })
  const tmp = file() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
  await fsp.rename(tmp, file())
  return next
}
