import { Children, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { cx } from '@/lib/cx'
import { SearchField } from './SearchField'
import { Spinner } from './Spinner'

export interface ListPaneProps {
  /** Serif 24px heading. */
  title: string
  /** Small count next to the title, e.g. 12. */
  count?: number | string
  /** Buttons on the right of the title (IconButton / Button). */
  actions?: ReactNode
  search?: { value: string; onChange: (v: string) => void; placeholder?: string }
  /** Row of <Chip>s. */
  filters?: ReactNode
  /** ListRow / ListGroup children. */
  children?: ReactNode
  loading?: boolean
  error?: string | null
  /** Shown instead of rows when there are none (pass an <EmptyState>); set `isEmpty`. */
  empty?: ReactNode
  isEmpty?: boolean
  footer?: ReactNode
  /**
   * Opt-in windowing for long lists: only the rows near the viewport are mounted. Every child (rows AND groups) is
   * drawn exactly `rowHeight` px tall, so pass direct `ListRow` / `ListGroup` children (no wrapper components).
   */
  windowed?: { rowHeight: number }
  className?: string
}

const OVERSCAN = 8
/** Below this many rows windowing is not worth it and everything is rendered. */
const WINDOW_MIN = 40

const ROW = 'button.list-row__main:not(:disabled)'

/**
 * Left pane of the three-pane workbench. Rows are navigable with Up/Down/Home/End; Enter selects (a row is a button).
 * Only one row is in the tab order (roving tabindex): the selected one, else the first.
 */
export function ListPane({
  title,
  count,
  actions,
  search,
  filters,
  children,
  loading,
  error,
  empty,
  isEmpty,
  footer,
  windowed,
  className
}: ListPaneProps): JSX.Element {
  const listRef = useRef<HTMLUListElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const showList = !(loading && !children) && !isEmpty

  // windowing state (only used with `windowed`)
  const rowHeight = windowed?.rowHeight ?? 0
  const items = windowed ? Children.toArray(children) : null
  const isWindowed = !!items && rowHeight > 0 && items.length > WINDOW_MIN
  const [view, setView] = useState({ top: 0, height: 600 })
  useEffect(() => {
    const el = scrollRef.current
    if (!isWindowed || !el) return
    const read = (): void => setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }))
    read()
    el.addEventListener('scroll', read, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      ro.disconnect()
    }
  }, [isWindowed, showList])

  // keep exactly one row tabbable: the selected one, else the first. Runs only when the DOM list actually changes.
  const syncTabStop = useCallback((): void => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>(ROW)
    if (!rows || rows.length === 0) return
    const active = document.activeElement
    const current = Array.from(rows).find((r) => r === active) ?? Array.from(rows).find((r) => r.getAttribute('aria-current') === 'true') ?? rows[0]
    rows.forEach((r) => {
      const want = r === current ? 0 : -1
      if (r.tabIndex !== want) r.tabIndex = want
    })
  }, [])
  useLayoutEffect(() => {
    const ul = listRef.current
    if (!ul) return
    syncTabStop()
    const mo = new MutationObserver(syncTabStop)
    mo.observe(ul, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current'] })
    return () => mo.disconnect()
  }, [showList, syncTabStop])

  function focusRow(delta: number | 'first' | 'last'): boolean {
    if (isWindowed && (delta === 'first' || delta === 'last') && scrollRef.current) {
      // the far end is not mounted: scroll there, then focus once it is
      const el = scrollRef.current
      el.scrollTop = delta === 'first' ? 0 : el.scrollHeight
      requestAnimationFrame(() => {
        const r = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ROW) ?? [])
        const t = delta === 'first' ? r[0] : r[r.length - 1]
        t?.focus()
      })
      return true
    }
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ROW) ?? [])
    if (rows.length === 0) return false
    const i = rows.indexOf(document.activeElement as HTMLElement)
    let n: number
    if (delta === 'first') n = 0
    else if (delta === 'last') n = rows.length - 1
    else n = Math.min(rows.length - 1, Math.max(0, (i < 0 ? (delta > 0 ? -1 : rows.length) : i) + delta))
    rows.forEach((r) => (r.tabIndex = -1))
    rows[n].tabIndex = 0
    rows[n].focus()
    rows[n].scrollIntoView({ block: 'nearest' })
    return true
  }

  function onKeyDown(e: KeyboardEvent): void {
    const move = (d: number | 'first' | 'last'): void => {
      if (focusRow(d)) e.preventDefault()
    }
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Home') move('first')
    else if (e.key === 'End') move('last')
  }

  return (
    <section className={cx('list-pane', className)} aria-label={title}>
      <header className="list-pane__header">
        <div className="list-pane__titlebar">
          <h2 className="list-pane__title">{title}</h2>
          {count !== undefined ? <span className="list-pane__count">{count}</span> : null}
          <span className="list-pane__spacer" />
          {actions ? <div className="list-pane__actions">{actions}</div> : null}
        </div>
        {search ? (
          <SearchField
            value={search.value}
            onChange={search.onChange}
            placeholder={search.placeholder ?? `Filter ${title.toLowerCase()}`}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && focusRow('first')) e.preventDefault()
            }}
          />
        ) : null}
        {filters ? <div className="list-pane__filters">{filters}</div> : null}
      </header>
      {error ? (
        <p className="list-pane__error" role="alert">
          {error}
        </p>
      ) : null}
      <div ref={scrollRef} className="list-pane__scroll" onKeyDown={onKeyDown}>
        {loading && !children ? (
          <div className="list-pane__loading">
            <Spinner />
          </div>
        ) : isEmpty ? (
          empty
        ) : (
          <ul
            ref={listRef}
            role="list"
            className={cx('list-pane__rows', isWindowed && 'list-pane__rows--windowed')}
            style={isWindowed ? ({ '--row-h': `${rowHeight}px` } as React.CSSProperties) : undefined}
            aria-busy={loading || undefined}
          >
            {isWindowed && items ? <WindowRows items={items} rowHeight={rowHeight} top={view.top} height={view.height} /> : children}
          </ul>
        )}
      </div>
      {footer ? <footer className="list-pane__footer">{footer}</footer> : null}
    </section>
  )
}

export interface ListRowProps {
  title: ReactNode
  subtitle?: ReactNode
  /** Right-aligned small text (size, date, count). */
  meta?: ReactNode
  /** Icon or Badge before the title. */
  leading?: ReactNode
  /** Interactive controls (e.g. a Toggle). Rendered OUTSIDE the row button so there is no nested interactive element. */
  trailing?: ReactNode
  selected?: boolean
  /** Greyed: turned off / disabled items. */
  dimmed?: boolean
  /** Hidden-for-safety row (credentials): not selectable, shown with a lock. */
  locked?: boolean
  onSelect?: () => void
}

export function ListRow({ title, subtitle, meta, leading, trailing, selected, dimmed, locked, onSelect }: ListRowProps): JSX.Element {
  return (
    <li className={cx('list-row', selected && 'list-row--selected', dimmed && 'list-row--dimmed', locked && 'list-row--locked')}>
      <button
        type="button"
        className="list-row__main"
        aria-current={selected ? 'true' : undefined}
        disabled={locked}
        title={locked ? 'Hidden for safety' : undefined}
        onClick={onSelect}
      >
        {locked ? <Lock size={14} strokeWidth={1.8} aria-hidden className="list-row__lock" /> : leading ? <span className="list-row__leading">{leading}</span> : null}
        <span className="list-row__text">
          <span className="list-row__title">{title}</span>
          {subtitle ? <span className="list-row__subtitle">{subtitle}</span> : null}
        </span>
        {meta ? <span className="list-row__meta">{meta}</span> : null}
      </button>
      {trailing ? <div className="list-row__trailing">{trailing}</div> : null}
    </li>
  )
}

/** Small caption row that groups rows ("User skills", "Plugin skills"). */
export function ListGroup({ children }: { children: ReactNode }): JSX.Element {
  return (
    <li role="presentation" className="list-group">
      {children}
    </li>
  )
}

function WindowRows({ items, rowHeight, top, height }: { items: ReactNode[]; rowHeight: number; top: number; height: number }): JSX.Element {
  const start = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN)
  const end = Math.min(items.length, Math.ceil((top + height) / rowHeight) + OVERSCAN)
  return (
    <>
      {start > 0 ? <li role="presentation" aria-hidden style={{ height: start * rowHeight }} /> : null}
      {items.slice(start, end)}
      {end < items.length ? <li role="presentation" aria-hidden style={{ height: (items.length - end) * rowHeight }} /> : null}
    </>
  )
}
