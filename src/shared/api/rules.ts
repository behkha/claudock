/**
 * Rules domain contract (CLAUDE.md and rules/*.md). Owned by the rules worker.
 * An item id is the path relative to the config dir with forward slashes: `CLAUDE.md`, `rules/git.md`.
 */
export interface RuleItem {
  id: string
  kind: 'claude' | 'rule'
  /** File name without folder. */
  fileName: string
  /** `CLAUDE.md`, or the rule's path under rules/ without `.md` (`git`, `team/review`). */
  name: string
  /** First heading, else the first non-empty line. Null for an empty or missing file. */
  title: string | null
  size: number
  mtimeMs: number
  /** The file does not exist yet (only CLAUDE.md can be in this state). */
  missing: boolean
}

export interface RuleDoc {
  id: string
  text: string
  size: number
  /** Null when the file does not exist. */
  mtimeMs: number | null
  missing: boolean
  /** Absolute path for display. */
  path: string
}

export interface RulesApi {
  list(): Promise<RuleItem[]>
  read(id: string): Promise<RuleDoc>
  /** Fails with a message starting `CHANGED_ON_DISK` if the mtime differs from `expectedMtimeMs`. */
  save(id: string, text: string, expectedMtimeMs: number | null): Promise<{ mtimeMs: number }>
  /** Creates `rules/<name>.md` with a heading template. Never overwrites. */
  create(name: string): Promise<RuleItem>
  /** Renames a rule inside its folder. Never overwrites. */
  rename(id: string, newName: string): Promise<RuleItem>
  /** Move a rule to the OS Trash. CLAUDE.md cannot be trashed. */
  trash(id: string): Promise<void>
}

export interface RulesEvents {}
