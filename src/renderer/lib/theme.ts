import { useEffect } from 'react'
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
