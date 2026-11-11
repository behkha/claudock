/**
 * Limits domain contract: usage limits and token counts of the open profile, for Today. The menu bar reads every
 * profile's through `limitsIn()` in src/main/domains/limits.ts (put together by `currentGlance()` in profiles.ts).
 *
 * Three sources, each where it is true:
 *   - `tokens`: summed from the session transcripts under projects/, always available.
 *   - `hits`: a limit Claude Code reported as reached (its `quotaLimits` record, written to the transcript when a
 *     request was refused), until that window resets. Desktop-app sessions write these too.
 *   - `live`: the percentage of every window exactly as Claude Code sent it to the status line (`rate_limits`). Only
 *     with the live limits step on, and only from terminal sessions: Claude Code doesn't run the status line inside
 *     the Claude desktop app. Claudock never computes or guesses a percentage.
 *
 * Which windows exist is Claude Code's to say, not Claudock's: a window is its key in `rate_limits` / `rateLimitType`
 * (`five_hour`, `seven_day`, `spend_limit`, whatever comes next). `windows` lists the ones to draw; `limitRows()` in
 * @shared/limits turns the state into what each one shows (the hit, the percentage or the tokens) and names it.
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
  /** By Claude Code's key (`five_hour`, `seven_day`, ...): only the windows it sent. */
  windows: Record<string, LimitWindow>
}

export interface TokenWindow {
  /** Input + output + cache creation + cache read tokens. */
  tokens: number
  sessions: number
}

export interface TokenWindows {
  /** Since local midnight. */
  today: TokenWindow
  /** By window key, for the windows whose key says how long they are (`five_hour`: the last 5 hours). */
  windows: Record<string, TokenWindow>
}

/** Claude Code refused a request because this window's limit was reached. */
export interface LimitHit {
  /** When Claude Code recorded it (ms since the epoch). */
  at: number
  /** When the window resets (ms since the epoch). */
  resetsAt: number
}

/** The newest hit per window (by Claude Code's `rateLimitType`) that has not reset yet. */
export type LimitHits = Record<string, LimitHit>

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
  hits: LimitHits
  /**
   * The windows to draw, in order: the ones Claude Code sent lately or reported as reached; before it has sent any,
   * the ones its docs name (`DEFAULT_WINDOWS` in @shared/limits).
   */
  windows: string[]
}

export interface LimitsApi {
  get(): Promise<LimitsState>
}

export interface LimitsEvents {
  /** Claude Code sent new limits, or the step was added or removed. */
  'limits:changed': LimitsState
}
