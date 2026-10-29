import { formatCount } from './format'
import type { WeekStats, WrappedStats } from './api/overview'
import { formatUsd, planOf, type PlanChoice } from './prices'

export { friendlyModel, isClaudeModel } from './models'

/** Pure helpers for the share card ("Wrapped"). Dates are plain `YYYY-MM-DD` strings; all arithmetic is in UTC so DST never shifts a day. */

export const HEATMAP_WEEKS = 26
export const REPO_LABEL = 'github.com/behkha/claudock'

const DAY = 86_400_000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/

function utc(date: string): number {
  const m = DATE_RE.exec(date)
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN
}

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export const isDate = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(utc(v))

export const addDays = (date: string, n: number): string => iso(utc(date) + n * DAY)

/** 0 = Sunday. */
export const weekday = (date: string): number => new Date(utc(date)).getUTCDay()

/** First day (a Sunday) of the heat map: the week that holds `asOf`, minus 25 weeks. Also the oldest day main sends. */
export const heatmapStart = (asOf: string): string => addDays(asOf, -weekday(asOf) - (HEATMAP_WEEKS - 1) * 7)


/** "48 h", "35 min", "1.5 h", "< 1 min". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–'
  const min = ms / 60_000
  if (min < 1) return '< 1 min'
  if (min < 59.5) return `${Math.round(min)} min`
  const h = ms / 3_600_000
  if (h < 10) return `${Number(h.toFixed(1))} h`
  return `${Math.round(h)} h`
}

export const formatHour = (h: number): string => `${String(h).padStart(2, '0')}:00`

/** "May 2026" from a `YYYY-MM-DD` date. */
export function formatSince(date: string): string {
  const t = utc(date)
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''
}

/** "29 Oct 2026" from a `YYYY-MM-DD` date. */
export function formatDay(date: string): string {
  const t = utc(date)
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : ''
}

/** "20 – 26 Oct", "27 Oct – 2 Nov", "29 Dec 2025 – 4 Jan 2026"; `year` adds the year to a range within one year. */
export function formatRange(start: string, end: string, year = false): string {
  const a = utc(start)
  const b = utc(end)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return ''
  const part = (t: number, o: Intl.DateTimeFormatOptions): string => new Date(t).toLocaleDateString('en', { ...o, timeZone: 'UTC' })
  const [ya, yb] = [start.slice(0, 4), end.slice(0, 4)]
  const [ma, mb] = [part(a, { month: 'short' }), part(b, { month: 'short' })]
  const [da, db] = [part(a, { day: 'numeric' }), part(b, { day: 'numeric' })]
  if (ya !== yb) return `${da} ${ma} ${ya} – ${db} ${mb} ${yb}`
  const tail = year ? ` ${yb}` : ''
  return ma === mb ? `${da} – ${db} ${mb}${tail}` : `${da} ${ma} – ${db} ${mb}${tail}`
}

/** The week's value as the card shows it ("≈ $1,012"); null when it shows tokens instead. */
export const weekValue = (w: WeekStats, plan: PlanChoice): string | null => (plan === 'hide' || w.usd === null ? null : `≈ ${formatUsd(w.usd)}`)

/** "Max 20x · $200/mo" beside the value; null for "Value only", "Hide value" or no value. */
export function planLabel(w: WeekStats, plan: PlanChoice): string | null {
  const p = planOf(plan)
  return p && weekValue(w, plan) ? `${p.name} · $${p.usd}/mo` : null
}

const SIGN_OFF = '\n\nMade with Claudock'

/** The text for the X post: numbers only. The card carries the link, so the text doesn't (social-calendar §8). */
export function shareText(s: WrappedStats): string {
  const parts = [`My Claude Code so far: ${formatCount(s.total ?? 0)} ${s.unit}`]
  if (s.sessions) parts[0] += ` across ${formatCount(s.sessions)} ${s.sessions === 1 ? 'session' : 'sessions'}`
  parts[0] += '.'
  if (s.longestSessionMs) parts.push(`Longest session: ${formatDuration(s.longestSessionMs)}.`)
  const personal = [s.peakHour === null ? '' : `Peak hour ${formatHour(s.peakHour)}`, s.topModel ? `mostly ${s.topModel}` : ''].filter(Boolean).join(', ')
  if (personal) parts.push(`${personal.charAt(0).toUpperCase()}${personal.slice(1)}.`)
  return parts.join(' ') + SIGN_OFF
}

/** The week card's X post: "My week with Claude Code, 20–26 Oct: ≈ $1,012 at API prices on Max 20x ($200/mo). 38 sessions, mostly Opus 5.5." */
export function weekText(w: WeekStats, plan: PlanChoice): string {
  const value = weekValue(w, plan)
  const p = planOf(plan)
  const range = formatRange(w.start, w.end).replace(' – ', '–')
  const sessions = `${formatCount(w.sessions)} ${w.sessions === 1 ? 'session' : 'sessions'}`
  const mostly = w.topModel ? `, mostly ${w.topModel}` : ''
  const head = value ? `${value} at API prices${p ? ` on ${p.name} ($${p.usd}/mo)` : ''}. ${sessions}${mostly}.` : `${sessions}${mostly}.`
  return `My week with Claude Code, ${range}: ${head}${SIGN_OFF}`
}
