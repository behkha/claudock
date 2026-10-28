import type { TodayDay } from '@shared/api/today'

/**
 * Today's sessions and the last 7 days, summed from the token lines the limits scan keeps per transcript
 * (src/main/domains/limits.ts). No Electron or file access here, so `npm test` loads it as is.
 */

/** One assistant message with its usage, as the limits scan keeps it. */
export interface UsageEntry {
  t: number
  /** message.id + requestId: the same message repeated in a resumed session's file counts once. */
  key: string
  tokens: number
  /** sessionId on the line; '' when missing. */
  session: string
}

/** One scanned transcript. */
export interface UsageFile {
  /** Folder under projects/. */
  project: string
  /** The session the file belongs to: its own name, or the session folder a subagent's file sits in. */
  session: string
  cwd: string | null
  entries: readonly UsageEntry[]
}

export interface SessionSum {
  id: string
  projectId: string
  cwd: string | null
  first: number
  last: number
  tokens: number
}

export interface Activity {
  /** Sessions with a message since local midnight, latest first. */
  sessions: SessionSum[]
  /** The last 7 local days, oldest first. */
  days: TodayDay[]
  tokens: number
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** Local `YYYY-MM-DD`. */
export const localDate = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function sumActivity(files: Iterable<UsageFile>, now: number): Activity {
  const today = new Date(now)
  // local midnights, so a day with a clock change is still one day
  const starts = Array.from({ length: 7 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + i).getTime())
  const days: TodayDay[] = starts.map((s) => ({ date: localDate(s), tokens: 0 }))
  const midnight = starts[6]
  const sessions = new Map<string, SessionSum>()
  const seen = new Set<string>()
  for (const f of files) {
    for (const e of f.entries) {
      if (e.t < starts[0] || e.t > now || seen.has(e.key)) continue
      seen.add(e.key)
      let i = 6
      while (e.t < starts[i]) i--
      days[i].tokens += e.tokens
      if (e.t < midnight) continue
      const id = e.session || f.session
      const s = sessions.get(id)
      if (!s) sessions.set(id, { id, projectId: f.project, cwd: f.cwd, first: e.t, last: e.t, tokens: e.tokens })
      else {
        s.first = Math.min(s.first, e.t)
        s.last = Math.max(s.last, e.t)
        s.tokens += e.tokens
        // the session's own file names its project and folder; a subagent's may be read first
        if (f.session === id) {
          s.projectId = f.project
          s.cwd = f.cwd ?? s.cwd
        } else s.cwd ??= f.cwd
      }
    }
  }
  return {
    sessions: [...sessions.values()].sort((a, b) => b.last - a.last || a.id.localeCompare(b.id)),
    days,
    tokens: days[6].tokens
  }
}
