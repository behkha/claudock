import type { WeekModel, WeekStats } from '@shared/api/overview'
import { friendlyModel, isClaudeModel } from '../../shared/models.ts'
import { PRICES_AS_OF, PRICES_SOURCE, priceOf, ratesFor, usdAt, type MessageUsage, type Rates } from '../../shared/prices.ts'
import { isObj, userText, type Json } from '../transcripts/parse.ts'

/**
 * The pure parts of the week card (src/main/domains/overviewShare.ts): what a transcript line adds (an assistant
 * message's usage, a prompt you typed), a local Monday-to-Sunday week's sums at API prices, the longest run of active
 * days and when the Monday recap is due. No Electron here, so `npm test` loads it as is.
 */

/** One assistant message: what its usage line says, when, and which session it belongs to. */
export interface Msg extends MessageUsage {
  t: number
  /** message.id + requestId: a resumed session's file repeats earlier messages, and each counts once. */
  key: string
  model: string
  session: string
}

/** One prompt you typed (a slash command too). */
export interface Prompt {
  t: number
  /** The line's uuid: a resumed session repeats it. */
  key: string
  session: string
}

export interface ScannedFile {
  msgs: readonly Msg[]
  prompts: readonly Prompt[]
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const timeOf = (o: Json): number => (typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN)

/** An assistant line with usage, else null (`<synthetic>` messages and lines without tokens too). */
export function msgOf(o: Json): Msg | null {
  if (o.type !== 'assistant' || !isObj(o.message) || !isObj(o.message.usage)) return null
  const model = typeof o.message.model === 'string' ? o.message.model : ''
  const t = timeOf(o)
  if (!model || model === '<synthetic>' || !Number.isFinite(t)) return null
  const u = o.message.usage
  const writes = n(u.cache_creation_input_tokens)
  // Claude Code records the split by cache lifetime; a write it didn't split is priced as the cheaper 5-minute one
  const write1h = Math.min(writes, n(isObj(u.cache_creation) ? u.cache_creation.ephemeral_1h_input_tokens : 0))
  const input = n(u.input_tokens)
  const output = n(u.output_tokens)
  const read = n(u.cache_read_input_tokens)
  if (input + output + writes + read === 0) return null
  const id = typeof o.message.id === 'string' ? o.message.id : ''
  const req = typeof o.requestId === 'string' ? o.requestId : ''
  return {
    t,
    key: id || req ? `${id}:${req}` : typeof o.uuid === 'string' ? o.uuid : `${t}:${input}:${output}`,
    model,
    session: typeof o.sessionId === 'string' ? o.sessionId : '',
    input,
    output,
    write5m: writes - write1h,
    write1h,
    read,
    fast: u.speed === 'fast',
    usOnly: u.inference_geo === 'us',
    webSearches: n(isObj(u.server_tool_use) ? u.server_tool_use.web_search_requests : 0)
  }
}

/** A prompt you typed, else null: tool results, reminders, command output, compact summaries and sub-agents' prompts are not. */
export function promptOf(o: Json): Prompt | null {
  if (o.type !== 'user' || o.isMeta === true || o.isSidechain === true || o.isCompactSummary === true || !isObj(o.message)) return null
  const t = timeOf(o)
  if (!Number.isFinite(t)) return null
  const c = o.message.content
  let typed = false
  if (typeof c === 'string') typed = userText(c) !== null
  else if (Array.isArray(c)) {
    if (c.some((b) => isObj(b) && b.type === 'tool_result')) return null
    typed = c.some((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string' && userText(b.text) !== null)
  }
  if (!typed) return null
  const session = typeof o.sessionId === 'string' ? o.sessionId : ''
  return { t, key: typeof o.uuid === 'string' ? o.uuid : `${t}:${session}`, session }
}

/* ------------------------------------------------------------------ local days and weeks */

const pad = (x: number): string => String(x).padStart(2, '0')
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local `YYYY-MM-DD`. */
export const localDate = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const parts = (date: string): [number, number, number] | null => {
  const m = DATE_RE.exec(date)
  return m ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])] : null
}

/** Local midnight starting `date`; NaN for anything else. */
export const midnightOf = (date: string): number => {
  const p = parts(date)
  return p ? new Date(p[0], p[1], p[2]).getTime() : NaN
}

/** `date` plus `days`, by the local calendar (a day with a clock change is still one day). */
export const addLocalDays = (date: string, days: number): string => {
  const p = parts(date)
  return p ? localDate(new Date(p[0], p[1], p[2] + days).getTime()) : date
}

/** Monday `YYYY-MM-DD` of the local week holding `ms`. */
export const mondayOf = (ms: number): string => {
  const d = new Date(ms)
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime())
}

export const isMonday = (date: unknown): date is string => typeof date === 'string' && Number.isFinite(midnightOf(date)) && mondayOf(midnightOf(date)) === date

/* ------------------------------------------------------------------ the week */

/** Sum the Monday `start` week from the scanned files, each message and prompt once. `earliest` is passed through. */
export function sumWeek(files: readonly ScannedFile[], start: string, now: number, earliest: string): WeekStats {
  const dates = Array.from({ length: 7 }, (_, i) => addLocalDays(start, i))
  const bounds = [...dates.map(midnightOf), midnightOf(addLocalDays(start, 7))]
  const days = dates.map((date, i) => ({ date, tokens: 0, usd: 0, future: bounds[i] > now }))
  const from = bounds[0]
  const to = bounds[7]
  const spans = new Map<string, { first: number; last: number }>()
  const touch = (id: string, t: number): void => {
    if (!id) return
    const s = spans.get(id)
    if (!s) spans.set(id, { first: t, last: t })
    else {
      s.first = Math.min(s.first, t)
      s.last = Math.max(s.last, t)
    }
  }
  const models = new Map<string, { tokens: number; usd: number | null; claude: boolean }>()
  let tokens = 0
  let usd: number | null = null
  let searches = 0
  /** The rates messages paid, by the name the Prices table gives them, with the model they belong to. */
  const paid = new Map<string, { model: string; rates: Rates }>()
  const seen = new Set<string>()
  for (const f of files) {
    for (const m of f.msgs) {
      if (m.t < from || m.t >= to || seen.has(m.key)) continue
      seen.add(m.key)
      let i = 6
      while (m.t < bounds[i]) i--
      const tk = m.input + m.output + m.write5m + m.write1h + m.read
      const name = friendlyModel(m.model)
      const price = priceOf(name)
      let cost: number | null = null
      if (price) {
        const r = ratesFor(price, m)
        paid.set(r.name, { model: name, rates: r.rates })
        cost = usdAt(r.rates, m)
        searches += m.webSearches
      }
      days[i].tokens += tk
      tokens += tk
      if (cost !== null) {
        days[i].usd += cost
        usd = (usd ?? 0) + cost
      }
      const agg = models.get(name) ?? { tokens: 0, usd: price ? 0 : null, claude: isClaudeModel(m.model) }
      agg.tokens += tk
      if (cost !== null) agg.usd = (agg.usd ?? 0) + cost
      models.set(name, agg)
      touch(m.session, m.t)
    }
  }
  let prompts = 0
  const typed = new Set<string>()
  for (const f of files) {
    for (const p of f.prompts) {
      if (p.t < from || p.t >= to || typed.has(p.key)) continue
      typed.add(p.key)
      prompts++
      touch(p.session, p.t)
    }
  }
  const ranked: WeekModel[] = [...models].sort((a, b) => b[1].tokens - a[1].tokens || a[0].localeCompare(b[0])).map(([name, m]) => ({ name, tokens: m.tokens, usd: m.usd }))
  const rank = (model: string): number => ranked.findIndex((m) => m.name === model)
  const top = [...models].filter(([, m]) => m.claude).sort((a, b) => b[1].tokens - a[1].tokens)[0]?.[0] ?? ranked[0]?.name ?? null
  let longest: number | null = null
  for (const s of spans.values()) longest = Math.max(longest ?? 0, s.last - s.first)
  return {
    start,
    end: dates[6],
    current: start === mondayOf(now),
    earliest,
    days,
    sessions: spans.size,
    prompts,
    tokens,
    longestSessionMs: longest,
    topModel: top,
    usd,
    models: ranked,
    prices: {
      asOf: PRICES_AS_OF,
      source: PRICES_SOURCE,
      rows: [...paid].sort((a, b) => rank(a[1].model) - rank(b[1].model) || a[0].length - b[0].length || a[0].localeCompare(b[0])).map(([name, p]) => ({ name, ...p.rates })),
      searches
    }
  }
}

/* ------------------------------------------------------------------ history and the recap */

/** The most consecutive calendar days among `dates` (`YYYY-MM-DD`); null when there are none. */
export function longestRun(dates: Iterable<string>): number | null {
  const days = [...new Set(dates)]
    .map((d) => {
      const p = parts(d.slice(0, 10))
      return p ? Date.UTC(p[0], p[1], p[2]) / 86_400_000 : NaN
    })
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  if (days.length === 0) return null
  let best = 1
  let run = 1
  for (let i = 1; i < days.length; i++) {
    run = days[i] === days[i - 1] + 1 ? run + 1 : 1
    best = Math.max(best, run)
  }
  return best
}

/** Local hour on Monday from which the recap is sent. */
export const RECAP_HOUR = 9

/** The week (its Monday) a recap is due for at `now`, or null: only on Mondays from 09:00, once per week (`sent`). */
export function recapDue(now: number, sent: string | null): string | null {
  const d = new Date(now)
  if (d.getDay() !== 1 || d.getHours() < RECAP_HOUR) return null
  const week = addLocalDays(localDate(now), -7)
  return sent === week ? null : week
}
