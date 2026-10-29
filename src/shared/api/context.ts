/**
 * Context domain contract: what each skill, MCP server and CLAUDE.md file adds to the start of every session, measured
 * from the text Claude Code recorded in the open profile's newest transcript, with a switch for skills and user servers.
 * Only the token count is an estimate (characters ÷ CHARS_PER_TOKEN): Claude has no local tokenizer and Claudock never
 * calls the API.
 */

export type ContextKind = 'skill' | 'mcp' | 'memory'

export interface ContextItem {
  /** `skill:<skillOverrides key>`, `mcp:<server name>` or `memory:<path as Claude Code wrote it>`. */
  id: string
  kind: ContextKind
  name: string
  /** After the kind on the row's second line: "user", "synced", a plugin name, "claude.ai", or "" when unknown. */
  source: string
  /** In Claude's context: a skill not set to `user-invocable-only` or `off`; a server not in `deniedMcpServers`. */
  on: boolean
  switchable: boolean
  /** Characters it adds to every session; 0 when off; null when there is nothing to measure. */
  chars: number | null
  /** Estimated from `chars`; null with it. */
  tokens: number | null
  /** Where `chars` comes from: the measured session's own record, or the files on disk (no session has it yet). */
  measured: 'session' | 'files' | null
  /** Why a server has no number: it failed, needed a login or was still connecting in that session, or never showed up. */
  missing?: 'failed' | 'needs-auth' | 'pending' | 'not-seen'
  /** MCP servers: tools Claude Code listed for it. */
  tools?: number
  /** Skills: Claude Code's own count (`skillUsage`). MCP servers: tool calls in the last 30 days of transcripts. */
  uses?: number
  lastUsedAt?: number
  /** Skills: the `skillOverrides` value, when there is one. */
  override?: string
  /** The screen that edits it (Skills, MCP servers, CLAUDE.md & rules) and its id there. */
  open?: { screen: 'skills' | 'mcp' | 'rules'; id: string }
}

export interface ContextSession {
  id: string
  /** Claude Code's name for it, else its first prompt. */
  name: string
  cwd: string | null
  /** Its last line. */
  at: number
}

export interface ContextList {
  /** Most tokens first; off items last. */
  items: ContextItem[]
  /** Sum of the estimates of the items that are on. */
  tokens: number
  /** The session measured: the open profile's newest transcript with Claude Code's context records. */
  session: ContextSession | null
  /** The MCP tool calls are still being counted (the first time, on a large folder): `context:usage` says when they are. */
  usesPending?: boolean
  settingsError?: string
}

export interface ContextText {
  id: string
  /** The text Claude Code was given for it, as counted. */
  text: string
  truncated: boolean
}

export interface ContextApi {
  list(): Promise<ContextList>
  text(id: string): Promise<ContextText>
  /**
   * Only for a listed row with `switchable`. Skills: off writes `user-invocable-only` (/name still works), on puts back
   * what that replaced. Servers: `deniedMcpServers`. Off and on again leaves settings.json as it was.
   */
  setOn(id: string, on: boolean): Promise<{ snapshotId: string | null; changed: boolean }>
}

export interface ContextEvents {
  /** The MCP tool calls of the open profile were counted again and came out different: list again. */
  'context:usage': null
}

export const CHARS_PER_TOKEN = 3.5

export const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN)

/** "≈ 34", "≈ 1.4k", "≈ 12k"; an exact zero stays "0". */
export function formatEstimate(tokens: number): string {
  if (tokens <= 0) return '0'
  if (tokens < 1000) return `≈ ${tokens}`
  if (tokens < 9950) return `≈ ${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (tokens < 999_500) return `≈ ${Math.round(tokens / 1000)}k`
  return `≈ ${(tokens / 1e6).toFixed(1).replace(/\.0$/, '')}M`
}
