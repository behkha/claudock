/**
 * Today domain contract: the home screen's history part. Today's sessions and the last 7 days of tokens, summed from
 * the transcripts under projects/ (the same lines the limits scan reads, src/main/domains/limits.ts). Running
 * sessions and limits come from their own domains.
 */

export interface TodaySession {
  /** Claude Code's session id (the transcript's file name). */
  id: string
  /** Folder under projects/: Projects opens `<projectId>/<id>`. */
  projectId: string
  /** Last folder name of the session's working folder. */
  folder: string
  /** The session's own name in Claude Code, else its first prompt; '' when it has neither. */
  title: string
  /** First and last message today (ms since the epoch). */
  first: number
  last: number
  tokens: number
}

export interface TodayDay {
  /** Local `YYYY-MM-DD`. */
  date: string
  tokens: number
}

export interface TodayState {
  /** Latest first. */
  sessions: TodaySession[]
  /** The last 7 days, oldest first; the last one is today. */
  days: TodayDay[]
  /** Today's total, each message counted once. */
  tokens: number
}

export interface TodayApi {
  get(): Promise<TodayState>
}

export interface TodayEvents {}
