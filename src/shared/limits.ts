import type { LimitWindow } from './api/limits'

/** A reading older than this shows "as of <time>". */
export const LIMITS_STALE_MS = 15 * 60_000

export interface LimitView {
  /** Rounded percentage to show, or null: not sent, or the window has reset since Claude Code sent it. */
  percent: number | null
  /** 0-100 for the meter fill (0 when `percent` is null). */
  fill: number
  resetsAt: number | null
  /** The reset time has passed: Claude Code's reading belongs to the previous window. */
  reset: boolean
}

/** How to show one window at `now`. Never invents a number: a window that has reset shows no percentage. */
export function limitView(w: LimitWindow | null | undefined, now = Date.now()): LimitView {
  if (!w) return { percent: null, fill: 0, resetsAt: null, reset: false }
  if (w.resetsAt <= now) return { percent: null, fill: 0, resetsAt: w.resetsAt, reset: true }
  const percent = Math.round(w.usedPercentage)
  return { percent, fill: Math.max(0, Math.min(100, w.usedPercentage)), resetsAt: w.resetsAt, reset: false }
}

/** "16:30" today, "Mon 09:00" within a week, else "3 Nov 09:00". */
export function formatResetTime(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay = new Date(now).toDateString() === d.toDateString()
  if (sameDay) return time
  if (Math.abs(ms - now) < 6.5 * 86_400_000) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

/** "3.2M", "640k", "980". */
export function formatTokens(n: number): string {
  if (n >= 999_500_000) return `${trim(n / 1e9)}B`
  if (n >= 999_500) return `${trim(n / 1e6)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

const trim = (x: number): string => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ''))
