import type { Platform } from './types'
/**
 * IPC contract: one namespace per domain, channel name = `<domain>:<method>`.
 * Do not edit when adding a method — edit `src/shared/api/<domain>.ts`.
 */
import type { SystemApi, SystemEvents } from './api/system'
import type { OverviewApi, OverviewEvents } from './api/overview'
import type { StorageApi, StorageEvents } from './api/storage'
import type { BackupsApi, BackupsEvents } from './api/backups'
import type { SettingsApi, SettingsEvents } from './api/settings'
import type { RulesApi, RulesEvents } from './api/rules'
import type { HooksApi, HooksEvents } from './api/hooks'
import type { PermissionsApi, PermissionsEvents } from './api/permissions'
import type { SkillsApi, SkillsEvents } from './api/skills'
import type { AgentsApi, AgentsEvents } from './api/agents'
import type { CommandsApi, CommandsEvents } from './api/commands'
import type { PluginsApi, PluginsEvents } from './api/plugins'
import type { ModsApi, ModsEvents } from './api/mods'
import type { McpApi, McpEvents } from './api/mcp'
import type { ProjectsApi, ProjectsEvents } from './api/projects'
import type { MemoryApi, MemoryEvents } from './api/memory'
import type { PlansApi, PlansEvents } from './api/plans'
import type { HistoryApi, HistoryEvents } from './api/history'
import type { SearchApi, SearchEvents } from './api/search'
import type { LimitsApi, LimitsEvents } from './api/limits'
import type { SessionsApi, SessionsEvents } from './api/sessions'
import type { ConnectApi, ConnectEvents } from './api/connect'
import type { MenubarApi, MenubarEvents } from './api/menubar'

export const DOMAINS = [
  'system',
  'overview',
  'storage',
  'backups',
  'settings',
  'rules',
  'hooks',
  'permissions',
  'skills',
  'agents',
  'commands',
  'plugins',
  'mods',
  'mcp',
  'projects',
  'memory',
  'plans',
  'history',
  'search',
  'limits',
  'sessions',
  'connect',
  'menubar'
] as const

export type DomainName = (typeof DOMAINS)[number]

export interface ClaudockApi {
  system: SystemApi
  overview: OverviewApi
  storage: StorageApi
  backups: BackupsApi
  settings: SettingsApi
  rules: RulesApi
  hooks: HooksApi
  permissions: PermissionsApi
  skills: SkillsApi
  agents: AgentsApi
  commands: CommandsApi
  plugins: PluginsApi
  mods: ModsApi
  mcp: McpApi
  projects: ProjectsApi
  memory: MemoryApi
  plans: PlansApi
  history: HistoryApi
  search: SearchApi
  limits: LimitsApi
  sessions: SessionsApi
  connect: ConnectApi
  menubar: MenubarApi
}

/** Main -> renderer events. Each event name starts with `<domain>:`; the payload type is the value. */
export type ClaudockEvents = SystemEvents &
  OverviewEvents &
  StorageEvents &
  BackupsEvents &
  SettingsEvents &
  RulesEvents &
  HooksEvents &
  PermissionsEvents &
  SkillsEvents &
  AgentsEvents &
  CommandsEvents &
  PluginsEvents &
  ModsEvents &
  McpEvents &
  ProjectsEvents &
  MemoryEvents &
  PlansEvents &
  HistoryEvents &
  SearchEvents &
  LimitsEvents &
  SessionsEvents &
  ConnectEvents &
  MenubarEvents

/** Compile-time check that DOMAINS and ClaudockApi list exactly the same names. */
type _Same = [DomainName] extends [keyof ClaudockApi] ? ([keyof ClaudockApi] extends [DomainName] ? true : never) : never
export const _domainsMatchApi: _Same = true

export const channel = (domain: DomainName, method: string): string => `${domain}:${method}`

/** Channels the preload bridge will forward: `<known domain>:<name>`. */
const CHANNEL_RE = new RegExp(`^(${DOMAINS.join('|')}):[A-Za-z][A-Za-z0-9_.-]*$`)
export const isAllowedChannel = (ch: unknown): ch is string => typeof ch === 'string' && CHANNEL_RE.test(ch)

/** What the preload script exposes as `window.claudock` (generic; the typed facade is `api` in renderer/lib/api.ts). */
export interface ClaudockBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  /** Subscribe to a main->renderer event. Returns an unsubscribe function. */
  on(channel: string, cb: (payload: unknown) => void): () => void
  platform: Platform
}
