import { useEffect, useRef } from 'react'
import { Monitor, Moon, Search, Sun } from 'lucide-react'
import { THEME_PREFS, type ThemePref } from '@shared/types'
import { formatBytes, tildify } from '@shared/format'
import { IconButton, Kbd } from '@/components'
import { api, isMac, useApi } from '@/lib/api'
import { onRefreshCounts } from '@/lib/counts'
import { useNav } from '@/lib/nav'
import { useThemePref } from '@/lib/theme'
import { ProfileMenu } from './ProfileMenu'

const THEME_ICON: Record<ThemePref, JSX.Element> = { system: <Monitor aria-hidden />, light: <Sun aria-hidden />, dark: <Moon aria-hidden /> }
const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export function TitleBar(): JSX.Element {
  const { setPaletteOpen } = useNav()
  const mac = isMac()
  const theme = useThemePref()
  const nextTheme = THEME_PREFS[(THEME_PREFS.indexOf(theme) + 1) % THEME_PREFS.length]
  const info = useApi(() => api.system.configInfo(), [])
  // after an in-app write (success toast) measure again, past the size cache: a cleanup can free a lot
  const force = useRef(false)
  const size = useApi(() => api.system.configSize(force.current ? { force: true } : undefined), [])
  const reloadSize = size.reload // stable across renders
  useEffect(
    () =>
      onRefreshCounts(() => {
        force.current = true
        reloadSize()
      }),
    [reloadSize]
  )

  const dir = info.data ? tildify(info.data.configDir, info.data.home) : '~/.claude'
  const sizeText = size.data ? formatBytes(size.data.bytes) : size.error ? 'size unavailable' : 'measuring…'

  return (
    <header className={mac ? 'titlebar titlebar--mac' : 'titlebar'}>
      <span className="titlebar__name">Claudock</span>
      <ProfileMenu dir={info.data?.configDir ?? dir} home={info.data?.home ?? ''} size={sizeText} />
      <span className="titlebar__grow" />
      <button type="button" className="titlebar__search" onClick={() => setPaletteOpen(true)} aria-label="Search (command palette)" aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}>
        <Search size={15} strokeWidth={1.8} aria-hidden />
        <span className="titlebar__search-text">Search skills, rules, sessions…</span>
        <Kbd>{mac ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>
      <IconButton
        aria-label={`Theme: ${THEME_LABEL[theme]}`}
        title={`Theme: ${THEME_LABEL[theme]}. Click for ${THEME_LABEL[nextTheme]}.`}
        icon={THEME_ICON[theme]}
        onClick={() => void api.system.setTheme(nextTheme)}
      />
    </header>
  )
}
