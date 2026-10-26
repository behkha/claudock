/**
 * Plugins domain contract. Owned by the extend worker.
 * Installing and removing plugins is left to `/plugin` in Claude Code; only enable / disable is written here.
 */

export interface PluginContents {
  skills: string[]
  agents: string[]
  commands: string[]
  /** Number of hook handlers across all events. */
  hooks: number
  hookEvents: string[]
  mcpServers: string[]
  /** hooks/hooks.json has a `modules` key: the plugin is a mod (shown on the Mods screen). */
  mod: boolean
}

export interface PluginInfo {
  /** `name@marketplace`: the key used in settings.json `enabledPlugins`. */
  key: string
  name: string
  marketplace: string
  version: string
  scope: string
  /** "unset" = installed but missing from enabledPlugins. */
  state: 'on' | 'off' | 'unset'
  enabled: boolean
  /** False for keys that exist only in enabledPlugins (built-in or removed plugins). */
  installed: boolean
  description: string
  author: string
  homepage: string
  license: string
  installedAt?: string
  lastUpdated?: string
  gitCommitSha?: string
  /** Absolute install folder ('' when unknown). */
  dir: string
  /** Install folder relative to the config dir; null when it lies outside it. */
  rel: string | null
  /** Null when the cache folder is missing. */
  contents: PluginContents | null
}

export interface MarketplaceInfo {
  name: string
  /** "github", "git", "directory", "url", ... */
  sourceKind: string
  /** Human readable: `anthropics/claude-plugins-official`, a path or a URL. */
  sourceText: string
  installLocation: string
  lastUpdated?: string
  /** Number of plugins listed in its marketplace.json, or null if unreadable. */
  pluginCount: number | null
  /** Keys of installed plugins that come from this marketplace. */
  installed: string[]
  /** Listed in plugins/known_marketplaces.json. */
  known: boolean
  /** Listed in settings.json extraKnownMarketplaces. */
  inSettings: boolean
}

export interface PluginList {
  plugins: PluginInfo[]
  marketplaces: MarketplaceInfo[]
  settingsError?: string
}

export interface PluginsApi {
  list(): Promise<PluginList>
  /** Writes `enabledPlugins[key]` in settings.json. */
  setEnabled(key: string, enabled: boolean): Promise<{ snapshotId: string | null }>
}

export interface PluginsEvents {}
