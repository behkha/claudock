import type { AlertPrefs } from '@shared/api/sessions'
import { isPaused } from '../connect/sessionModel.ts'

/**
 * The saved-rule alert (`AlertPrefs.ruleSecret`, off by default): one alert for each rule that starts holding a
 * secret while Claudock runs. Pure, so `npm test` loads it as is; src/main/domains/permissions.ts feeds it the flagged
 * rules after every read of the rule files (once a minute, and when Permissions opens).
 *   - the first read is the starting point: a secret already on disk shows on Today's chip and never alerts;
 *   - a rule flagged later alerts once, by its id, however often the files are read again;
 *   - nothing while the alert is off or alerts are paused (what was skipped stays skipped);
 *   - a rule marked "Not a secret" is not flagged, so it is never fed in.
 */

export interface RuleAlert {
  title: string
  body: string
}

export class RuleAlertRule {
  /** The ids of every flagged rule seen so far; null until the first read. */
  private seen: Set<string> | null = null

  /** Feed the rules that are flagged now. Returns the alerts to post. */
  update(flagged: readonly { id: string; projectName: string }[], prefs: AlertPrefs, now: number): RuleAlert[] {
    const out: RuleAlert[] = []
    const first = this.seen === null
    const seen = (this.seen ??= new Set())
    const quiet = !prefs.ruleSecret || isPaused(prefs, now)
    for (const r of flagged) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      if (!first && !quiet) out.push({ title: 'A saved rule holds a secret', body: r.projectName })
    }
    return out
  }
}
