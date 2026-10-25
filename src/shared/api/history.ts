/**
 * History domain contract (read-only). Owned by the data worker.
 * Entries are identified by their line number in history.jsonl.
 */
export interface HistoryRow {
  /** Line index in history.jsonl. */
  id: number
  ts: number
  /** Index into `HistoryIndex.projects`, or -1 when the entry has no project. */
  p: number
  /** First ~160 characters of the prompt, whitespace collapsed. */
  s: string
  /** Number of pasted contents. */
  pasted: number
}

export interface HistoryProject {
  path: string
  count: number
}

export interface HistoryIndex {
  /** Newest first. */
  rows: HistoryRow[]
  /** Projects in the whole file, most prompts first. */
  projects: HistoryProject[]
  /** Entries in the file, ignoring the query / project filter. */
  totalAll: number
}

export interface HistoryEntry {
  id: number
  display: string
  ts: number
  project: string | null
  sessionId: string | null
  pasted: number
  /** Names / types of pasted contents (no content). */
  pastedKinds: string[]
}

export interface HistoryApi {
  /** All entries matching the filters, newest first, in compact form. Cached by file mtime + size. */
  index(q?: string, project?: string): Promise<HistoryIndex>
  get(id: number): Promise<HistoryEntry>
}

export interface HistoryEvents {}
