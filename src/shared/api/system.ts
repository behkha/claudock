import type { AppInfo, ConfigInfo, DirSize, SidebarCounts, SizeProgress, ThemePref, UpdateInfo, UpdateStatus, WhatsNew } from '../types'
import type { ScreenId } from '../nav'

/** System domain (fully implemented in phase 1). */
export interface SystemApi {
  configInfo(): Promise<ConfigInfo>
  /** Total size of the config dir. Async scan with concurrency limit; cached ~60 s. Streams `system:sizeProgress`. */
  configSize(opts?: { force?: boolean; scanId?: string }): Promise<DirSize>
  appInfo(): Promise<AppInfo>
  /** The latest GitHub release when it is newer than this copy, else null (also offline, on failure and in dev). */
  checkUpdate(): Promise<UpdateInfo | null>
  /** Where Update is (downloading, ready to restart). Streams `system:updateStatus`. */
  updateStatus(): Promise<UpdateStatus>
  /** Download and check `version` (npm: install it); resolves when Restart can run, throws with the cause. */
  installUpdate(version: string): Promise<void>
  /** Quit and start the version that is ready (src/main/updateInstall.ts). */
  restartToUpdate(): Promise<void>
  /** This version's notes, and whether they show by themselves (the first open after an update). */
  whatsNew(): Promise<WhatsNew>
  /** What's new was closed: it doesn't show by itself again for this version. */
  seenWhatsNew(): Promise<void>
  /** Show a file/folder in Finder / Explorer. `path` is relative to the config dir (or an absolute path inside it). */
  reveal(path: string): Promise<void>
  /** Open a text-like file in the OS default app. Refuses scripts/executables and secrets. */
  openInEditor(path: string): Promise<void>
  getTheme(): Promise<ThemePref>
  setTheme(pref: ThemePref): Promise<ThemePref>
  /** Assembled in main from each domain module's optional exported `count()`. */
  sidebarCounts(): Promise<SidebarCounts>
  /** Show the first-run reveal: once, to anyone with neither Connect part on (src/main/firstRun.ts). */
  firstRun(): Promise<boolean>
  /** The reveal was left (Connect, Not now, Continue or a navigation): it doesn't show again. */
  finishFirstRun(): Promise<void>
}

export interface SystemEvents {
  'system:theme': ThemePref
  'system:navigate': { screen: ScreenId; id?: string }
  'system:sizeProgress': SizeProgress
  /** Open the command palette (screenshot mode, menu). */
  'system:openPalette': null
  /** Show the first-run reveal (screenshot mode). */
  'system:reveal': null
  'system:updateStatus': UpdateStatus
  /** The release the footer offers changed (screenshot mode). */
  'system:update': UpdateInfo | null
  /** Open What's new (screenshot mode). */
  'system:whatsNew': null
}
