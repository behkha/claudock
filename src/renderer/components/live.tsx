import type { LimitHit, LimitWindow } from '@shared/api/limits'
import type { LiveSession } from '@shared/api/sessions'
import { formatResetTime, formatTokens, limitShown } from '@shared/limits'
import { activityText, waitText } from '@shared/sessions'
import { api } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useToast } from './Toast'
import './live.css'

/**
 * Claude Code right now, in parts Today and the menu bar popover share: a running session (waiting for you, working
 * or done) and one limit window.
 */

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** "now", "4 min", "2 h". */
export function waited(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'now'
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`
}

/** "just now", "4 min ago", "2 h ago". */
const ago = (ms: number): string => (ms < 60_000 ? 'just now' : `${waited(ms)} ago`)

/**
 * One session, named as Claude Code names it, with its folder beside it. Waiting: what it needs and for how long.
 * Working: the last thing it did, so the row moves while Claude works. Clicking it brings its terminal app forward.
 */
export function SessionRow({ s, now }: { s: LiveSession; now: number }): JSX.Element {
  const toast = useToast()
  const show = (): void => void api.sessions.show(s.id).catch((e: Error) => toast(e.message, { kind: 'error' }))
  const what = s.status === 'waiting' ? waitText(s) : s.status === 'working' && s.activity ? `${activityText(s.activity.tool)} ${ago(now - s.activity.at)}` : null
  const label = s.title ?? s.name
  // beside the title: the profile (when the list holds several) and the folder
  const where = [s.profile, s.title ? s.name : null].filter(Boolean).join(' · ')
  return (
    <li>
      <button
        type="button"
        className={cx('cc__row', `cc__row--${s.status}`)}
        onClick={show}
        title={s.cwd ?? undefined}
        aria-label={`${label}${where ? ` in ${where}` : ''}, ${s.status === 'waiting' ? `waiting ${waited(now - s.since)}` : s.status}${what ? `: ${what}` : ''}`}
      >
        <span className="cc__dot" aria-hidden />
        <span className="cc__name">
          {label}
          {where ? <span className="cc__folder">{where}</span> : null}
        </span>
        <span className="cc__when">{s.status === 'waiting' ? waited(now - s.since) : s.status}</span>
        {what ? <span className="cc__what">{what}</span> : null}
      </button>
    </li>
  )
}

/**
 * One limit window, from what Claude Code really recorded (`limitShown()`): "Limit reached" with the reset time when it
 * refused a request, else the percentage it sent to the status line with a meter, else this window's tokens from the
 * transcripts (sessions in the Claude desktop app never run the status line).
 */
export function LimitMeter({
  label,
  w,
  at,
  stale,
  hit,
  tokens,
  span,
  now
}: {
  label: string
  w: LimitWindow | null | undefined
  /** When Claude Code last sent percentages. */
  at: number | undefined
  stale: boolean
  hit: LimitHit | null | undefined
  tokens: number | undefined
  /** "last 5 hours": the stretch `tokens` covers. */
  span: string
  now: number
}): JSX.Element {
  const shown = limitShown(w, at, hit, now)
  if (shown.kind === 'tokens') {
    const value = tokens === undefined ? '–' : formatTokens(tokens)
    return (
      <div className="lim__meter" role="group" aria-label={`${label} limit: ${value} tokens in the ${span}`}>
        <div className="lim__top">
          <span>{label}</span>
          <b className={cx(tokens === undefined && 'lim__none')}>
            {value}
            <small className="lim__unit">tokens</small>
          </b>
        </div>
        <div className="lim__foot">{span}</div>
      </div>
    )
  }
  const reached = shown.kind === 'reached'
  const percent = reached ? 100 : shown.view.percent
  const fill = reached ? 100 : shown.view.fill
  const resetsAt = reached ? shown.resetsAt : (shown.view.resetsAt ?? now)
  const foot = `resets ${formatResetTime(resetsAt, now)}${!reached && stale && at ? ` · as of ${time(at)}` : ''}`
  return (
    <div className="lim__meter">
      <div className="lim__top">
        <span>{label}</span>
        <b className={cx(reached && 'lim__reached')}>{reached ? 'Limit reached' : `${percent}%`}</b>
      </div>
      <div
        className="lim__track"
        role="meter"
        aria-label={`${label} limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={reached ? undefined : (percent ?? undefined)}
        aria-valuetext={reached ? `Limit reached, ${foot}` : `${percent}% used, ${foot}`}
      >
        <div className={cx('lim__fill', !reached && stale && 'lim__fill--stale')} style={{ width: `${fill}%` }} />
      </div>
      <div className="lim__foot">{foot}</div>
    </div>
  )
}
