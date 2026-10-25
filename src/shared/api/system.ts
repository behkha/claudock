import type { AppInfo, ConfigInfo, DirSize, SidebarCounts, SizeProgress, ThemePref } from '../types'
import type { ScreenId } from '../nav'

/** System domain (fully implemented in phase 1). */
export interface SystemApi {
  configInfo(): Promise<ConfigInfo>
  /** Total size of the config dir. Async scan with concurrency limit; cached ~60 s. Streams `system:sizeProgress`. */
  configSize(opts?: { force?: boolean; scanId?: string }): Promise<DirSize>
  appInfo(): Promise<AppInfo>
  /** Show a file/folder in Finder / Explorer. `path` is relative to the config dir (or an absolute path inside it). */
  reveal(path: string): Promise<void>
  /** Open a text-like file in the OS default app. Refuses scripts/executables and secrets. */
  openInEditor(path: string): Promise<void>
  getTheme(): Promise<ThemePref>
  setTheme(pref: ThemePref): Promise<ThemePref>
  /** Assembled in main from each domain module's optional exported `count()`. */
  sidebarCounts(): Promise<SidebarCounts>
}

export interface SystemEvents {
  'system:theme': ThemePref
  'system:navigate': { screen: ScreenId; id?: string }
  'system:sizeProgress': SizeProgress
  /** Open the command palette (screenshot mode, menu). */
  'system:openPalette': null
}
