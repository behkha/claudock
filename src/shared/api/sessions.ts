/**
 * Sessions domain contract: which running Claude Code sessions are working, waiting for you or done. The data comes
 * from the session hooks "Connect to Claude Code" adds (see src/shared/api/connect.ts); without them the list is empty.
 * `get()` is the open profile's, for Today; the menu bar reads every profile's through `sessionsIn()` and
 * `everySession()` in src/main/domains/sessions.ts (put together by `currentGlance()` in profiles.ts).
 */

export type SessionStatus = 'working' | 'waiting' | 'done'

/** Why a session waits: a permission prompt, a question from Claude, or an MCP server asking for input. */
export type WaitKind = 'permission' | 'question' | 'input'

export interface LiveSession {
  /** Claude Code's session id. */
  id: string
  status: SessionStatus
  /** When the session entered this status (ms since the epoch). */
  since: number
  /** The session's working folder, as Claude Code reported it. */
  cwd: string | null
  /** Last folder name of `cwd` (or the start of the id). */
  name: string
  /** The session's own name in Claude Code (the title it shows, or one set with /rename), else its first prompt. */
  title: string | null
  /** Set while waiting. */
  kind: WaitKind | null
  /** The tool a permission prompt is for ("Bash"), while waiting. */
  tool: string | null
  /** Claude Code's own notification text while waiting, when it sent one. Show `waitText()` from @shared/sessions. */
  message: string | null
  /** While working: the last tool it finished (subagents' included) and when, so the row moves as Claude works. */
  activity: { tool: string; at: number } | null
  /**
   * The context the session carries: the input and cached tokens of its latest reply, as Claude Code recorded them in
   * the transcript (sub-agents not counted). Null until a reply is recorded. Tokens, never a share of a window.
   */
  context: number | null
  /** When the session began (its transcript's first line), when known. */
  started: number | null
  /** The profile's name, in lists that hold several profiles' sessions (the menu bar popover). */
  profile?: string
}

/**
 * - `on`: the session hooks are in settings.json.
 * - `off`: not connected; `sessions` is empty.
 * - `unsupported`: not available on this OS yet (Windows).
 */
export type HooksStatus = 'on' | 'off' | 'unsupported'

export interface SessionsState {
  hooks: HooksStatus
  /** Waiting (longest first), then working, then done (latest first). */
  sessions: LiveSession[]
  /** How many sessions are waiting: the menu bar dot. */
  waiting: number
}

/** The alert settings, kept in Claudock's prefs.json: the "needs me" rule and the limit alerts (src/main/menubar/limitAlert.ts). */
export interface AlertPrefs {
  /** Alerts are paused until this time (ms since the epoch); null = not paused. */
  pausedUntil: number | null
  /** One reminder this many minutes after a session starts waiting, if it still waits; null = no reminder. */
  reminderMinutes: number | null
  /** Also alert when a working session finishes. Off by default. */
  doneAlert: boolean
  /** Play the system sound with an alert. Off by default. */
  sound: boolean
  /** Alert once per window when a limit window (5-hour, weekly, ...) reaches this percentage; null = off (the default). */
  limitPercent: number | null
  /** Alert when a limit resets, only if Claude Code reported 100% in that window. Off by default. */
  limitReset: boolean
  /**
   * Alert once when a session's context reaches this many tokens, and draw each running row's bar toward it; null = off
   * (the default). The rule is `ContextAlertRule` in src/main/menubar/contextAlert.ts.
   */
  contextLine: number | null
  /**
   * Alert when a rule saved in a project starts holding a secret (the saved-rules check, Permissions › Projects). Off
   * by default. The rule is `RuleAlertRule` in src/main/permissions/alert.ts.
   */
  ruleSecret: boolean
}

/** The sizes offered for `AlertPrefs.contextLine`. */
export const CONTEXT_LINES: readonly number[] = [150_000, 300_000, 500_000, 750_000]

/**
 * How often each offered line would have alerted: for each of `CONTEXT_LINES`, the median number of times a day a
 * session's context reached it over the last 14 days of the open profile's transcripts (the main conversations; a
 * session counts again only after falling below half the line). `perDay` is null with fewer than 3 days of sessions.
 * From the user's own transcripts; nothing is estimated.
 */
export interface ContextLineStats {
  lines: { line: number; perDay: number | null }[]
}

export interface SessionsApi {
  get(): Promise<SessionsState>
  /** Bring the session's terminal app forward (macOS, when known), else Claudock's own window. */
  show(id: string): Promise<void>
  alertPrefs(): Promise<AlertPrefs>
  /** Change some alert settings; returns all of them. */
  setAlertPrefs(patch: Partial<AlertPrefs>): Promise<AlertPrefs>
  /** "About n a day" beside each choice of "A session's context reaches". */
  contextLineStats(): Promise<ContextLineStats>
}

export interface SessionsEvents {
  /** A session changed status, appeared or went away, or the hooks were added or removed. */
  'sessions:changed': SessionsState
  /** The alert settings changed (from the menu bar popover, or a pause from the menu). */
  'sessions:alertPrefs': AlertPrefs
}
