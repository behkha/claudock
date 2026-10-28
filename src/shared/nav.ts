/**
 * Navigation model shared by main (screenshot mode, search results) and renderer (sidebar, router).
 * Screen id === domain name === `src/main/domains/<id>.ts`.
 * The renderer folder for each screen is `src/renderer/screens/<folder>/index.tsx`.
 */
export type ScreenId =
  | 'today'
  | 'settings'
  | 'rules'
  | 'hooks'
  | 'permissions'
  | 'skills'
  | 'agents'
  | 'commands'
  | 'plugins'
  | 'mods'
  | 'mcp'
  | 'projects'
  | 'memory'
  | 'plans'
  | 'history'
  | 'storage'
  | 'backups'

export type NavGroup = 'Home' | 'Configure' | 'Extend' | 'Your data' | 'Maintain'

export interface ScreenDef {
  id: ScreenId
  label: string
  group: NavGroup
  /** Folder name under src/renderer/screens */
  folder: string
}

export const NAV_GROUPS: NavGroup[] = ['Home', 'Configure', 'Extend', 'Your data', 'Maintain']

export const SCREENS: ScreenDef[] = [
  { id: 'today', label: 'Today', group: 'Home', folder: 'Today' },
  { id: 'settings', label: 'Settings', group: 'Configure', folder: 'Settings' },
  { id: 'rules', label: 'CLAUDE.md & rules', group: 'Configure', folder: 'Rules' },
  { id: 'hooks', label: 'Hooks', group: 'Configure', folder: 'Hooks' },
  { id: 'permissions', label: 'Permissions', group: 'Configure', folder: 'Permissions' },
  { id: 'skills', label: 'Skills', group: 'Extend', folder: 'Skills' },
  { id: 'agents', label: 'Agents', group: 'Extend', folder: 'Agents' },
  { id: 'commands', label: 'Commands', group: 'Extend', folder: 'Commands' },
  { id: 'plugins', label: 'Plugins', group: 'Extend', folder: 'Plugins' },
  { id: 'mods', label: 'Mods', group: 'Extend', folder: 'Mods' },
  { id: 'mcp', label: 'MCP servers', group: 'Extend', folder: 'Mcp' },
  { id: 'projects', label: 'Projects', group: 'Your data', folder: 'Projects' },
  { id: 'memory', label: 'Memory', group: 'Your data', folder: 'Memory' },
  { id: 'plans', label: 'Plans', group: 'Your data', folder: 'Plans' },
  { id: 'history', label: 'History', group: 'Your data', folder: 'History' },
  { id: 'storage', label: 'Storage', group: 'Maintain', folder: 'Storage' },
  { id: 'backups', label: 'Backups', group: 'Maintain', folder: 'Backups' }
]

export const SCREEN_BY_ID: Record<ScreenId, ScreenDef> = Object.fromEntries(
  SCREENS.map((s) => [s.id, s])
) as Record<ScreenId, ScreenDef>

export function isScreenId(v: unknown): v is ScreenId {
  return typeof v === 'string' && v in SCREEN_BY_ID
}
