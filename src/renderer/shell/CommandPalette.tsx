import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { SCREENS, type ScreenId } from '@shared/nav'
import type { SearchResult } from '@shared/types'
import { Badge, Kbd } from '@/components'
import { api } from '@/lib/api'
import { useDebounced } from '@/lib/hooks'
import { useNav } from '@/lib/nav'
import { SCREEN_ICONS } from './icons'

interface Item {
  key: string
  screen: ScreenId
  id?: string
  title: string
  subtitle?: string
  kind?: string
  group: 'Go to' | 'Results'
}

/**
 * ⌘K / Ctrl+K palette. Queries `search:query` (debounced) and also offers "Go to <screen>" for any screen
 * whose name matches. Selecting navigates with `navigate(screen, id)` so the screen receives `selectId`.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const { navigate } = useNav()
  const [q, setQ] = useState('')
  // results belong to the exact query they were fetched for; anything typed since then hides them
  const [found, setFound] = useState<{ q: string; list: SearchResult[] }>({ q: '', list: [] })
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const dq = useDebounced(q.trim(), 120)

  useEffect(() => {
    if (open) {
      returnFocus.current = document.activeElement as HTMLElement | null
      setQ('')
      setFound({ q: '', list: [] })
      setError(null)
      setActive(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      returnFocus.current?.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    if (dq.length < 2) {
      setFound({ q: '', list: [] })
      setError(null)
      return
    }
    let stale = false
    api.search.query(dq).then(
      (r) => {
        if (!stale) {
          setFound({ q: dq, list: r })
          setError(null)
        }
      },
      (e: Error) => {
        if (!stale) {
          setFound({ q: dq, list: [] })
          setError(e.message)
        }
      }
    )
    return () => {
      stale = true
    }
  }, [dq, open])

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase()
    const go: Item[] = SCREENS.filter((s) => !needle || s.label.toLowerCase().includes(needle) || s.id.includes(needle))
      .slice(0, needle ? 4 : 16)
      .map((s) => ({ key: `go-${s.id}`, screen: s.id, title: s.label, subtitle: s.group, group: 'Go to' as const }))
    const res: Item[] = (found.q === q.trim() ? found.list : []).map((r, i) => ({
      key: `r-${i}-${r.screen}-${r.id}`,
      screen: r.screen,
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      kind: r.kind,
      group: 'Results' as const
    }))
    return [...res, ...go]
  }, [q, found])

  useEffect(() => setActive(0), [items.length, dq])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null
  const shownError = error && found.q === q.trim() ? error : null

  function choose(item: Item | undefined): void {
    if (!item) return
    onClose()
    navigate(item.screen, item.id)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(items.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(items[active])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Tab') {
      e.preventDefault() // keep focus inside the palette
    }
  }

  let lastGroup = ''
  return (
    <div className="palette-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette__input-row">
          <Search size={18} strokeWidth={1.8} aria-hidden />
          <input
            ref={inputRef}
            className="palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${items[active].key}` : undefined}
            aria-label="Search"
            placeholder="Search skills, agents, rules, hooks, sessions, memory, settings…"
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} id="palette-list" role="listbox" className="palette__list" aria-label="Results">
          {shownError ? <div className="palette__empty">Search failed: {shownError}</div> : null}
          {items.length === 0 && !shownError ? <div className="palette__empty">No matches</div> : null}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null
            lastGroup = it.group
            const Icon = SCREEN_ICONS[it.screen]
            return (
              <div key={it.key}>
                {header ? (
                  <div className="palette__group" role="presentation">
                    {header}
                  </div>
                ) : null}
                <div
                  id={`palette-${it.key}`}
                  role="option"
                  aria-selected={i === active}
                  className="palette__item"
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(it)}
                >
                  <span className="palette__item-icon">
                    <Icon size={16} strokeWidth={1.8} aria-hidden />
                  </span>
                  <span className="palette__item-text">
                    <span className="palette__item-title">{it.title}</span>
                    {it.subtitle ? <span className="palette__item-sub">{it.subtitle}</span> : null}
                  </span>
                  {it.kind ? <Badge tone="oat">{it.kind}</Badge> : null}
                </div>
              </div>
            )
          })}
        </div>
        <div className="palette__footer" aria-hidden>
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <CornerDownLeft size={12} strokeWidth={1.8} /> open
          </span>
        </div>
      </div>
    </div>
  )
}
