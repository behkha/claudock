/**
 * Skills domain contract. Owned by the extend worker.
 *
 * Ids are paths relative to the config dir with forward slashes (the skill folder), e.g. `skills/pdf-extract`,
 * `skills/synced/<bucket>/docs`, `plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>`.
 * A name that exists only in `skillOverrides` has the id `override:<key>`.
 */

export type SkillSource = 'user' | 'synced' | 'plugin' | 'override'

export interface SkillInfo {
  id: string
  /** Key used in `skillOverrides`: the skill name, or `<plugin>:<name>` for plugin skills. */
  key: string
  name: string
  source: SkillSource
  /** Text after "On ·": "user", "synced", the plugin name, or "override only". */
  label: string
  plugin?: string
  /** For plugin skills: false when the plugin itself is turned off (its skills do not load). */
  pluginEnabled?: boolean
  description: string
  /** Not "off" in skillOverrides (and, for plugin skills, the plugin is on). */
  enabled: boolean
  /** Raw value in skillOverrides, if any. */
  override?: string
  /** Folder, relative to the config dir (forward slashes). Empty for override-only. */
  rel: string
  /** Absolute folder path. Empty for override-only. */
  dir: string
  /** SKILL.md path relative to the config dir. Empty for override-only. */
  skillFile: string
  mtimeMs: number
  symlink: boolean
  /** Synced skills exist once per sync bucket; the newest copy is shown. */
  copies?: number
  syncSource?: string
  /** Plugin and synced skills cannot be edited or trashed here. */
  readOnly: boolean
}

export interface SkillList {
  skills: SkillInfo[]
  /** Set when settings.json could not be read; overrides are then ignored. */
  settingsError?: string
}

export interface SkillDoc {
  id: string
  text: string
  size: number
  mtimeMs: number
  /** Only the first 1.5 MB were read: editing is disabled. */
  truncated: boolean
}

export interface FileEntry {
  name: string
  /** Relative to the config dir (forward slashes). */
  rel: string
  isDir: boolean
  /** File size in bytes; null for folders (use `dirSize`). */
  size: number | null
  symlink: boolean
}

export interface SaveResult {
  /** Snapshot that holds the previous content, or null if the file is new. */
  snapshotId: string | null
  mtimeMs: number
}

export interface OverrideResult {
  snapshotId: string | null
  /** How many keys actually changed. */
  changed: number
}

export interface SkillsApi {
  list(): Promise<SkillList>
  /** Read SKILL.md (first 1.5 MB). */
  read(id: string): Promise<SkillDoc>
  /** Save SKILL.md of a user skill. Fails if the file changed on disk since `baseMtimeMs`. */
  save(id: string, text: string, baseMtimeMs: number): Promise<SaveResult>
  /** Turn skills on (removes the override) or off (writes "off") in settings.json `skillOverrides`. One write for all keys. */
  setEnabled(keys: string[], enabled: boolean): Promise<OverrideResult>
  /** Recursive size of the skill folder (async, cached). */
  size(id: string): Promise<{ bytes: number; files: number }>
  /** Direct children of the skill folder, or of `sub` (a folder inside it, relative to the skill folder). */
  files(id: string, sub?: string): Promise<FileEntry[]>
  /** Recursive size of a folder inside the skill. `sub` is relative to the skill folder. */
  dirSize(id: string, sub: string): Promise<number>
  /** Copy the skill folder to `skills/<name>-copy` (never overwrites) and set the new frontmatter name. */
  duplicate(id: string): Promise<{ id: string; name: string }>
  /** Create `skills/<name>/SKILL.md` from a template. */
  create(name: string, description?: string): Promise<{ id: string }>
  /** Move a user skill folder to the OS Trash. */
  trash(id: string): Promise<void>
}

export interface SkillsEvents {}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
