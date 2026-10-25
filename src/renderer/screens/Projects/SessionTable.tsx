import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SessionSummary } from '@shared/api/projects'
import { formatBytes, formatDate } from '@shared/format'

const ROW_H = 44
const MAX_VIEW_H = 460
const OVERSCAN = 6

interface Props {
  sessions: SessionSummary[]
  titles: Record<string, string>
  onOpen: (sessionId: string) => void
  /** The ids currently in (or just around) the viewport: the parent loads their titles. */
  onVisible: (ids: string[]) => void
}

/**
 * Fixed-row-height windowing (same idea as History): only the rows near the viewport are in the DOM, so a project with
 * thousands of sessions renders ~20 rows and a title batch re-renders those, not the whole table.
 */
export function SessionTable({ sessions, titles, onOpen, onVisible }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [focusIdx, setFocusIdx] = useState<number | null>(null)
  const [tabIdx, setTabIdx] = useState(0)

  const viewH = Math.min(MAX_VIEW_H, sessions.length * ROW_H)
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(sessions.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)

  // a new result set (filter changed, sessions reloaded) starts at the top
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setScrollTop(0)
    setTabIdx(0)
  }, [sessions])

  // tell the parent which titles are needed (debounced a little while the user is dragging the scrollbar)
  useEffect(() => {
    const ids = sessions.slice(first, last).map((s) => s.id)
    const t = setTimeout(() => onVisible(ids), 60)
    return () => clearTimeout(t)
  }, [sessions, first, last, onVisible])

  useEffect(() => {
    if (focusIdx === null) return
    scrollRef.current?.querySelector<HTMLElement>(`[data-idx="${focusIdx}"]`)?.focus({ preventScroll: true })
    setFocusIdx(null)
  }, [focusIdx, first, last])

  function onKeyDown(e: KeyboardEvent): void {
    if (sessions.length === 0) return
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 1)
    let n: number
    if (e.key === 'ArrowDown') n = Math.min(sessions.length - 1, tabIdx + 1)
    else if (e.key === 'ArrowUp') n = Math.max(0, tabIdx - 1)
    else if (e.key === 'PageDown') n = Math.min(sessions.length - 1, tabIdx + page)
    else if (e.key === 'PageUp') n = Math.max(0, tabIdx - page)
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = sessions.length - 1
    else return
    e.preventDefault()
    const el = scrollRef.current
    if (el) {
      const top = n * ROW_H
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
    }
    setTabIdx(n)
    setFocusIdx(n)
  }

  if (sessions.length === 0) return <p className="prj-table__empty">No session matches.</p>

  return (
    <div className="prj-table">
      <div className="prj-table__head" aria-hidden>
        <span>Title</span>
        <span>Date</span>
        <span className="prj-table__num--right">Size</span>
      </div>
      <div
        ref={scrollRef}
        className="prj-table__scroll"
        style={{ height: viewH }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        role="list"
        aria-label="Sessions"
      >
        <div className="prj-table__inner" style={{ height: sessions.length * ROW_H }}>
          {sessions.slice(first, last).map((s, k) => {
            const idx = first + k
            const loaded = s.id in titles
            const title = titles[s.id]
            return (
              <div key={s.id} role="listitem" className="prj-table__item" style={{ top: idx * ROW_H, height: ROW_H }}>
                <button
                  type="button"
                  className="prj-table__row"
                  data-idx={idx}
                  tabIndex={idx === tabIdx ? 0 : -1}
                  onClick={() => onOpen(s.id)}
                  onFocus={() => setTabIdx(idx)}
                  title={s.id}
                >
                  <span className={`prj-table__title${title ? '' : ' prj-table__title--muted'}`}>{!loaded ? 'Reading title…' : title || 'Untitled session'}</span>
                  <span className="prj-table__num">{formatDate(s.mtimeMs)}</span>
                  <span className="prj-table__num prj-table__num--right">{formatBytes(s.bytes)}</span>
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
