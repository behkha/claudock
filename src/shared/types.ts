import type { ScreenId } from './nav'

export type Platform = 'darwin' | 'win32' | 'linux'
export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_PREFS: ThemePref[] = ['system', 'light', 'dark']

/** Result row of the global command palette (`search:query`). */
export interface SearchResult {
  /** Screen to open. */
  screen: ScreenId
  /** Passed to the screen as `selectId` so it can preselect the item. Screen-defined (usually a relative path or key). */
  id: string
  title: string
  subtitle?: string
  /** Short kind label shown as a badge, e.g. "skill", "session". */
  kind?: string
}

/** What the sidebar shows on the right of each item. A number, or a preformatted string such as "1.2 GB". */
export type SidebarCount = number | string
export type SidebarCounts = Partial<Record<ScreenId, SidebarCount>>

export interface ConfigInfo {
  /** Absolute config dir (CLAUDE_CONFIG_DIR or ~/.claude). */
  configDir: string
  /** Absolute global state file (.claude.json). */
  globalStateFile: string
  exists: boolean
  home: string
  sep: string
  platform: Platform
  /** True when CLAUDE_CONFIG_DIR is set (dev / fixture / multi-account). */
  customDir: boolean
  /** True when writes are allowed (always true when packaged). Dev builds block writes to the real ~/.claude. */
  writable: boolean
  userData: string
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  platform: Platform
  arch: string
  packaged: boolean
}

export interface DirSize {
  bytes: number
  files: number
  dirs: number
  /** Milliseconds since epoch when this value was computed. */
  at: number
}

export interface DirEntryInfo {
  name: string
  /** Path relative to the config dir, using the OS separator. */
  rel: string
  isDir: boolean
  isFile: boolean
  isSymlink: boolean
  size: number
  mtimeMs: number
  /** Credentials / session key. Show as a locked row, never read. */
  secret: boolean
}

export interface SnapshotInfo {
  /** Folder name inside <userData>/snapshots (ISO timestamp, ':' replaced by '-'). */
  id: string
  /** Real ISO timestamp. */
  at: string
  reason: string
  /** Paths relative to the config dir (the global state file is `.claude.json`). */
  files: string[]
}

export interface SizeProgress {
  /** Opaque id the caller passed to the scan so concurrent scans can be told apart. */
  scanId: string
  bytes: number
  files: number
  done: boolean
}
