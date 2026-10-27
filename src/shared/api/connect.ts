/**
 * Connect domain contract: "Connect to Claude Code" adds two parts to settings.json in one write (one snapshot):
 *   - `statusLine`: the live limits status line step (src/main/domains/limits.ts), which saves the 5-hour and weekly
 *     limits Claude Code sends and runs the user's own status line unchanged.
 *   - `hooks`: session hooks that note when a session is working, waiting for you or done (src/main/domains/sessions.ts).
 * Both keep their data in Claudock's own folder, never the config folder. `disconnect()` removes both and, when nothing
 * else changed settings.json in the meantime, puts back the exact bytes it had before connecting.
 */

/** `on` / `off`, or `unsupported` on an OS where the part can't run yet (Windows). */
export type PartStatus = 'on' | 'off' | 'unsupported'

export interface ConnectStatus {
  statusLine: PartStatus
  hooks: PartStatus
}

export interface ConnectParts {
  statusLine: boolean
  hooks: boolean
}

/** One hook as it appears in settings.json. */
export interface HookLine {
  event: string
  matcher: string | null
  command: string
}

/**
 * What a change would do to settings.json, per part. For `previewConnect()`: the parts that are off now. For
 * `previewDisconnect()`: the parts that are on.
 */
export interface ConnectPreview {
  /** statusLine.command now and after; null = no status line. Null when this part doesn't change. */
  statusLine: { before: string | null; after: string | null } | null
  /** Why the status line part can't be added (statusLine isn't a command); `connect()` refuses that part. */
  statusLineProblem: string | null
  /** Hooks added (connect) or removed (disconnect). Empty when this part doesn't change. */
  hooks: HookLine[]
  /** Why the hooks can't be added (the hooks key isn't in the usual shape); `connect()` refuses that part. */
  hooksProblem: string | null
}

export interface ConnectApi {
  get(): Promise<ConnectStatus>
  previewConnect(): Promise<ConnectPreview>
  /** Add the chosen parts that are off, in one write through safeWrite. Parts already on stay as they are. */
  connect(parts: ConnectParts): Promise<{ snapshotId: string | null }>
  previewDisconnect(): Promise<ConnectPreview>
  /** Remove both parts. */
  disconnect(): Promise<{ snapshotId: string | null }>
}

export interface ConnectEvents {
  /** A part was added or removed. */
  'connect:changed': ConnectStatus
}
