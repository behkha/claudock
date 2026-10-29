import fsp from 'node:fs/promises'
import path from 'node:path'
import type { WrappedStats } from '@shared/api/overview'
import { friendlyModel, heatmapStart, isClaudeModel, isDate } from '@shared/wrapped'
import { readJson, streamJsonl } from '../fsx'
import { configDir } from '../paths'
import { longestRun } from '../share/week'

/**
 * Read-only numbers for the share card. Source of truth is `stats-cache.json`, which Claude Code writes (version 5
 * shape, parsed defensively: any field may be missing and an unknown version is read best effort). Without it the
 * numbers come from `history.jsonl` (prompts, not messages) and a count of the session files; `projects/` is never
 * read, only listed. Nothing returned names a project, path, session or prompt.
 */

const abs = (...parts: string[]): string => path.join(configDir(), ...parts)

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

/** `YYYY-MM-DD` of a timestamp in the local time zone. */
function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function peakOf(counts: Record<string, unknown> | null): number | null {
  let best: number | null = null
  let bestN = 0
  for (const [k, v] of Object.entries(counts ?? {})) {
    const h = Number(k)
    const n = num(v)
    if (!Number.isInteger(h) || h < 0 || h > 23 || n === null || n <= 0) continue
    if (n > bestN) {
      best = h
      bestN = n
    }
  }
  return best
}

function topModelOf(tokens: Map<string, number>): string | null {
  const ids = [...tokens.keys()].filter((id) => !id.startsWith('<'))
  const claude = ids.filter(isClaudeModel)
  const pool = claude.length > 0 ? claude : ids
  let best: string | null = null
  for (const id of pool) if (best === null || (tokens.get(id) ?? 0) > (tokens.get(best) ?? 0)) best = id
  return best && (tokens.get(best) ?? 0) > 0 ? friendlyModel(best) : null
}

function modelTokens(cache: Record<string, unknown>): Map<string, number> {
  const tokens = new Map<string, number>()
  const add = (id: string, n: number | null): void => void (n && tokens.set(id, (tokens.get(id) ?? 0) + n))
  if (Array.isArray(cache.dailyModelTokens)) {
    for (const day of cache.dailyModelTokens) for (const [id, n] of Object.entries(obj(obj(day)?.tokensByModel) ?? {})) add(id, num(n))
  }
  if (tokens.size === 0) {
    for (const [id, u] of Object.entries(obj(cache.modelUsage) ?? {})) add(id, (num(obj(u)?.inputTokens) ?? 0) + (num(obj(u)?.outputTokens) ?? 0))
  }
  return tokens
}

const withinWindow = (daily: Record<string, number>, asOf: string): Record<string, number> => {
  const from = heatmapStart(asOf)
  return Object.fromEntries(Object.entries(daily).filter(([d]) => d >= from && d <= asOf))
}

const today = (): string => localDate(Date.now())

function fromCache(cache: Record<string, unknown>): WrappedStats | null {
  const daily: Record<string, number> = {}
  if (Array.isArray(cache.dailyActivity)) {
    for (const day of cache.dailyActivity) {
      const o = obj(day)
      const date = o?.date
      const n = num(o?.messageCount)
      if (isDate(date) && n !== null) daily[date.slice(0, 10)] = (daily[date.slice(0, 10)] ?? 0) + n
    }
  }
  const dates = Object.keys(daily).sort()
  const total = num(cache.totalMessages) ?? (dates.length > 0 ? Object.values(daily).reduce((a, b) => a + b, 0) : null)
  const sessions = num(cache.totalSessions)
  if (!total && !sessions) return null

  const first = typeof cache.firstSessionDate === 'string' ? new Date(cache.firstSessionDate).getTime() : NaN
  const asOf = isDate(cache.lastComputedDate) ? cache.lastComputedDate.slice(0, 10) : (dates[dates.length - 1] ?? today())
  return {
    asOf,
    since: Number.isFinite(first) ? localDate(first) : (dates[0] ?? null),
    total,
    unit: 'messages',
    sessions,
    longestSessionMs: num(obj(cache.longestSession)?.duration),
    peakHour: peakOf(obj(cache.hourCounts)),
    topModel: topModelOf(modelTokens(cache)),
    daily: withinWindow(daily, asOf),
    longestRunDays: longestRun(dates.filter((d) => daily[d] > 0))
  }
}

/** Session transcripts are `projects/<folder>/<id>.jsonl`; counting the files is cheap, reading them is not. */
async function countSessionFiles(): Promise<number | null> {
  const root = abs('projects')
  const folders = await fsp.readdir(root, { withFileTypes: true }).catch(() => null)
  if (!folders) return null
  const counts = await Promise.all(
    folders
      .filter((f) => f.isDirectory())
      .map(async (f) => (await fsp.readdir(path.join(root, f.name)).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl')).length)
  )
  return counts.reduce((a, b) => a + b, 0)
}

async function fromHistory(): Promise<WrappedStats | null> {
  const daily: Record<string, number> = {}
  const hours: Record<string, number> = {}
  let total = 0
  let first = Infinity
  try {
    for await (const { value } of streamJsonl<{ timestamp?: unknown }>(abs('history.jsonl'))) {
      const ts = num(obj(value)?.timestamp)
      if (ts === null || ts === 0) continue
      total++
      first = Math.min(first, ts)
      const d = localDate(ts)
      daily[d] = (daily[d] ?? 0) + 1
      const h = String(new Date(ts).getHours())
      hours[h] = (hours[h] ?? 0) + 1
    }
  } catch {
    return null
  }
  if (total === 0) return null
  const asOf = today()
  return {
    asOf,
    since: localDate(first),
    total,
    unit: 'prompts',
    sessions: await countSessionFiles(),
    longestSessionMs: null,
    peakHour: peakOf(hours),
    topModel: null,
    daily: withinWindow(daily, asOf),
    longestRunDays: longestRun(Object.keys(daily))
  }
}

export async function computeWrapped(): Promise<WrappedStats | null> {
  const cache = obj(await readJson(abs('stats-cache.json')))
  return (cache ? fromCache(cache) : null) ?? (await fromHistory())
}
