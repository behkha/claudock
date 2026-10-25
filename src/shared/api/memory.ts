/**
 * Memory domain contract. Owned by the data worker.
 * A memory file is `projects/<project>/memory/<file>.md`. `rel` (config-relative, OS separators) is the id and the
 * `selectId` the Memory screen understands.
 */
export interface MemoryFileInfo {
  rel: string
  /** File name, e.g. `prefers_pnpm.md`. */
  file: string
  isIndex: boolean
  /** Frontmatter `name`, or the file name without `.md`. */
  title: string
  description: string
  type: string
  bytes: number
  mtimeMs: number
}

export interface MemoryGroup {
  projectId: string
  projectName: string
  projectPath: string | null
  files: MemoryFileInfo[]
}

export interface MemoryFileContent {
  rel: string
  text: string
  mtimeMs: number
  /** Parsed frontmatter fields (empty strings when absent). */
  name: string
  description: string
  type: string
  hasFrontmatter: boolean
  body: string
  /** True when the project's MEMORY.md has a line linking to this file. */
  indexed: boolean
}

export interface MemoryApi {
  list(): Promise<MemoryGroup[]>
  read(rel: string): Promise<MemoryFileContent>
  /**
   * Save frontmatter fields and body. Unknown frontmatter lines are kept. Snapshot kept in Backups.
   * `expectedMtimeMs` is the `mtimeMs` of the content the editor started from: if the file changed since (Claude Code
   * writes memory files too), nothing is written and the error message starts with `CHANGED_ON_DISK`.
   */
  save(rel: string, fields: { name: string; description: string; type: string }, body: string, expectedMtimeMs: number): Promise<{ mtimeMs: number }>
  /** Move to Trash; when `removeFromIndex`, also drop the linking line from MEMORY.md. */
  trash(rel: string, removeFromIndex: boolean): Promise<void>
}

export interface MemoryEvents {}
