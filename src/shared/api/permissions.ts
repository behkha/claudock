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

export interface PermissionsApi {
  get(file: SettingsFileName): Promise<PermissionsData>
  /** Pass null to remove `defaultMode` (Claude Code then uses "default"). */
  setDefaultMode(file: SettingsFileName, mode: string | null): Promise<PermissionsData>
  addRule(file: SettingsFileName, list: RuleList, rule: string): Promise<PermissionsData>
  removeRule(file: SettingsFileName, list: RuleList, rule: string): Promise<PermissionsData>
  /** Remove from `from` and append to `to` in one write. */
  moveRule(file: SettingsFileName, from: RuleList, to: RuleList, rule: string): Promise<PermissionsData>
}

export interface PermissionsEvents {}
