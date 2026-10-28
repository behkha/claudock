import type { LimitsState } from '@shared/api/limits'
import type { SessionsState } from '@shared/api/sessions'
import { limitView } from '../../shared/limits.ts'

/** What the menu bar item shows: no Electron here, so `npm test` can load it. */
export interface Glance {
  /** Text beside the icon: the higher of the two limits ("61%"), or "" when no live percentage is true right now. */
  title: string
  /** Hover text: who waits, then both limits. */
  tooltip: string
  /** `waiting` while a session waits for you: the icon with the clay dot. */
  icon: 'plain' | 'waiting'
}

/**
 * The higher limit is the one that will stop you first, so that is the number shown. A window that has reset since
 * Claude Code reported it shows no number (`limitView`), and nothing shows while the status line step is off.
 */
export function glance(limits: LimitsState | undefined, sessions: SessionsState | undefined, now: number): Glance {
  const live = limits?.step === 'on' ? limits.live : null
  const five = limitView(live?.fiveHour, now).percent
  const week = limitView(live?.sevenDay, now).percent
  const shown = [five, week].filter((p): p is number => p !== null)
  const title = shown.length ? `${Math.max(...shown)}%` : ''

  const waiting = sessions?.hooks === 'on' ? sessions.sessions.filter((s) => s.status === 'waiting') : []
  const lines: string[] = []
  if (waiting.length === 1) lines.push(`${waiting[0].name} is waiting for you`)
  else if (waiting.length > 1) lines.push(`${waiting.length} sessions are waiting for you`)
  const parts = [five !== null ? `5-hour ${five}%` : null, week !== null ? `Weekly ${week}%` : null].filter(Boolean)
  if (parts.length) lines.push(parts.join(' · '))
  return { title, tooltip: lines.length ? lines.join('\n') : 'Claudock', icon: waiting.length ? 'waiting' : 'plain' }
}
