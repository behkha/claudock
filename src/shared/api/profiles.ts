import type { LimitsState } from './limits'
import type { HooksStatus, LiveSession } from './sessions'

/**
 * Profiles domain contract: a profile is a Claude Code config folder (what CLAUDE_CONFIG_DIR names) shown under a name.
 * The window shows one profile at a time; the menu bar reads them all. Claudock never reads or changes the logins
 * inside a folder: opening a profile only changes which folder Claudock looks at.
 */

export interface Profile {
  /** The folder's key, also the name of its connect folder. */
  id: string
  name: string
  /** Absolute folder path. */
  dir: string
  /** The folder Claudock was started on: always listed, can't be removed. */
  launch: boolean
  /** The command that starts Claude Code on this folder, for this OS's shell. */
  command: string
  /** The folder is there (it can be moved or deleted after it was added). */
  exists: boolean
}

export interface ProfilesState {
  profiles: Profile[]
  /** The id of the profile open in the window. */
  open: string
}

/** One profile at a glance, for the menu bar and the title bar's profile menu. */
export interface ProfileGlance {
  id: string
  name: string
  open: boolean
  limits: LimitsState
  hooks: HooksStatus
  /** Its sessions waiting for you. */
  waiting: number
}

export interface Glance {
  profiles: ProfileGlance[]
  /** Every profile's running sessions, waiting first; each names its profile when there are several. */
  sessions: LiveSession[]
  waiting: number
}

/** A config folder that isn't a profile yet: found beside `~/.claude`, or picked in the folder picker. */
export interface FolderChoice {
  dir: string
  /** The name the Add profile sheet suggests. */
  name: string
  /** Session transcripts under its projects folder. */
  sessions: number
}

export interface ProfilesApi {
  get(): Promise<ProfilesState>
  /** Open another profile in the window. Every screen reloads on its folder. */
  open(id: string): Promise<ProfilesState>
  /** From the menu bar: bring the window forward and open the profile there, asking first about unsaved edits. */
  openInWindow(id: string): Promise<void>
  glance(): Promise<Glance>
  /** Folders beside `~/.claude` named like it (`~/.claude-work`) that hold Claude Code files and aren't profiles yet. */
  found(): Promise<FolderChoice[]>
  /** The system folder picker (hidden folders shown). Null when cancelled. */
  choose(): Promise<FolderChoice | null>
  /** The empty folder "New folder" would make for this name (`~/.claude-<name>`). */
  newFolder(name: string): Promise<string>
  /**
   * Add a profile and open it: a folder `found()` or `choose()` offered, or (`create`) a new empty folder at
   * `newFolder(name)`. Claude Code asks to log in the first time it runs in a new folder.
   */
  add(input: { dir: string; name: string } | { create: true; name: string }): Promise<ProfilesState>
  rename(id: string, name: string): Promise<ProfilesState>
  /** Forget a profile. Its folder stays as it is. Not the open one or the launch folder. */
  remove(id: string): Promise<ProfilesState>
  /** Show the profile's folder in Finder / Explorer. */
  reveal(id: string): Promise<void>
}

export interface ProfilesEvents {
  /** A profile was added, renamed, removed or opened. */
  'profiles:changed': ProfilesState
  /** Some profile's limits or sessions changed. */
  'profiles:glance': Glance
  /** The menu bar asked the window to open this profile (`openInWindow`). */
  'profiles:request': { id: string }
}
