import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { HistoryRow } from '@shared/api/history'
import { cx } from '@/lib/cx'

const ROW_H = 60
const HEAD_H = 38
const OVERSCAN = 8

type Item = { kind: 'head'; key: string; label: string; y: number; h: number } | { kind: 'row'; key: string; row: HistoryRow; y: number; h: number }

function dayStart(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function groupLabel(ts: number, today: number): string {
  const days = Math.round((today - dayStart(ts)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'This week'
  return new Date(ts).toLocaleDateString('en', { month: 'long', year: 'numeric' })
}

const baseName = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() ?? p

interface Props {
  rows: HistoryRow[]
  projects: Array<{ path: string }>
  selected: number | undefined
  onSelect: (id: number) => void
}

/** Fixed-height windowing: only the rows near the viewport are in the DOM, however long the history is. */
export function HistoryList({ rows, projects, selected, onSelect }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const [focusId, setFocusId] = useState<number | null>(null)

  const { items, total, rowIndex } = useMemo(() => {
    const today = dayStart(Date.now())
    const out: Item[] = []
    const idx: number[] = [] // positions in `out` of the row items
    let y = 0
    let last = ''
    for (const row of rows) {
      const label = groupLabel(row.ts, today)
      if (label !== last) {
        out.push({ kind: 'head', key: `h-${label}`, label, y, h: HEAD_H })
        y += HEAD_H
        last = label
      }
      idx.push(out.length)
      out.push({ kind: 'row', key: `r-${row.id}`, row, y, h: ROW_H })
      y += ROW_H
    }
    return { items: out, total: y, rowIndex: idx }
  }, [rows])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewH(el.clientHeight)
    const ro = new ResizeObserver(() => setViewH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // new result set: start at the top
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setScrollTop(0)
  }, [rows])

  const first = useMemo(() => {
    let lo = 0
    let hi = items.length - 1
    const target = scrollTop - OVERSCAN * ROW_H
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (items[mid].y + items[mid].h <= target) lo = mid + 1
      else hi = mid
    }
    return lo
  }, [items, scrollTop])

  const visible: Item[] = []
  for (let i = first; i < items.length && items[i].y < scrollTop + viewH + OVERSCAN * ROW_H; i++) visible.push(items[i])

  const reveal = useCallback(
    (id: number) => {
      const el = scrollRef.current
      const i = rows.findIndex((r) => r.id === id)
      if (!el || i < 0) return
      const it = items[rowIndex[i]]
      // include the group header above the first row of a group
      const prev = items[rowIndex[i] - 1]
      const top = prev?.kind === 'head' ? prev.y : it.y
      if (top < el.scrollTop) el.scrollTop = top
      else if (it.y + it.h > el.scrollTop + el.clientHeight) el.scrollTop = it.y + it.h - el.clientHeight
    },
    [items, rowIndex, rows]
  )

  // scroll the selected row into view when it changes from outside (e.g. first load)
  const lastRevealed = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (selected !== undefined && selected !== lastRevealed.current) {
      lastRevealed.current = selected
      reveal(selected)
    }
  }, [selected, reveal])

  useEffect(() => {
    if (focusId === null) return
    scrollRef.current?.querySelector<HTMLElement>(`[data-hid="${focusId}"]`)?.focus({ preventScroll: true })
    setFocusId(null)
  }, [focusId, scrollTop, visible.length])

  function onKeyDown(e: KeyboardEvent): void {
    if (rows.length === 0) return
    const cur = rows.findIndex((r) => r.id === selected)
    const page = Math.max(1, Math.floor(viewH / ROW_H) - 1)
    let n: number
    if (e.key === 'ArrowDown') n = Math.min(rows.length - 1, cur + 1)
    else if (e.key === 'ArrowUp') n = Math.max(0, cur < 0 ? 0 : cur - 1)
    else if (e.key === 'PageDown') n = Math.min(rows.length - 1, cur + page)
    else if (e.key === 'PageUp') n = Math.max(0, cur - page)
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = rows.length - 1
    else return
    e.preventDefault()
    if (n === cur) return
    const id = rows[n].id
    lastRevealed.current = id
    onSelect(id)
    reveal(id)
    setFocusId(id)
  }

  const tabbable = selected !== undefined && rows.some((r) => r.id === selected) ? selected : rows[0]?.id

  return (
    <div
      ref={scrollRef}
      className="his-scroll"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
      role="list"
      aria-label="History"
    >
      <div className="his-inner" style={{ height: total }}>
        {visible.map((it) =>
          it.kind === 'head' ? (
            <div key={it.key} role="presentation" className="his-item his-head" style={{ top: it.y, height: it.h }}>
              {it.label}
            </div>
          ) : (
            <div
              key={it.key}
              role="listitem"
              className={cx('his-item', 'list-row', it.row.id === selected && 'list-row--selected')}
              style={{ top: it.y, height: it.h }}
            >
              <button
                type="button"
                className="list-row__main"
                data-hid={it.row.id}
                aria-current={it.row.id === selected ? 'true' : undefined}
                tabIndex={it.row.id === tabbable ? 0 : -1}
                onClick={() => onSelect(it.row.id)}
              >
                <span className="list-row__text">
                  <span className="list-row__title">{it.row.s || '(empty prompt)'}</span>
                  <span className="list-row__subtitle">
                    {it.row.p >= 0 ? baseName(projects[it.row.p]?.path ?? '') : 'No project'} ·{' '}
                    {new Date(it.row.ts).toLocaleString('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
                {it.row.pasted > 0 ? <span className="list-row__meta">{it.row.pasted} pasted</span> : null}
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
}
