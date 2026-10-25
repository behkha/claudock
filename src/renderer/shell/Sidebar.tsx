import { useEffect } from 'react'
import { NAV_GROUPS, SCREENS } from '@shared/nav'
import { api, useApi } from '@/lib/api'
import { onRefreshCounts } from '@/lib/counts'
import { useNav } from '@/lib/nav'
import { SCREEN_ICONS } from './icons'

export function Sidebar(): JSX.Element {
  const { screen, navigate } = useNav()
  const counts = useApi(() => api.system.sidebarCounts(), [])
  const info = useApi(() => api.system.appInfo(), [])

  // counts can change while the app is in the background (Claude Code keeps writing): refresh on focus
  const reloadCounts = counts.reload // stable across renders
  useEffect(() => {
    window.addEventListener('focus', reloadCounts)
    const off = onRefreshCounts(reloadCounts) // after in-app writes (success toasts)
    return () => {
      window.removeEventListener('focus', reloadCounts)
      off()
    }
  }, [reloadCounts])

  return (
    <aside className="sidebar">
      <nav className="sidebar__nav" aria-label="Sections">
        {NAV_GROUPS.map((group) => (
          <div key={group} className="nav-group" role="group" aria-label={group}>
            <div className="nav-group__label" aria-hidden>
              {group}
            </div>
            <div className="nav-group__items">
              {SCREENS.filter((s) => s.group === group).map((s) => {
                const Icon = SCREEN_ICONS[s.id]
                const active = s.id === screen
                const count = counts.data?.[s.id]
                return (
                  <button key={s.id} type="button" className="nav-item" aria-current={active ? 'page' : undefined} onClick={() => navigate(s.id)}>
                    {active ? <span className="nav-item__dot" aria-hidden /> : null}
                    <span className="nav-item__icon">
                      <Icon size={16} strokeWidth={1.8} aria-hidden />
                    </span>
                    <span className="nav-item__label">{s.label}</span>
                    {count !== undefined ? <span className="nav-item__count">{count}</span> : null}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>
      <footer className="sidebar__footer">Unofficial · v{info.data?.version ?? ''}</footer>
    </aside>
  )
}
