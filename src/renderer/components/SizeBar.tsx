import { formatBytes } from '@shared/format'
import { cx } from '@/lib/cx'

export interface SizeSegment {
  key: string
  label: string
  bytes: number
}

export interface SizeBarProps {
  segments: SizeSegment[]
  /** Defaults to the sum of the segments. Pass the folder total to show "other" remainder. */
  total?: number
  height?: number
  showLegend?: boolean
  onSelect?: (key: string) => void
  className?: string
}

// Neutral ramp for everything except the biggest segment (Clay). Every stop is a mix of the text tokens (never of
// "transparent"), and the faintest one is still >= 3:1 against --bg in both themes (non-text contrast), so the
// swatches stay visible in dark mode. Neighbouring segments are told apart by the 1px gap in the track.
const RAMP = [
  'var(--text-2)',
  'color-mix(in srgb, var(--text-2) 50%, var(--text-3))',
  'var(--text-3)',
  'color-mix(in srgb, var(--text-3) 92%, var(--bg))',
  'color-mix(in srgb, var(--text-3) 85%, var(--bg))'
]

/** Stacked horizontal bar. The biggest segment is Clay (the only accent), the rest neutral. */
export function SizeBar({ segments, total, height = 12, showLegend = true, onSelect, className }: SizeBarProps): JSX.Element {
  const sorted = [...segments].filter((s) => s.bytes > 0).sort((a, b) => b.bytes - a.bytes)
  const sum = sorted.reduce((n, s) => n + s.bytes, 0)
  const denom = Math.max(total ?? sum, sum, 1)
  const colorFor = (i: number): string => (i === 0 ? 'var(--accent)' : RAMP[Math.min(i - 1, RAMP.length - 1)])
  const pct = (b: number): string => `${((b / denom) * 100).toFixed(b / denom < 0.01 ? 1 : 0)}%`

  return (
    <div className={cx('sizebar', className)}>
      <div
        className="sizebar__track"
        style={{ height }}
        role="img"
        aria-label={sorted.map((s) => `${s.label} ${formatBytes(s.bytes)}`).join(', ') || 'Empty'}
      >
        {sorted.map((s, i) => (
          <span
            key={s.key}
            className="sizebar__seg"
            style={{ width: `${(s.bytes / denom) * 100}%`, background: colorFor(i), minWidth: 2 }}
            title={`${s.label} · ${formatBytes(s.bytes)}`}
          />
        ))}
      </div>
      {showLegend ? (
        <ul role="list" className="sizebar__legend">
          {sorted.map((s, i) => (
            <li key={s.key} className="sizebar__item">
              <span className="sizebar__swatch" style={{ background: colorFor(i) }} aria-hidden />
              {onSelect ? (
                <button type="button" className="sizebar__label sizebar__label--button" onClick={() => onSelect(s.key)}>
                  {s.label}
                </button>
              ) : (
                <span className="sizebar__label">{s.label}</span>
              )}
              <span className="sizebar__size">{formatBytes(s.bytes)}</span>
              <span className="sizebar__pct">{pct(s.bytes)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
