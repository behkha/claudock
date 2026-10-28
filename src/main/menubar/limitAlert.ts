import type { LiveLimits } from '@shared/api/limits'
import type { AlertPrefs } from '@shared/api/sessions'
import { formatResetTime } from '../../shared/limits.ts'
import { isPaused } from '../connect/sessionModel.ts'

/**
 * The limit alerts, from the percentages Claude Code hands the status line (src/main/domains/limits.ts). Pure, so
 * `npm test` loads it as is; src/main/menubar.ts feeds it every new reading and a tick each minute.
 *   - `limitPercent` set: one alert when a window crosses it, at most once per window. The first reading Claudock sees
 *     of a window is where it starts from, so a window already over the line at launch doesn't alert.
 *   - `limitReset` on: one alert when a window resets, only if Claude Code reported 100% in it.
 *   - nothing while alerts are paused (what was skipped stays skipped).
 */

export type LimitKey = 'fiveHour' | 'sevenDay'
const KEYS: readonly LimitKey[] = ['fiveHour', 'sevenDay']
const NAME: Record<LimitKey, string> = { fiveHour: '5-hour', sevenDay: 'weekly' }

/** Two readings belong to the same window when their reset times are this close (Claude Code may round them). */
export const SAME_WINDOW_MS = 5 * 60_000

export interface LimitAlert {
  title: string
  body: string
}

interface Track {
  resetsAt: number
  /** The last percentage read in this window. */
  last: number
  alerted: boolean
  /** Claude Code reported 100% in this window. */
  hit: boolean
  resetSaid: boolean
}

export class LimitAlertRule {
  private readonly tracks = new Map<LimitKey, Track>()
  /** Windows read at least once: before that, a reading is the starting point, not a crossing. */
  private readonly seen = new Set<LimitKey>()

  /** Feed each new reading (or the same one again, on the tick). Returns the alerts to post now. */
  update(live: LiveLimits | null, prefs: AlertPrefs, now: number): LimitAlert[] {
    const out: LimitAlert[] = []
    const quiet = isPaused(prefs, now)
    for (const key of KEYS) {
      const w = live?.[key] ?? null
      let t = this.tracks.get(key)
      if (w && w.resetsAt > now) {
        const pct = w.usedPercentage
        if (!t || Math.abs(t.resetsAt - w.resetsAt) > SAME_WINDOW_MS) {
          // the next window's first reading can come before the tick that would notice the reset
          if (t) this.sayReset(t, key, prefs, now, quiet, out)
          // a window seen for the first time: at launch it starts where it is, later it starts from 0
          t = { resetsAt: w.resetsAt, last: this.seen.has(key) ? 0 : pct, alerted: false, hit: false, resetSaid: false }
          this.tracks.set(key, t)
          this.seen.add(key)
        }
        const line = prefs.limitPercent
        if (line !== null && !t.alerted && t.last < line && pct >= line) {
          t.alerted = true
          if (!quiet) out.push({ title: `${cap(NAME[key])} limit at ${Math.round(pct)}%`, body: `Resets ${formatResetTime(w.resetsAt, now)}` })
        }
        if (pct >= 100) t.hit = true
        t.last = pct
      }
      if (t) this.sayReset(t, key, prefs, now, quiet, out)
    }
    return out
  }

  private sayReset(t: Track, key: LimitKey, prefs: AlertPrefs, now: number, quiet: boolean, out: LimitAlert[]): void {
    if (!t.hit || t.resetSaid || now < t.resetsAt) return
    t.resetSaid = true
    if (prefs.limitReset && !quiet) out.push({ title: `Your ${NAME[key]} limit has reset`, body: '' })
  }
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
