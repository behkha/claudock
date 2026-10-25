import { nativeTheme } from 'electron'
import { THEME_PREFS, type ThemePref } from '@shared/types'
import { emit } from './ipcx'
import { loadPrefs, savePrefs } from './prefs'

const listeners = new Set<(t: ThemePref) => void>()
export const onThemeChanged = (cb: (t: ThemePref) => void): void => void listeners.add(cb)

let current: ThemePref = 'system'
export const currentTheme = (): ThemePref => current

/** Apply (and optionally persist) a theme pref: native chrome, renderer, menu. */
export async function setTheme(pref: ThemePref, persist = true): Promise<ThemePref> {
  if (!THEME_PREFS.includes(pref)) throw new Error('Invalid theme')
  current = pref
  nativeTheme.themeSource = pref
  if (persist) await savePrefs({ theme: pref })
  emit('system:theme', pref)
  listeners.forEach((cb) => cb(pref))
  return pref
}

export async function initTheme(): Promise<void> {
  current = (await loadPrefs()).theme
  nativeTheme.themeSource = current
}
