import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Share2 } from 'lucide-react'
import type { ConnectParts } from '@shared/api/connect'
import type { WrappedStats } from '@shared/api/overview'
import { formatCount } from '@shared/format'
import { heatLevels } from '@shared/heat'
import { HEATMAP_WEEKS, addDays, formatDuration, formatSince, heatmapStart, weekday } from '@shared/wrapped'
import { Button } from '@/components'
import { ConnectSheet } from '@/components/ConnectSheet'
import { api, isWindows, useApi } from '@/lib/api'
import { cx } from '@/lib/cx'
import { ShareDialog } from '@/screens/Today/ShareDialog'
import './reveal.css'

/** The heat map fills in over about 0.9 s (reveal.css); the numbers count up after it starts, ending at 1.2 s. */
const COUNT_DELAY_MS = 550
const COUNT_MS = 650
const BOTH: ConnectParts = { statusLine: true, hooks: true }

const reducedMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

/** 0 → 1 (eased) once `run` turns true; 1 from the first frame under Reduce Motion. */
function useCountUp(run: boolean): number {
  const [p, setP] = useState(0)
  const still = run && reducedMotion()
  useEffect(() => {
    if (!run || reducedMotion()) return
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number): void => {
      const x = Math.min(1, Math.max(0, (t - t0 - COUNT_DELAY_MS) / COUNT_MS))
      setP(1 - (1 - x) ** 3)
      if (x < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [run])
  return still ? 1 : p
}

/**
 * The first-run reveal (checklist item 9): the whole window under the title bar shows the user's own Claude Code
 * numbers, from the same call as Share stats, then offers Connect (the card's sheet), Not now and Share. Windows, where
 * Connect doesn't run yet, gets Continue. `onDone` leaves it for good; the buttons work while the numbers load.
 */
export function Reveal({ onDone }: { onDone: () => void }): JSX.Element {
  const wrapped = useApi(() => api.overview.wrapped(), [])
  const [want, setWant] = useState<ConnectParts | null>(null)
  const [sharing, setSharing] = useState(false)
  const title = useRef<HTMLHeadingElement>(null)

  useEffect(() => title.current?.focus(), [])

  const stats = wrapped.data ?? null
  const has = !!stats?.total
  const p = useCountUp(has)
  // Connect runs everywhere but Windows (src/main/domains/connect.ts), so the buttons are known before anything loads
  const canConnect = !isWindows()

  return (
    <main className="reveal">
      <div className="reveal__inner">
        <h1 ref={title} tabIndex={-1} className="reveal__title">
          {stats?.since ? `Your Claude Code since ${formatSince(stats.since)}` : 'Your Claude Code'}
        </h1>
        <Heat stats={stats} />
        {has && stats ? (
          <dl className="reveal__stats" aria-busy={p < 1}>
            <Stat label={stats.unit} value={formatCount(Math.round((stats.total ?? 0) * p))} />
            <Stat label="sessions" value={stats.sessions === null ? '–' : formatCount(Math.round(stats.sessions * p))} />
            <Stat label="longest session" value={stats.longestSessionMs === null ? '–' : formatDuration(stats.longestSessionMs * p)} />
            <Stat label="top model" value={stats.topModel ?? '–'} late />
          </dl>
        ) : wrapped.loading ? (
          <div className="reveal__slot" aria-hidden />
        ) : wrapped.error ? (
          <p className="find__error reveal__error" role="alert">
            {wrapped.error}
          </p>
        ) : (
          <p className="reveal__none">No sessions yet</p>
        )}
        <div className="reveal__actions">
          {canConnect ? (
            <>
              <Button variant="primary" size="lg" onClick={() => setWant(BOTH)}>
                Connect to Claude Code
              </Button>
              <Button variant="ghost" size="lg" onClick={onDone}>
                Not now
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" onClick={onDone}>
              Continue
            </Button>
          )}
          <Button variant="ghost" size="lg" className="reveal__share" icon={<Share2 size={16} strokeWidth={1.8} />} onClick={() => setSharing(true)} disabled={!has}>
            Share
          </Button>
        </div>
      </div>
      <ConnectSheet want={want} onClose={() => setWant(null)} onConnected={onDone} />
      <ShareDialog open={sharing} stats={stats} onClose={() => setSharing(false)} />
    </main>
  )
}

function Stat({ label, value, late }: { label: string; value: string; late?: boolean }): JSX.Element {
  return (
    <div className={cx('reveal__stat', late && 'reveal__late reveal__stat--text')}>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  )
}

/** 26 weeks, Sunday on top, oldest week first; it fills in week by week once the numbers arrive (reveal.css). */
function Heat({ stats }: { stats: WrappedStats | null }): JSX.Element {
  const cells: { key: string; level: number; week: number }[] = []
  let active = 0
  if (stats) {
    const start = heatmapStart(stats.asOf)
    const days = (HEATMAP_WEEKS - 1) * 7 + weekday(stats.asOf) + 1
    const level = heatLevels(Object.values(stats.daily))
    for (let i = 0; i < days; i++) {
      const date = addDays(start, i)
      const l = level(stats.daily[date] ?? 0)
      if (l > 0) active++
      cells.push({ key: date, level: l, week: Math.floor(i / 7) })
    }
  } else {
    for (let i = 0; i < HEATMAP_WEEKS * 7; i++) cells.push({ key: String(i), level: 0, week: Math.floor(i / 7) })
  }
  return (
    <div
      className={cx('reveal__heat', stats && 'reveal__heat--in')}
      role="img"
      aria-label={stats ? `Activity over the last ${HEATMAP_WEEKS} weeks: ${active} active ${active === 1 ? 'day' : 'days'}` : `Activity over the last ${HEATMAP_WEEKS} weeks`}
    >
      {cells.map((c) => (
        <i key={c.key} className={cx('reveal__cell', c.level > 0 && `reveal__cell--${c.level}`)} style={{ '--w': c.week } as CSSProperties} />
      ))}
    </div>
  )
}
