/**
 * Commands domain contract. Owned by the extend worker.
 * Ids are paths relative to the config dir with forward slashes: `commands/git/commit.md`, or a plugin cache path.
 * Folders are namespaces: `commands/frontend/review.md` is `/frontend:review`.
 */
import { RESERVED_NAME_ERROR, isReservedName } from '../names'
import type { SaveResult } from './skills'

export interface CommandFields {
  description: string
  argumentHint: string
  allowedTools: string
  /** '' = not set. */
  model: string
}

export interface CommandInfo extends CommandFields {
  id: string
  /** Name without the slash, folders joined by ":" (e.g. `frontend:review`). */
  name: string
  source: 'user' | 'plugin'
  label: string
  plugin?: string
  readOnly: boolean
  path: string
  size: number
  mtimeMs: number
}

export interface CommandList {
  commands: CommandInfo[]
}

export interface CommandDoc {
  id: string
  text: string
  body: string
  fields: CommandFields
  extra: Record<string, string | string[]>
  hasFrontmatter: boolean
  size: number
  mtimeMs: number
  truncated: boolean
}

export interface CommandsApi {
  list(): Promise<CommandList>
  read(id: string): Promise<CommandDoc>
  save(id: string, input: { fields: CommandFields; body: string; baseMtimeMs: number }): Promise<SaveResult>
  saveRaw(id: string, text: string, baseMtimeMs: number): Promise<SaveResult>
  /** `name` may contain ":" or "/" as namespace separators. */
  create(name: string): Promise<{ id: string }>
  /** Move to a new name (never overwrites). The old file goes to the OS Trash. */
  rename(id: string, name: string): Promise<{ id: string }>
  trash(id: string): Promise<void>
}

export interface CommandsEvents {}

/** Each ":" or "/" separated part of a command name. */
export const COMMAND_PART_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
export const COMMAND_MODELS = ['sonnet', 'opus', 'haiku']

/** Turn user input like "frontend:review" or "frontend/review" into path parts, or an error message. */
export function parseCommandName(input: string): { parts: string[] } | { error: string } {
  const s = input.trim().replace(/^\//, '')
  if (!s) return { error: 'Enter a name.' }
  const parts = s.split(/[:/]/)
  if (parts.length > 4) return { error: 'Use at most three folder levels.' }
  for (const p of parts) {
    if (!COMMAND_PART_RE.test(p)) return { error: 'Use letters, numbers, hyphens and underscores. Separate folders with ":".' }
    if (isReservedName(p)) return { error: RESERVED_NAME_ERROR }
  }
  return { parts }
}
