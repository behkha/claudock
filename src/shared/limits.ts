import type { LimitHit, LimitHits, LimitWindow, LimitsState, LiveLimits } from './api/limits'

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

/* ------------------------------------------------------------------ windows: named by Claude Code, read here */

const DAY_MS = 86_400_000
const UNIT_MS: Record<string, number> = { minute: 60_000, hour: 3_600_000, day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS }
const COUNTS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const MORE_COUNTS: Record<string, number> = { fourteen: 14, thirty: 30 }
const EVERY: Record<string, [number, string]> = { hourly: [1, 'hour'], daily: [1, 'day'], weekly: [1, 'week'], monthly: [1, 'month'] }

/**
 * The windows drawn before Claude Code has sent any (the step is off, or only desktop-app sessions ran): the ones its
 * status line docs name for subscribers. Once it sends `rate_limits`, what it sends decides (`rememberWindows`).
 */
export const DEFAULT_WINDOWS: readonly string[] = ['five_hour', 'seven_day']

/** A window Claude Code has left out of everything it sent for this long is gone (a window that reset is only left out until the next request). */
export const WINDOW_RETIRE_MS = 14 * DAY_MS

export interface WindowInfo {
  /** "5-hour", "Weekly", "Weekly Opus", "Spend": the label, and the X in "X limit at 80%". */
  name: string
  /** How long the window is, when its key says so (`five_hour`); null otherwise (`spend_limit`). */
  spanMs: number | null
  /** "last 5 hours": the stretch of transcript tokens that stands in for the percentage. Null when the key names no length, or names more than a length (`seven_day_opus` is one model's share). */
  tokenSpan: string | null
}

const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Reads a window's key as Claude Code writes them: `<count>_<unit>[_<what>]` (`five_hour`, `seven_day_opus`), a
 * period word (`weekly_sonnet`), or anything else (`spend_limit`). No list of known windows: a key never seen before
 * gets a name the same way.
 */
export function windowInfo(key: string): WindowInfo {
  const parts = key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  let n = 0
  let unit = ''
  let rest = parts
  const count = /^\d+$/.test(parts[0] ?? '') ? Number(parts[0]) : COUNTS.indexOf(parts[0] ?? '') + 1 || (MORE_COUNTS[parts[0] ?? ''] ?? 0)
  const u = (parts[1] ?? '').replace(/s$/, '')
  if (count > 0 && u in UNIT_MS) [n, unit, rest] = [count, u, parts.slice(2)]
  else if ((parts[0] ?? '') in EVERY) [[n, unit], rest] = [EVERY[parts[0]], parts.slice(1)]
  if (rest.length > (n ? 0 : 1) && rest[rest.length - 1] === 'limit') rest = rest.slice(0, -1)
  const what = rest.join(' ')
  if (!n) return { name: upper(what) || key, spanMs: null, tokenSpan: null }
  const spanMs = n * UNIT_MS[unit]
  const every = Object.keys(EVERY).find((k) => EVERY[k][0] * UNIT_MS[EVERY[k][1]] === spanMs && (unit !== 'hour' || n === 1))
  const base = every && every !== 'hourly' ? upper(every) : `${n}-${unit}`
  return {
    name: what ? `${base} ${upper(what)}` : base,
    spanMs,
    tokenSpan: what ? null : `last ${n === 1 ? unit : `${n} ${unit}s`}`
  }
}

/** Shorter windows first, a window before its per-model shares, windows with no length last. */
export function sortWindows(keys: Iterable<string>): string[] {
  const rank = (k: string): [number, number] => {
    const i = windowInfo(k)
    return [i.spanMs ?? Infinity, i.tokenSpan ? 0 : 1]
  }
  return [...new Set(keys)].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)]
    return ra[0] !== rb[0] ? (ra[0] < rb[0] ? -1 : 1) : ra[1] - rb[1] || (a < b ? -1 : a > b ? 1 : 0)
  })
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * What the status line step saved (`{ v: 1, at, rate_limits }`, src/main/connect/limitScript.ts) as live limits:
 * every key of `rate_limits` whose value has a percentage and a reset time. Null when it holds none.
 */
export function liveFrom(saved: unknown): LiveLimits | null {
  if (!isObj(saved) || saved.v !== 1 || typeof saved.at !== 'number' || !Number.isFinite(saved.at) || !isObj(saved.rate_limits)) return null
  const windows: Record<string, LimitWindow> = {}
  for (const [key, v] of Object.entries(saved.rate_limits)) {
    if (!isObj(v)) continue
    const p = v.used_percentage
    const r = v.resets_at
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || typeof r !== 'number' || !Number.isFinite(r) || r <= 0) continue
    windows[key] = { usedPercentage: p, resetsAt: r * 1000 }
  }
  return Object.keys(windows).length ? { at: saved.at * 1000, windows } : null
}

/**
 * Which windows Claude Code sends, remembered across readings: key to the last time it was in one. A window missing
 * from a reading stays (it may only have reset) until readings have gone `WINDOW_RETIRE_MS` without it.
 */
export function rememberWindows(seen: Record<string, number> | null, live: LiveLimits | null): Record<string, number> | null {
  if (!live) return seen
  const out: Record<string, number> = {}
  for (const [k, at] of Object.entries(seen ?? {})) if (live.at - at < WINDOW_RETIRE_MS) out[k] = at
  for (const k of Object.keys(live.windows)) out[k] = Math.max(out[k] ?? 0, live.at)
  return out
}

/** The windows to draw (`LimitsState.windows`): remembered ones, else the defaults, plus any reported as reached. */
export function windowsToDraw(seen: Record<string, number> | null, hits: LimitHits): string[] {
  const known = seen && Object.keys(seen).length ? Object.keys(seen) : DEFAULT_WINDOWS
  return sortWindows([...known, ...Object.keys(hits)])
}

/**
 * A limit Claude Code reported as reached, from a transcript line's `quotaLimits` (written when a request was refused):
 * which window (its `rateLimitType`, as is) and when it resets. Null for anything else.
 */
export function quotaHit(q: unknown, at: number): { window: string; hit: LimitHit } | null {
  if (typeof q !== 'object' || q === null || !Number.isFinite(at)) return null
  const r = q as Record<string, unknown>
  if (r.status !== 'rejected' || typeof r.resetsAt !== 'number' || !Number.isFinite(r.resetsAt) || r.resetsAt <= 0) return null
  if (typeof r.rateLimitType !== 'string' || !/^[a-z0-9_]{1,64}$/i.test(r.rateLimitType)) return null
  return { window: r.rateLimitType, hit: { at, resetsAt: r.resetsAt * 1000 } }
}

export type LimitShown =
  /** Claude Code refused a request in this window and it hasn't reset yet. */
  | { kind: 'reached'; resetsAt: number }
  /** The percentage Claude Code sent to the status line. */
  | { kind: 'percent'; view: LimitView }
  /** No percentage: the window's tokens from the transcripts. */
  | { kind: 'tokens' }

/**
 * What one window shows at `now`: a reached limit newer than the last percentage, else that percentage while its window
 * hasn't reset, else tokens. Never a number Claude Code didn't send.
 */
export function limitShown(w: LimitWindow | null | undefined, liveAt: number | undefined, hit: LimitHit | null | undefined, now = Date.now()): LimitShown {
  const view = limitView(w, now)
  if (hit && hit.resetsAt > now && (view.percent === null || hit.at >= (liveAt ?? 0))) return { kind: 'reached', resetsAt: hit.resetsAt }
  return view.percent === null ? { kind: 'tokens' } : { kind: 'percent', view }
}

/** One window as a surface draws it. */
export interface LimitRow {
  key: string
  name: string
  shown: LimitShown
  /** With `shown.kind === 'tokens'`: the tokens in `tokenSpan` (null while loading). */
  tokens: number | null
  tokenSpan: string | null
}

/**
 * Every window to draw, in order, from one profile's limits (null while they load: the default windows, no numbers).
 * A window with neither a hit, a percentage nor tokens of its own is left out.
 */
export function limitRows(l: LimitsState | null | undefined, now = Date.now()): LimitRow[] {
  const live = l?.step === 'on' ? l.live : null
  const out: LimitRow[] = []
  for (const key of l ? l.windows : DEFAULT_WINDOWS) {
    const info = windowInfo(key)
    const shown = limitShown(live?.windows[key], live?.at, l?.hits[key], now)
    // tokens stand in only where the transcripts cover the window's length (src/main/domains/limits.ts)
    if (shown.kind === 'tokens' && (!info.tokenSpan || (l && !(key in l.tokens.windows)))) continue
    out.push({ key, name: info.name, shown, tokens: l?.tokens.windows[key]?.tokens ?? null, tokenSpan: info.tokenSpan })
  }
  return out
}

/** "5-hour 42% · Weekly 61%": the windows with a live percentage right now, or "". */
export function percentLine(l: LimitsState | null | undefined, now: number): string {
  return limitRows(l, now)
    .map((r) => (r.shown.kind === 'percent' ? `${r.name} ${r.shown.view.percent}%` : null))
    .filter(Boolean)
    .join(' · ')
}

/** The highest live percentage right now (the limit that stops you first), or null. */
export function topPercent(l: LimitsState | null | undefined, now: number): number | null {
  const all = limitRows(l, now).flatMap((r) => (r.shown.kind === 'percent' && r.shown.view.percent !== null ? [r.shown.view.percent] : []))
  return all.length ? Math.max(...all) : null
}

/**
 * One profile's limits in a list of profiles (the title bar's profile menu, the popover's other profiles), from what
 * Claude Code recorded: "42%" / "5-hour 42% · Weekly 61%" (`long`), "Limit reached", else today's tokens.
 */
export function limitsLine(l: LimitsState, now: number, long: boolean): string {
  const rows = limitRows(l, now)
  if (rows.some((r) => r.shown.kind === 'reached')) return 'Limit reached'
  const top = topPercent(l, now)
  if (top !== null) return long ? percentLine(l, now) : `${top}%`
  const t = formatTokens(l.tokens.today.tokens)
  return long ? `${t} tokens today` : t
}
