/**
 * Mods domain contract. A mod is a plugin whose `hooks/hooks.json` has a `modules` key (a JS/TS hooks module).
 * Three kinds are listed: installed from a marketplace (switched through `enabledPlugins`), loaded from a folder
 * (`CLAUDE_CODE_PLUGIN_DIRS` in settings.json `env`), and drafts Claude wrote in `dev-mods/<session>/<name>`.
 * Installing and removing marketplace mods is left to `/plugin` in Claude Code.
 */

export type ModSource = 'installed' | 'folder' | 'draft'

/** What the hooks module does, read from its source text (no code is run). */
export interface ModUses {
  /** Events passed to `on(...)`, such as `tool.call`. */
  hooks: string[]
  /** Render sites from `ui.render` filters, such as `AbovePrompt`. */
  draws: string[]
  /** Commands from `$.command.register({ name })`, without the slash. */
  commands: string[]
  /** Mods API calls without `$.`, such as `fs.read`. */
  calls: string[]
  /** The calls that act outside Claude Code's interface: processes, file writes, network, model calls, prompts. */
  risky: string[]
}

export interface ModDraft {
  sessionId: string
  /** Real folder of the session's project, null when its transcript is gone. */
  project: string | null
  /** Encoded project folder under projects/, for opening the session. */
  projectId: string | null
  /** First prompt of the session ('' when unknown). */
  sessionTitle: string
  /** Newest file time in the draft (ms). */
  modifiedMs: number
  /** When Claude Code's cleanup may delete it: modified + cleanupPeriodDays. */
  expiresMs: number
}

export interface ModInfo {
  /** installed: the plugin key; folder: `folder:<absolute path>`; draft: `draft:<session>/<name>`. */
  id: string
  name: string
  source: ModSource
  version: string
  description: string
  author: string
  /** `name@marketplace` for installed mods, `name@inline` for folder mods, '' for drafts. */
  key: string
  marketplace: string
  /** installed: enabledPlugins says on; folder: listed in CLAUDE_CODE_PLUGIN_DIRS; draft: false. */
  enabled: boolean
  /** Absolute folder. */
  dir: string
  /** Folder relative to the config dir; null when it lies outside it. */
  rel: string | null
  /** Hooks module path relative to the mod folder ('' when hooks.json is unreadable). */
  module: string
  uses: ModUses
  /** `$.store` file relative to the config dir, null when the mod saved nothing. */
  storeRel: string | null
  storeBytes: number
  /** README.md, at most 64 KB. */
  readme: string | null
  draft?: ModDraft
}

export interface ModList {
  mods: ModInfo[]
  /** `disableAllHooks: true` in settings.json: no installed mod runs. */
  hooksDisabled: boolean
  cleanupPeriodDays: number
  settingsError?: string
}

export interface ModsApi {
  list(): Promise<ModList>
  /** Installed mods: writes `enabledPlugins[key]`. Folder mods: adds or removes the folder in `CLAUDE_CODE_PLUGIN_DIRS`. */
  setEnabled(id: string, enabled: boolean): Promise<{ snapshotId: string | null }>
  /** Moves a draft to `mods/<name>` (the original goes to the Trash) and adds that folder to `CLAUDE_CODE_PLUGIN_DIRS`. */
  keepDraft(id: string): Promise<{ id: string; snapshotId: string | null }>
  /** Moves a draft, or a mod folder inside the config dir, to the Trash (and drops it from `CLAUDE_CODE_PLUGIN_DIRS`). */
  trash(id: string): Promise<{ snapshotId: string | null }>
  /** Moves the mod's `$.store` file to the Trash. */
  clearStore(id: string): Promise<void>
}

export interface ModsEvents {}
