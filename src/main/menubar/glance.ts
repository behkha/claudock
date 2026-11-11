import type { LimitsState } from '@shared/api/limits'
import type { SessionsState } from '@shared/api/sessions'
import { percentLine, topPercent } from '../../shared/limits.ts'

/** What the menu bar item shows: no Electron here, so `npm test` can load it. */
export interface Glance {
  /** Text beside the icon: the highest of the limits ("61%"), or "" when no live percentage is true right now. */
  title: string
  /** Hover text: who waits, then every limit. */
  tooltip: string
  /** `waiting` while a session waits for you: the icon with the clay dot. */
  icon: 'plain' | 'waiting'
}

/**
 * The higher limit is the one that will stop you first, so that is the number shown. A window that has reset since
 * Claude Code reported it shows no number (`limitView`), and nothing shows while the status line step is off.
 * With several profiles (`profiles`, the open one marked), the number is the open profile's, `sessions` holds every
 * profile's, and the hover text gives each profile's limits.
 */
export function glance(
  limits: LimitsState | undefined,
  sessions: SessionsState | undefined,
  now: number,
  profiles: { name: string; open: boolean; limits: LimitsState }[] = []
): Glance {
  const top = topPercent(limits, now)
  const title = top === null ? '' : `${top}%`

  const waiting = sessions?.hooks === 'on' ? sessions.sessions.filter((s) => s.status === 'waiting') : []
  const lines: string[] = []
  if (waiting.length === 1) lines.push(`${waiting[0].profile ? `${waiting[0].profile} · ` : ''}${waiting[0].name} is waiting for you`)
  else if (waiting.length > 1) lines.push(`${waiting.length} sessions are waiting for you`)
  if (profiles.length > 1) {
    for (const p of [...profiles].sort((a, b) => Number(b.open) - Number(a.open))) {
      const line = percentLine(p.limits, now)
      if (line) lines.push(`${p.name}: ${line}`)
    }
  } else {
    const line = percentLine(limits, now)
    if (line) lines.push(line)
  }
  return { title, tooltip: lines.length ? lines.join('\n') : 'Claudock', icon: waiting.length ? 'waiting' : 'plain' }
}
