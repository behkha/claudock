/**
 * Sessions domain contract: which running Claude Code sessions are working, waiting for you or done. The data comes
 * from the session hooks "Connect to Claude Code" adds (see src/shared/api/connect.ts); without them the list is empty.
 * Read by Today and the menu bar: main can call `currentSessions()` and `onSessionsChanged()`
 * in src/main/domains/sessions.ts directly.
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
  /** Alert once per window when the 5-hour or weekly limit reaches this percentage; null = off (the default). */
  limitPercent: number | null
  /** Alert when a limit resets, only if Claude Code reported 100% in that window. Off by default. */
  limitReset: boolean
}

export interface SessionsApi {
  get(): Promise<SessionsState>
  /** Bring the session's terminal app forward (macOS, when known), else Claudock's own window. */
  show(id: string): Promise<void>
  alertPrefs(): Promise<AlertPrefs>
  /** Change some alert settings; returns all of them. */
  setAlertPrefs(patch: Partial<AlertPrefs>): Promise<AlertPrefs>
}

export interface SessionsEvents {
  /** A session changed status, appeared or went away, or the hooks were added or removed. */
  'sessions:changed': SessionsState
}
