/**
 * Permissions domain contract. Owned by the permissions worker.
 * Writes the `permissions` key of settings.json / settings.local.json. Every call re-reads the file and applies only
 * its own change, so rules Claude Code adds to settings.local.json meanwhile are never lost.
 */
import type { SettingsFileName } from './settings'

export type RuleList = 'allow' | 'ask' | 'deny' | 'additionalDirectories'

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const

export interface PermissionsData {
  file: SettingsFileName
  exists: boolean
  mtimeMs: number | null
  defaultMode: string | null
  allow: string[]
  ask: string[]
  deny: string[]
  additionalDirectories: string[]
  /** Other keys inside `permissions` that Claudock leaves alone (e.g. disableBypassPermissionsMode). */
  otherKeys: string[]
  /** Set when the file or the `permissions` key cannot be read; nothing can be edited then. */
  problem: string | null
}

/* ------------------------------------------------------------------ rules saved in projects (Permissions › Projects) */

/** The two files a project keeps permission rules in, under its `.claude` folder. */
export type RuleFile = 'settings.json' | 'settings.local.json'
export type ProjectRuleList = 'allow' | 'ask' | 'deny'

/**
 * What git says about a rule file: `tracked` (it is committed, so a secret in it travels with the repo), `ignored`,
 * `not-ignored` (it can be committed), `repo` (in a git repository, and git could not say more), or null (no repository).
 * From two read-only git commands (src/main/permissions/git.ts).
 */
export type GitState = 'tracked' | 'ignored' | 'not-ignored' | 'repo' | null

/** One permission rule saved in a project's `.claude/settings.json` or `settings.local.json`. */
export interface ProjectRule {
  /** A hash of the project, the file, the list and the rule as saved. */
  id: string
  /** Last folder name of the project. */
  projectName: string
  projectPath: string
  file: RuleFile
  list: ProjectRuleList
  /** The rule with any secret covered (the public start of a known token, then dots). The rule in full never leaves the main process. */
  text: string
  /** The rule holds what looks like a secret. */
  secret: boolean
  /** The covered parts of `text`, as `[start, end)`. */
  secretSpans: [number, number][]
  /** The rule lets Claude run any script (`Bash`, `Bash(python3:*)`). A filter, never a flag. */
  broad: boolean
  /** When the file was last changed. */
  fileMtimeMs: number
  git: GitState
  /** Marked "Not a secret": the rule is no longer flagged. */
  dismissed: boolean
}

export interface ProjectRules {
  /** Flagged rules first (a secret, not dismissed), then by project, then by rule. */
  rules: ProjectRule[]
  /** Rules that hold a secret and were not marked "Not a secret": Today's chip, the sidebar count, the "To check" filter. */
  toCheck: number
  /** Rules that run any script. */
  broad: number
  total: number
  /** Rule files that could not be read as JSON; their rules are not listed. */
  unreadable: number
}

export interface PermissionsApi {
  get(file: SettingsFileName): Promise<PermissionsData>
  /** Pass null to remove `defaultMode` (Claude Code then uses "default"). */
  setDefaultMode(file: SettingsFileName, mode: string | null): Promise<PermissionsData>
  addRule(file: SettingsFileName, list: RuleList, rule: string): Promise<PermissionsData>
  removeRule(file: SettingsFileName, list: RuleList, rule: string): Promise<PermissionsData>
  /** Remove from `from` and append to `to` in one write. */
  moveRule(file: SettingsFileName, from: RuleList, to: RuleList, rule: string): Promise<PermissionsData>
  /** Every permission rule saved in the projects Claude Code knows (the keys of `projects` in the global state file). */
  projectRules(): Promise<ProjectRules>
  /**
   * Remove one rule from its project file: the file is read again, exactly that rule is taken out of its list (the first
   * copy), a snapshot is kept in Backups, and every other byte stays. Returns the list as it is afterwards.
   */
  removeProjectRule(id: string): Promise<ProjectRules>
  /** Mark a flagged rule "Not a secret" (or flag it again): remembered for that exact rule, as its id, never its text. */
  setNotSecret(id: string, value: boolean): Promise<ProjectRules>
}

export interface PermissionsEvents {
  /** The number of rules to check changed (a rule file changed, a rule was removed or marked "Not a secret"). */
  'permissions:rules': { toCheck: number }
}
