/**
 * Projects domain contract. Owned by the data worker.
 *
 * A project is one folder under `projects/` in the config dir. `id` is that (encoded) folder name; the real
 * folder path is read from the `cwd` field inside the transcripts, because the folder name is a lossy encoding.
 *
 * selectId understood by the Projects screen: `<projectId>` or `<projectId>/<sessionId>`.
 */
export interface ProjectSummary {
  /** Encoded folder name under projects/. */
  id: string
  /** Basename of the real folder (falls back to the encoded name). */
  name: string
  /** Real folder path from the transcripts' `cwd` (or history / .claude.json), null when unknown. */
  path: string | null
  /** True when `path` is known and no longer exists on disk. */
  missing: boolean
  sessions: number
  /** Stat sum of the files directly inside the project folder. `sizes()` returns the full size. */
  bytes: number
  /** Newest transcript mtime (ms). */
  lastActiveMs: number
  hasMemory: boolean
}

export interface SessionSummary {
  /** Session id = transcript file name without `.jsonl`. */
  id: string
  /** Config-relative path of the transcript. */
  rel: string
  bytes: number
  mtimeMs: number
  /** A sibling folder named by the session id exists (sub-agent output, tool results). */
  hasSidecar: boolean
}

export type TranscriptKind = 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'command'

export interface TranscriptEntry {
  /** Byte offset of the line in the file plus the index inside the line: unique within a session. */
  key: string
  kind: TranscriptKind
  /** Message text, thinking text, tool-result preview or command line. */
  text: string
  /** Tool name for tool_use. */
  name?: string
  /** One-line summary of a tool call's input. */
  summary?: string
  /** Number of characters in the original text (when `truncated`). */
  chars?: number
  truncated?: boolean
  error?: boolean
  ts?: string
}

export interface SessionPage {
  entries: TranscriptEntry[]
  /** Byte offset to pass as `offset` for the next page; null at the end of the file. */
  nextOffset: number | null
  totalBytes: number
  /** Lines that could not be parsed or were too large to show. */
  skipped: number
}

export interface CleanupPreview {
  count: number
  /** Transcripts plus their sibling folders. */
  bytes: number
  sessionIds: string[]
}

export interface ProjectsApi {
  list(): Promise<ProjectSummary[]>
  /** Full sizes (transcripts, sibling folders, memory) per project id. Slower than `list`; cached ~60 s. */
  sizes(): Promise<Record<string, number>>
  sessions(projectId: string): Promise<SessionSummary[]>
  /** First real user prompt of each session (head of the file only), for the given ids. */
  titles(projectId: string, sessionIds: string[]): Promise<Record<string, string>>
  /** Read one page of a transcript starting at byte `offset`, about `limit` entries. */
  readSession(projectId: string, sessionId: string, offset: number, limit: number): Promise<SessionPage>
  /** Move the transcript and its sibling folder to the Trash. */
  trashSession(projectId: string, sessionId: string): Promise<void>
  cleanupPreview(projectId: string, days: number): Promise<CleanupPreview>
  /**
   * Move transcripts older than `days` (and their sibling folders) to the Trash. Pass the `sessionIds` the user
   * confirmed in the preview: only those that are still older than `days` are trashed, so a session that was resumed in
   * the meantime is kept. Without `sessionIds` the list is recomputed at call time.
   */
  cleanup(projectId: string, days: number, sessionIds?: string[]): Promise<CleanupPreview>
  /** Move the whole project folder (transcripts, memory and all) to the Trash. */
  trashProject(projectId: string): Promise<void>
  /** Show the real project folder in Finder / Explorer. */
  revealFolder(projectId: string): Promise<void>
}

export interface ProjectsEvents {}
