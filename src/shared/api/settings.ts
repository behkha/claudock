/**
 * Settings domain contract. Owned by the settings worker (also used by the hooks and permissions domains, which
 * write keys of the same two files).
 */

import type { SettingsDocs } from '../settingsDocs'

/** The two user-level settings files Claudock edits. Anything else is refused. */
export type SettingsFileName = 'settings.json' | 'settings.local.json'
export const SETTINGS_FILES: SettingsFileName[] = ['settings.json', 'settings.local.json']

export interface SettingsDoc {
  file: SettingsFileName
  /** Absolute path (for display). */
  path: string
  exists: boolean
  /** Raw file text ('' when the file does not exist). */
  text: string
  /** Null when the file does not exist. */
  mtimeMs: number | null
  size: number
}

export interface SettingsStat {
  exists: boolean
  mtimeMs: number | null
  size: number
}

export interface SettingsSaveResult {
  mtimeMs: number
  snapshotId: string | null
}

/** Counts shown in the summary rows of the Form view. Read from the file on disk, not from the draft. */
export interface SettingsSummary {
  hookCommands: number
  hookEvents: number
  allow: number
  ask: number
  deny: number
  defaultMode: string | null
  skillOverridesTotal: number
  skillOverridesOff: number
  pluginsTotal: number
  pluginsEnabled: number
}

export interface SettingsHistoryItem {
  /** `snap:<snapshot id>` or `bak:<file name>`. */
  id: string
  kind: 'snapshot' | 'backup'
  /** ISO timestamp (snapshot time, or the file's mtime for loose copies). */
  at: string
  /** Snapshot reason, or the loose file's name. */
  label: string
  /** Bytes, when cheap to know (loose copies). */
  size: number | null
}

export interface SettingsApi {
  /** Raw text of a settings file with the mtime used for conflict detection. */
  read(file: SettingsFileName): Promise<SettingsDoc>
  /** Cheap stat for the "changed on disk" check on window focus. */
  stat(file: SettingsFileName): Promise<SettingsStat>
  /**
   * Validate (must be a JSON object) and write the whole file through safeWrite. When `expectedMtimeMs` is given and the
   * file's mtime differs, nothing is written and the call fails with a message starting `CHANGED_ON_DISK`.
   */
  save(file: SettingsFileName, text: string, expectedMtimeMs: number | null): Promise<SettingsSaveResult>
  summary(file: SettingsFileName): Promise<SettingsSummary>
  history(file: SettingsFileName): Promise<SettingsHistoryItem[]>
  /** Text of one history item (snapshot copy or loose .bak copy). */
  readHistory(file: SettingsFileName, id: string): Promise<string>
  /** Put a history item back (the current file is snapshotted first). */
  restore(file: SettingsFileName, id: string): Promise<SettingsSaveResult>
  /**
   * Scripts inside the config dir that a shell command mentions (`~/.claude/x.sh`, `$HOME/.claude/...`,
   * `$CLAUDE_CONFIG_DIR/...`, absolute paths). Returns config-dir-relative paths of files that exist.
   */
  scripts(command: string): Promise<string[]>
  /**
   * Key docs for the JSON editor's completion, hover and checks: this launch's fetch of Anthropic's docs when it is
   * done, else the cached copy, else the bundled one. Waits a few seconds for a fetch still in flight.
   */
  docs(): Promise<SettingsDocs>
}

export interface SettingsEvents {
  /**
   * Sent when this launch's docs fetch ends after `docs()` already answered with an older copy: the new docs, or, when
   * the fetch failed, that same older copy with `fetchError` set.
   */
  'settings:docs': SettingsDocs
}
