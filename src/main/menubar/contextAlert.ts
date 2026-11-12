import type { AlertPrefs, LiveSession } from '@shared/api/sessions'
import { formatTokens } from '../../shared/limits.ts'
import { isPaused } from '../connect/sessionModel.ts'

/**
 * The context alert: one alert when a running session's context reaches the size the user picked
 * (`AlertPrefs.contextLine`, off by default). Pure, so `npm test` loads it as is; src/main/menubar.ts feeds it every
 * profile's sessions on each change and once a minute.
 *   - the first reading Claudock sees of a session is where it starts from, so a session already over the line at launch
 *     (or when the line is picked) doesn't alert;
 *   - one alert when a reading is at or over the line and the one before was under it;
 *   - ready again once a reading is under half the line (after a compaction);
 *   - nothing while alerts are paused (what was skipped stays skipped);
 *   - a session that is gone is forgotten.
 */

export interface ContextAlert {
  title: string
  body: string
  /** The session to bring forward when the alert is clicked. */
  id: string
}

interface Track {
  /** The last context read. */
  last: number
  /** A crossing may alert: false from an alert (or a start over the line) until a reading under half the line. */
  armed: boolean
}

/** "1 h 18 min in", "27 min in", "2 d 3 h in"; '' under a minute or when the start is unknown. */
export function runningFor(started: number | null, now: number): string {
  if (started === null || now - started < 60_000) return ''
  const min = Math.floor((now - started) / 60_000)
  if (min < 60) return `${min} min in`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min in` : `${h} h in`
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h in` : `${Math.floor(h / 24)} d in`
}

/** Title and body of the alert for one session at `line`: "Migrate settings form is at 500k context", "web · 1 h 18 min in". */
export function contextAlertText(s: LiveSession, line: number, now: number): { title: string; body: string } {
  // with several profiles the profile's name leads: "Work · web · 1 h 18 min in"
  return { title: `${s.title ?? s.name} is at ${formatTokens(line)} context`, body: [s.profile, s.name, runningFor(s.started, now)].filter(Boolean).join(' · ') }
}

export class ContextAlertRule {
  private readonly tracks = new Map<string, Track>()
  /** The line the tracks were last read against: another line starts every session from where it is. */
  private line: number | null = null

  /** Feed every running session (each profile's) on each change and on the tick. Returns the alerts to post now. */
  update(sessions: readonly LiveSession[], prefs: AlertPrefs, now: number): ContextAlert[] {
    const out: ContextAlert[] = []
    const line = prefs.contextLine
    if (line !== this.line) {
      this.line = line
      for (const t of this.tracks.values()) t.armed = line === null || t.last < line
    }
    const quiet = isPaused(prefs, now)
    const here = new Set<string>()
    for (const s of sessions) {
      here.add(s.id)
      // nothing recorded yet: the first reply's reading will be the starting point
      if (s.context === null) continue
      const t = this.tracks.get(s.id)
      if (!t) {
        this.tracks.set(s.id, { last: s.context, armed: line === null || s.context < line })
        continue
      }
      if (line !== null) {
        if (s.context < line / 2) t.armed = true
        if (t.armed && t.last < line && s.context >= line) {
          t.armed = false
          if (!quiet) out.push({ ...contextAlertText(s, line, now), id: s.id })
        }
      }
      t.last = s.context
    }
    for (const id of this.tracks.keys()) if (!here.has(id)) this.tracks.delete(id)
    return out
  }
}
