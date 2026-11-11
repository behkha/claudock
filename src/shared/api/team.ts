/**
 * Team domain contract: the open profile's Claude Code items written as a plugin plus marketplace into a git repo
 * folder, so a group of developers gets them through Claude Code itself.
 *
 * Claudock only ever writes files: into the team folder the user picked (the plugin, the marketplace file and
 * `.claudock.json`, the list of what it wrote) and the two pointer keys in a connected project's
 * `.claude/settings.json`. It never runs git or Claude Code and never goes on the network for this.
 */

export type TeamKind = 'skill' | 'agent' | 'command' | 'hook' | 'mcp'

/**
 * Where an item stands between the user's own copy, the repo and what Claudock last wrote there.
 * `repo-only`: someone added it to the repo's plugin; the user has no copy.
 */
export type TeamItemState = 'new' | 'published' | 'changed-here' | 'changed-repo' | 'changed-both' | 'removed' | 'repo-only'

export type FindingCode =
  /** A literal token in an MCP server's settings. */
  | 'secret'
  /** A hook runs a file from the home folder. */
  | 'script'
  /** A hook or server starts something from the home folder that cannot be copied in. */
  | 'home-command'
  /** A skill, agent or command names a path on this computer. */
  | 'home-mention'
  /** A skill folder that is a link. */
  | 'link'
  /** A skill over 5 MB. */
  | 'big'
  /** Changed here and in the repo since the last write. */
  | 'both'

/** `where` names the place inside the item (`headers.Authorization`, `env.API_KEY`, `args.2`, `url`, `command`, `text`, `folder`, `item`). */
export type Fix =
  /** The secret becomes a question each teammate answers once: `userConfig[key]`, used as `${user_config.<key>}`. */
  | { kind: 'ask'; where: string; key: string }
  /** The secret is read from an environment variable: `${NAME}`. */
  | { kind: 'env'; where: string; name: string }
  /** The hook's script is copied to `bin/<as>` and the command points at it. */
  | { kind: 'copy-script'; where: string; as: string }
  /** A warning the user accepted. */
  | { kind: 'keep'; where: string }
  /** Changed in both places: the user's copy wins at the next write. */
  | { kind: 'mine'; where: string }

export type FixChoiceKind = Fix['kind'] | 'untick' | 'theirs'

export interface FixChoice {
  kind: FixChoiceKind
  label: string
  /** What the fix is filled with: the `userConfig` key, the variable's name, the script's name in `bin/`. */
  value?: string
}

export interface Finding {
  /** `<item id>|<code>|<where>`. */
  key: string
  itemId: string
  itemName: string
  code: FindingCode
  where: string
  /** Plain words, never the secret itself. */
  text: string
  /** Nothing can be written while one of these has no fix. */
  blocks: boolean
  choices: FixChoice[]
  /** The fix chosen, when there is one. */
  fix?: Fix
}

export interface TeamItem {
  /** `skill:<name>`, `agent:<name>`, `command:<name>`, `hook:<event>:<matcher>:<hash>`, `mcp:<name>`. */
  id: string
  kind: TeamKind
  name: string
  /** The row's second line: "skill", "hook · PostToolUse", "MCP · 3 tools". */
  detail: string
  ticked: boolean
  /** Null for an item that is neither ticked nor in the repo. */
  state: TeamItemState | null
  /** Estimated tokens it adds to every session; null when there is nothing to measure. */
  tokens: number | null
  uses?: number
  lastUsedAt?: number
  /** The first finding without a fix, for the row. */
  problem?: { text: string; blocks: boolean }
  /** The screen that edits it and its id there. */
  open?: { screen: 'skills' | 'agents' | 'commands' | 'hooks' | 'mcp'; id: string }
}

/** Something a plugin cannot carry, listed without a tick. */
export interface StaysRow {
  name: string
  reason: string
  tokens: number | null
}

export interface TeamRemote {
  kind: 'github' | 'git'
  /** `owner/name` for GitHub, else the remote's URL. */
  text: string
}

export interface TeamSetup {
  dir: string
  marketplace: string
  plugin: string
  owner: string
  /** From the folder's `.git/config`; null when it has no `origin`. */
  remote: TeamRemote | null
  /** The last write, ms. */
  sentAt: number | null
  /** The folder is gone or no longer a git repo. */
  missing: boolean
}

export interface TeamProject {
  /** The Projects screen's id. */
  id: string
  name: string
  path: string
  connected: boolean
}

export interface JoinCommands {
  /** For all of a teammate's work. */
  user: string
  /** Inside a connected project. */
  project: string
  /** Set when a teammate has a value to give after installing. */
  configure: string | null
}

export type JoinedChange = 'new' | 'changed' | 'removed' | 'same'

export interface JoinedItem {
  id: string
  kind: TeamKind
  name: string
  detail: string
  change: JoinedChange
  tokens: number | null
}

/** This profile has a team plugin someone else wrote with Claudock installed. */
export interface TeamJoined {
  marketplace: string
  plugin: string
  /** `owner/name`, a URL or a path. */
  source: string
  updatedAt: number | null
  enabled: boolean
  items: JoinedItem[]
  tokens: number
}

export interface TeamState {
  setup: TeamSetup | null
  /** Everything of the user's own that can travel, most tokens first, then what only the repo has. */
  items: TeamItem[]
  stays: StaysRow[]
  /** Estimated tokens per session of the ticked items. */
  tokens: number
  /** Items whose next write would change the repo. */
  changes: number
  join: JoinCommands | null
  projects: TeamProject[]
  joined: TeamJoined | null
  /** False where this copy may not write the team folder (a development build on a real folder). */
  writable: boolean
  settingsError?: string
}

export interface FolderOffer {
  /** Pass back to `create`: only a folder picked in the dialog is accepted. */
  token: string
  dir: string
  isGit: boolean
  remote: TeamRemote | null
  /** Names to start from: the folder's own marketplace when it has one, else made from the remote or folder name. */
  marketplace: string
  plugin: string
  owner: string
  /** The folder already holds a marketplace Claudock wrote. */
  existing: boolean
}

export interface ReviewFile {
  /** Relative to the team folder, forward slashes. */
  rel: string
  change: 'add' | 'change' | 'remove'
}

export interface Review {
  findings: Finding[]
  files: ReviewFile[]
  /** No blocking finding is left and something would change. */
  canWrite: boolean
  /** Hash of the plan shown; `write` refuses another plan. */
  token: string
}

export interface Written {
  files: number
  removed: number
  dir: string
  /** The commit and push line to copy. */
  command: string
}

export interface TeamDiff {
  before: string
  after: string
  /** Not text, or over the size shown. */
  binary: boolean
}

export interface TeamApi {
  get(): Promise<TeamState>
  /** The system folder dialog. Null when cancelled. */
  pickFolder(): Promise<FolderOffer | null>
  create(input: { token: string; marketplace: string; plugin: string; owner: string }): Promise<TeamState>
  setTicked(ids: string[], on: boolean): Promise<TeamState>
  /** Choose or clear a finding's fix. `untick` and `theirs` are their own calls. */
  setFix(itemId: string, fix: Fix | { kind: 'clear'; where: string }): Promise<Review>
  review(): Promise<Review>
  /** A file of the review, as the repo has it and as it would be written. */
  fileDiff(rel: string): Promise<TeamDiff>
  /** An item as the user has it and as the repo has it. */
  itemDiff(id: string): Promise<TeamDiff>
  write(token: string): Promise<Written>
  /** Skills, agents and commands only: the repo's files replace the user's own copy (snapshot kept). */
  takeRepoVersion(id: string): Promise<{ snapshotId: string | null }>
  /** The two keys as they would be written into the project's `.claude/settings.json`. */
  connectPlan(projectId: string): Promise<TeamDiff>
  connect(projectId: string): Promise<TeamState>
  disconnect(projectId: string): Promise<TeamState>
  copy(what: 'send' | 'join-user' | 'join-project' | 'configure'): Promise<void>
  reveal(): Promise<void>
  /** Stop tracking the team folder. Its files stay as they are. */
  forget(): Promise<void>
}

export interface TeamEvents {}

/* ------------------------------------------------------------------ names (used by both sides) */

const MARKETPLACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PLUGIN_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const RESERVED_MARKETPLACES = ['claude-plugins-official', 'inline', 'builtin']
const RESERVED_PLUGIN_PREFIXES = ['claude-', 'anthropic-', 'anthropics-', 'cc-plugin-']
const RESERVED_PLUGINS = ['claude', 'anthropic', 'official']

/** Null when the marketplace name is fine, else what is wrong with it. */
export function marketplaceNameProblem(name: string): string | null {
  if (!name) return 'Give it a name.'
  if (!MARKETPLACE_RE.test(name)) return 'Use letters, digits, dots, dashes and underscores.'
  if (RESERVED_MARKETPLACES.includes(name.toLowerCase()) || name.toLowerCase().startsWith('claudeai-')) return 'Claude Code keeps that name for itself.'
  return null
}

/** Null when the plugin name is fine, else what is wrong with it. */
export function pluginNameProblem(name: string): string | null {
  if (!name) return 'Give it a name.'
  if (name.length > 64 || !PLUGIN_RE.test(name)) return 'Use lowercase letters, digits and single dashes.'
  if (RESERVED_PLUGINS.includes(name) || RESERVED_PLUGIN_PREFIXES.some((p) => name.startsWith(p))) return 'Claude Code keeps that name for itself.'
  return null
}

/** A name made safe for a plugin or marketplace: lowercase, dashes for everything else. */
export function slugName(text: string, fallback: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s || fallback
}
