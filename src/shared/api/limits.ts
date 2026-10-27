/**
 * Limits domain contract: usage limits and token counts. Read by Overview now and by the menu bar glance next
 * (main can call `currentLimits()` and `onLimitsChanged()` in src/main/domains/limits.ts directly).
 *
 * Two sources, each where it is true:
 *   - `tokens`: summed from the session transcripts under projects/, always available.
 *   - `live`: the 5-hour and weekly percentages exactly as Claude Code sent them to the status line. Only with the
 *     live limits step on; Claudock never computes or guesses a percentage. Use `limitView()` from @shared/limits
 *     to display a window: it hides a percentage whose window has reset since.
 */

export interface LimitWindow {
  /** 0-100 as Claude Code reported it. */
  usedPercentage: number
  /** When the window resets (ms since the epoch). */
  resetsAt: number
}

export interface LiveLimits {
  /** When Claude Code last sent limits (ms since the epoch). */
  at: number
  /** Absent when Claude Code did not send this window. */
  fiveHour: LimitWindow | null
  sevenDay: LimitWindow | null
}

export interface TokenWindow {
  /** Input + output + cache creation + cache read tokens. */
  tokens: number
  sessions: number
}

export interface TokenWindows {
  fiveHour: TokenWindow
  /** Since local midnight. */
  today: TokenWindow
  sevenDay: TokenWindow
}

/**
 * - `off`: not installed; "Connect to Claude Code" (src/shared/api/connect.ts) installs it.
 * - `on`: settings.json runs Claudock's status line step.
 * - `unsupported`: this OS is not supported yet (Windows).
 */
export type LimitsStep = 'off' | 'on' | 'unsupported'

export interface LimitsState {
  step: LimitsStep
  /** Null when the step is off or Claude Code has not sent limits since it was turned on. */
  live: LiveLimits | null
  tokens: TokenWindows
}

export interface LimitsApi {
  get(): Promise<LimitsState>
}

export interface LimitsEvents {
  /** Claude Code sent new limits, or the step was added or removed. */
  'limits:changed': LimitsState
}
