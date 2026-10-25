import { useEffect, useState } from 'react'
import { THEME_PREFS, type ThemePref } from '@shared/types'
import { api, useEvent } from './api'

export function applyTheme(pref: ThemePref): void {
  document.documentElement.dataset.theme = THEME_PREFS.includes(pref) ? pref : 'system'
}

/** Syncs <html data-theme> with the stored preference and with menu changes. Mount once (Shell does). */
export function useThemeSync(): void {
  useEffect(() => {
    void api.system.getTheme().then(applyTheme, () => undefined)
  }, [])
  useEvent('system:theme', applyTheme)
}

/** The app's own theme preference, kept current with menu and in-app changes. */
export function useThemePref(): ThemePref {
  const [pref, setPref] = useState<ThemePref>(() => {
    const t = document.documentElement.dataset.theme as ThemePref
    return THEME_PREFS.includes(t) ? t : 'system'
  })
  useEffect(() => {
    void api.system.getTheme().then(setPref, () => undefined)
  }, [])
  useEvent('system:theme', setPref)
  return pref
}
