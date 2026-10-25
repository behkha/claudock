/**
 * Plans domain contract. Owned by the data worker.
 * `rel` is config-relative (`plans/<name>.md`, OS separators) and is the `selectId` of the Plans screen.
 */
export interface PlanInfo {
  rel: string
  file: string
  /** First heading, or the file name. */
  title: string
  /** First non-heading line, trimmed. */
  excerpt: string
  bytes: number
  mtimeMs: number
}

export interface PlansApi {
  list(): Promise<PlanInfo[]>
  read(rel: string): Promise<{ text: string; mtimeMs: number }>
  /** `expectedMtimeMs` is the `mtimeMs` from `read`; if the file changed since, nothing is written (`CHANGED_ON_DISK: ...`). */
  save(rel: string, text: string, expectedMtimeMs: number): Promise<{ mtimeMs: number }>
  trash(rel: string): Promise<void>
}

export interface PlansEvents {}
