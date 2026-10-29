import type { SessionPage } from './projects'

/**
 * Session archive contract (the Sessions screen). Claude Code deletes a transcript `cleanupPeriodDays` (30) days after it
 * was last touched; the archive keeps every session of every profile in Claudock's own data folder, and the Sessions
 * screen lists, searches, resumes, exports and deletes them, whether Claude Code still has them or not.
 *
 * A session's `key` is `<project folder>/<session id>`, e.g. `-Users-me-code-app/7c1e9a42-…`.
 * selectId understood by the Sessions screen: `<key>`, or `<key>@<byte offset>` to open a transcript at a search hit.
 */
export interface ArchivedSession {
  key: string
  /** The transcript's id, what `claude --resume` takes. */
  id: string
  projectId: string
  /** Claude Code's name for it (a custom title), else its first prompt; '' while it hasn't been read yet or has neither. */
  title: string
  /** The folder it ran in, from the transcript; null when unknown. */
  cwd: string | null
  /** First and last message (ms); null when it has none. */
  startMs: number | null
  endMs: number | null
  /** When Claude Code last wrote it (ms), for sessions without messages. */
  mtimeMs: number
  /** Prompts plus Claude's replies. */
  messages: number
  bytes: number
  /** Claude Code deleted its file: only the archive has it now. */
  archived: boolean
  /** Not read yet (the first pass over a large folder). */
  pending: boolean
}

export interface ArchiveStatus {
  /** New sessions are being archived in this profile. */
  on: boolean
  /** A development build looking at a real folder: nothing is archived there. */
  readOnly: boolean
  sessions: number
  /** Sessions only the archive has. */
  archived: number
  /** Disk the archive takes beyond Claude Code's folder: what Claude Code deleted, and copies where links aren't possible. */
  bytes: number
  /** Reading transcripts for search: how many of how many; null when caught up. */
  indexing: { done: number; total: number } | null
}

export interface ArchiveList {
  sessions: ArchivedSession[]
  status: ArchiveStatus
}

export interface SearchHit {
  key: string
  /** The prompt or reply that matched, cut around the match. */
  snippet: string
  /** [start, end) of each match in `snippet`. */
  marks: Array<[number, number]>
  /** Byte offset of the transcript line holding it; -1 when only the title matched. */
  offset: number
  /** Prompts and replies that matched. */
  count: number
}

export interface ArchiveApi {
  /** Every session of the open profile, newest first, after a quick look for new ones. */
  list(): Promise<ArchiveList>
  /** Sessions whose title, prompts or replies hold every word of `query` ("quoted words" together), newest first. */
  search(query: string): Promise<SearchHit[]>
  /** One page of a session's transcript from byte `offset`, from Claude Code's file or the archive's. */
  read(key: string, offset: number, limit: number): Promise<SessionPage>
  /**
   * Copy the command that resumes the session from any folder (its `cd`, the profile's CLAUDE_CONFIG_DIR,
   * `claude --resume`) and return it. A session Claude Code deleted is put back in `projects/` first (`restored`).
   */
  resume(key: string): Promise<{ command: string; restored: boolean }>
  /** Save the session as Markdown where the user picks; null when they cancel. */
  exportMarkdown(key: string): Promise<{ path: string } | null>
  /** Move the session to the Trash: Claude Code's file and the archive's. */
  trash(key: string): Promise<void>
  /** Start or stop archiving this profile. Stopping can also move the sessions only the archive has to the Trash. */
  setOn(on: boolean, trashArchived?: boolean): Promise<ArchiveStatus>
  /** Show the profile's archive folder in Finder / Explorer. */
  reveal(): Promise<void>
}

export interface ArchiveEvents {
  /** The open profile's sessions changed (new, deleted by Claude Code, read for search). */
  'archive:changed': ArchiveStatus
}
