import { formatCount } from './format'
import type { WrappedStats } from './api/overview'

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

/** "Opus 5", "Sonnet 5.5", "Haiku 4.5". Unknown ids come back as they are. */
export function friendlyModel(id: string): string {
  const s = id.trim().toLowerCase().replace(/^.*anthropic\./, '').replace(/\[.*\]$/, '')
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1)
  // claude-opus-5, claude-sonnet-5-5, claude-opus-4-20250514, claude-haiku-4-5-20251001
  let m = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?=-\d{8}|-v\d|:|$)/.exec(s)
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  // claude-3-5-sonnet-20241022, claude-3-opus-20240229
  m = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)/.exec(s)
  if (m) return `${cap(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ''}`
  return id
}

export const isClaudeModel = (id: string): boolean => /claude|opus|sonnet|haiku/i.test(id) && !id.startsWith('<')

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

/** The text for the X post: numbers only. */
export function shareText(s: WrappedStats): string {
  const parts = [`My Claude Code so far: ${formatCount(s.total ?? 0)} ${s.unit}`]
  if (s.sessions) parts[0] += ` across ${formatCount(s.sessions)} ${s.sessions === 1 ? 'session' : 'sessions'}`
  parts[0] += '.'
  if (s.longestSessionMs) parts.push(`Longest session: ${formatDuration(s.longestSessionMs)}.`)
  return `${parts.join(' ')}\n\nMade with Claudock ${REPO_LABEL}`
}
