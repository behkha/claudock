/**
 * Agents domain contract. Owned by the extend worker.
 * Ids are paths relative to the config dir with forward slashes: `agents/<name>.md`, or a plugin cache path.
 */
import type { SaveResult } from './skills'

export interface AgentFields {
  name: string
  description: string
  /** '' = not set (inherits). */
  model: string
  tools: string[]
  color: string
}

export interface AgentInfo extends AgentFields {
  id: string
  source: 'user' | 'plugin'
  /** "user" or the plugin name. */
  label: string
  plugin?: string
  readOnly: boolean
  /** Absolute path. */
  path: string
  size: number
  mtimeMs: number
}

export interface AgentList {
  agents: AgentInfo[]
}

export interface AgentDoc {
  id: string
  text: string
  body: string
  fields: AgentFields
  /** Other frontmatter keys (kept as they are when saving the form). */
  extra: Record<string, string | string[]>
  hasFrontmatter: boolean
  size: number
  mtimeMs: number
  truncated: boolean
}

export interface AgentsApi {
  list(): Promise<AgentList>
  read(id: string): Promise<AgentDoc>
  /** Save the form: only the frontmatter keys that changed are rewritten; unknown keys stay as they are. */
  save(id: string, input: { fields: AgentFields; body: string; baseMtimeMs: number }): Promise<SaveResult>
  /** Save the whole file text. */
  saveRaw(id: string, text: string, baseMtimeMs: number): Promise<SaveResult>
  create(name: string): Promise<{ id: string }>
  /** Copy to `<name>-copy.md` (never overwrites) and set the frontmatter name. */
  duplicate(id: string): Promise<{ id: string }>
  trash(id: string): Promise<void>
}

export interface AgentsEvents {}

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const AGENT_MODELS = ['inherit', 'sonnet', 'opus', 'haiku']
export const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']
