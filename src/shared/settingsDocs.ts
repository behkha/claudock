/**
 * What the settings JSON editor knows about settings.json keys, built from Anthropic's Claude Code docs
 * (settings-reference, env-vars) merged with the published JSON schema. The main process fetches it at launch and
 * falls back to its cache, then to the copy bundled with the app. Shared by main (builds it) and renderer (uses it).
 */

/** Pages the data is built from. The schema has a GitHub mirror because json.schemastore.org is sometimes unreachable. */
export const SETTINGS_DOCS_SOURCES = {
  reference: 'https://code.claude.com/docs/en/settings-reference.md',
  envVars: 'https://code.claude.com/docs/en/env-vars.md',
  schema: ['https://json.schemastore.org/claude-code-settings.json', 'https://raw.githubusercontent.com/SchemaStore/schemastore/master/src/schemas/json/claude-code-settings.json']
} as const

/** Base of the human docs links shown in the editor (`<base>#<anchor>`). */
export const SETTINGS_DOCS_PAGE = 'https://code.claude.com/docs/en/settings-reference'

/** Version of the built data's shape. A cached copy with another format is ignored; bump it when `DocNode` changes meaning. */
export const SETTINGS_DOCS_FORMAT = 1

export type JsonKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null'

export interface DocValue {
  value: string | number | boolean | null
  /** What this value does, when the docs say. */
  summary?: string
}

/** One key (or one array item / map value) and what may go under it. Every field is optional: absent = unknown. */
export interface DocNode {
  /** One-line summary, Markdown links stripped: the docs index row, else the schema description's first sentence. */
  summary?: string
  /** The docs "Type" line as plain text, e.g. `string, one of "low", "medium", "high", "xhigh" or "max"`. */
  typeText?: string
  /** The docs "Default" line as plain text. */
  default?: string
  /** Which files it can go in, e.g. `Any file`, `Managed`, `User or managed`. */
  scope?: string
  /** Docs topic heading, e.g. `Model and responses`. */
  topic?: string
  /** Docs entry link, `${SETTINGS_DOCS_PAGE}#<anchor>`. */
  url?: string
  /** Accepted JSON value kinds ('number' covers integers). Absent or empty = do not check the type. */
  kinds?: JsonKind[]
  /** Known values, docs order first. */
  values?: DocValue[]
  /** True when `values` is the complete list, so any other value is worth a warning. */
  closedValues?: boolean
  /** Named sub-keys of an object value. */
  properties?: Record<string, DocNode>
  /** True when keys other than `properties` (and `additional`) are not allowed. */
  closed?: boolean
  /** Shape of the values under any other key (maps such as `env` or `enabledPlugins`). */
  additional?: DocNode
  /** Shape of each array item. */
  items?: DocNode
  /** Extra key suggestions for this object: `env` = the documented environment variable names. */
  keySource?: 'env'
  /** Extra value suggestions for strings here: `permissionRule` = `Tool(` prefixes from `tools`. */
  valueSource?: 'permissionRule'
  /** First JSON example from the docs entry, as written there (whole settings object). */
  example?: string
  /** Claude Code version that removed this setting, e.g. `v2.1.257`. It does nothing now: no suggestion, a warning. */
  removed?: string
  /**
   * Constraints on this node that come only from the JSON schema, which can lag the docs: suggestions and insert shapes
   * may use them, warnings must not. `kinds` = the docs type line gave no kinds for this node; `closed` = unknown keys
   * are only known to be wrong from the schema; `closedValues` = the list is only known to be complete from the schema.
   */
  schemaOnly?: Array<'kinds' | 'closed' | 'closedValues'>
}

export interface SettingsDocs {
  /** `SETTINGS_DOCS_FORMAT` when this copy was built. */
  format: number
  /** ISO time the data was built from the docs. */
  builtAt: string
  /** Where this copy came from: fetched this launch, the last fetched copy on disk, or the copy shipped with the app. */
  origin: 'live' | 'cache' | 'bundled'
  /** URLs actually used. */
  sources: string[]
  /** The settings object itself. Its `properties` are the top-level keys; `closed` is true (unknown keys warn). */
  root: DocNode
  /** Documented environment variables, for keys of `env`. */
  env: Array<{ name: string; summary: string }>
  /** Tool names accepted at the start of permission rules (`Bash`, `Read`, `WebFetch`, …). */
  tools: string[]
  /** Set when this launch's fetch failed (offline, page layout changed); the editor shows it next to the date. */
  fetchError?: string
}
