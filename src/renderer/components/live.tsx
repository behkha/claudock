import type { LimitWindow } from '@shared/api/limits'
import type { LiveSession } from '@shared/api/sessions'
import { formatResetTime, limitView } from '@shared/limits'
import { waitText } from '@shared/sessions'
import { api } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useToast } from './Toast'
import './live.css'

/**
 * Claude Code right now, in parts the Overview card, the menu bar popover and Today share: a running session (waiting
 * for you, working or done) and one limit window.
 */

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** "now", "4 min", "2 h". */
export function waited(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'now'
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`
}

/** One session; clicking it brings its terminal app forward. */
export function SessionRow({ s, now }: { s: LiveSession; now: number }): JSX.Element {
  const toast = useToast()
  const show = (): void => void api.sessions.show(s.id).catch((e: Error) => toast(e.message, { kind: 'error' }))
  return (
    <li>
      <button
        type="button"
        className={cx('cc__row', `cc__row--${s.status}`)}
        onClick={show}
        title={s.cwd ?? undefined}
        aria-label={s.status === 'waiting' ? `${s.name}, waiting ${waited(now - s.since)}: ${waitText(s)}` : `${s.name}, ${s.status}`}
      >
        <span className="cc__dot" aria-hidden />
        <span className="cc__name">{s.name}</span>
        <span className="cc__when">{s.status === 'waiting' ? waited(now - s.since) : s.status}</span>
        {s.status === 'waiting' ? <span className="cc__what">{waitText(s)}</span> : null}
      </button>
    </li>
  )
}

/** One limit window: percentage, meter, and when it resets (or that it already has). */
export function LimitMeter({
  label,
  w,
  at,
  stale,
  waiting,
  now
}: {
  label: string
  w: LimitWindow | null | undefined
  at: number | undefined
  stale: boolean
  waiting: boolean
  now: number
}): JSX.Element {
  const v = limitView(w, now)
  // a window Claude Code did not send (dropped after its reset, or not yet) waits for the next message
  const foot =
    waiting || !v.resetsAt
      ? 'Waiting for Claude Code'
      : v.reset
        ? `reset at ${formatResetTime(v.resetsAt, now)}`
        : `resets ${formatResetTime(v.resetsAt, now)}${stale && at ? ` · as of ${time(at)}` : ''}`
  return (
    <div className="lim__meter">
      <div className="lim__top">
        <span>{label}</span>
        <b className={cx(v.percent === null && 'lim__none')}>{v.percent === null ? '–' : `${v.percent}%`}</b>
      </div>
      <div
        className="lim__track"
        role="meter"
        aria-label={`${label} limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v.percent ?? undefined}
        aria-valuetext={v.percent === null ? foot : `${v.percent}% used, ${foot}`}
      >
        <div className={cx('lim__fill', stale && 'lim__fill--stale')} style={{ width: `${v.fill}%` }} />
      </div>
      <div className="lim__foot">{foot}</div>
    </div>
  )
}
