/**
 * MCP domain contract. Owned by the extend worker.
 * Servers live in the global state file (`.claude.json`), key `mcpServers`. They are only ever written with
 * `writeGlobalStateKey('mcpServers', ...)`, which re-reads the file and changes nothing else.
 */

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerConfig {
  type?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Unknown fields are kept as they are. */
  [key: string]: unknown
}

export interface McpServer {
  name: string
  scope: 'user' | 'project'
  projectPath?: string
  transport: McpTransport | 'unknown'
  config: McpServerConfig
  /** One line for the list: the command line or the URL. */
  summary: string
}

export interface McpProject {
  path: string
  servers: McpServer[]
}

export interface McpList {
  /** Absolute path of the global state file. */
  stateFile: string
  stateExists: boolean
  user: McpServer[]
  /** Projects that have their own servers (read-only here). */
  projects: McpProject[]
  error?: string
}

export interface McpApi {
  list(): Promise<McpList>
  /** Add (no `originalName`) or edit (with `originalName`, which also renames). Validates first. */
  save(input: { originalName?: string; name: string; config: McpServerConfig }): Promise<{ snapshotId: string | null }>
  remove(name: string): Promise<{ snapshotId: string | null }>
}

export interface McpEvents {}

/* ------------------------------------------------------------------ validation (used by both sides) */

export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export function transportOf(c: McpServerConfig): McpTransport | 'unknown' {
  const t = typeof c.type === 'string' ? c.type : undefined
  if (t === 'http' || t === 'sse' || t === 'stdio') return t
  if (t === undefined) return typeof c.url === 'string' && c.command === undefined ? 'http' : 'stdio'
  return 'unknown'
}

export function summarize(c: McpServerConfig): string {
  const t = transportOf(c)
  if (t === 'http' || t === 'sse') return typeof c.url === 'string' ? c.url : ''
  const args = Array.isArray(c.args) ? c.args.filter((a) => typeof a === 'string') : []
  return [typeof c.command === 'string' ? c.command : '', ...args].join(' ').trim()
}

/** Returns a list of problems (empty = valid). */
export function validateMcp(
  name: string,
  config: McpServerConfig,
  existingNames: string[],
  originalName?: string
): { name?: string; command?: string; url?: string; args?: string; env?: string; headers?: string; general?: string } {
  const out: ReturnType<typeof validateMcp> = {}
  if (!MCP_NAME_RE.test(name)) out.name = 'Use letters, numbers, hyphens and underscores (up to 64).'
  else if (name !== originalName && existingNames.includes(name)) out.name = 'A server with this name already exists.'

  const t = transportOf(config)
  if (t === 'unknown') {
    out.general = 'The type must be stdio, http or sse.'
    return out
  }
  if (t === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim()) out.command = 'Enter the command to run.'
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((a) => typeof a !== 'string'))) out.args = 'Arguments must be text.'
  } else {
    const u = typeof config.url === 'string' ? config.url.trim() : ''
    if (!u) out.url = 'Enter the server URL.'
    else {
      try {
        const parsed = new URL(u)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') out.url = 'The URL must start with http:// or https://.'
      } catch {
        out.url = 'This is not a valid URL.'
      }
    }
  }
  if (config.env !== undefined) {
    const env = config.env
    if (typeof env !== 'object' || env === null || Array.isArray(env)) out.env = 'Environment must be key and value pairs.'
    else {
      const keys = Object.keys(env)
      if (keys.some((k) => !ENV_KEY_RE.test(k))) out.env = 'Variable names use letters, numbers and underscores, and cannot start with a number.'
      else if (Object.values(env).some((v) => typeof v !== 'string')) out.env = 'Values must be text.'
    }
  }
  if (config.headers !== undefined) {
    const h = config.headers
    if (typeof h !== 'object' || h === null || Array.isArray(h)) out.headers = 'Headers must be key and value pairs.'
    else if (Object.keys(h).some((k) => !HEADER_KEY_RE.test(k))) out.headers = 'A header name has characters that are not allowed.'
    else if (Object.values(h).some((v) => typeof v !== 'string')) out.headers = 'Values must be text.'
  }
  return out
}

export const hasProblems = (p: ReturnType<typeof validateMcp>): boolean => Object.keys(p).length > 0
