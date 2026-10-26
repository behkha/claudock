import type { ComponentType } from 'react'
import type { ScreenId } from '@shared/nav'
import type { ScreenProps } from '@/lib/nav'
import OverviewScreen from './Overview'
import SettingsScreen from './Settings'
import RulesScreen from './Rules'
import HooksScreen from './Hooks'
import PermissionsScreen from './Permissions'
import SkillsScreen from './Skills'
import AgentsScreen from './Agents'
import CommandsScreen from './Commands'
import PluginsScreen from './Plugins'
import ModsScreen from './Mods'
import McpScreen from './Mcp'
import ProjectsScreen from './Projects'
import MemoryScreen from './Memory'
import PlansScreen from './Plans'
import HistoryScreen from './History'
import StorageScreen from './Storage'
import BackupsScreen from './Backups'

/** Every screen, by id. Each lives in screens/<Folder>/index.tsx and default-exports a component taking ScreenProps. */
export const SCREEN_COMPONENTS: Record<ScreenId, ComponentType<ScreenProps>> = {
  overview: OverviewScreen,
  settings: SettingsScreen,
  rules: RulesScreen,
  hooks: HooksScreen,
  permissions: PermissionsScreen,
  skills: SkillsScreen,
  agents: AgentsScreen,
  commands: CommandsScreen,
  plugins: PluginsScreen,
  mods: ModsScreen,
  mcp: McpScreen,
  projects: ProjectsScreen,
  memory: MemoryScreen,
  plans: PlansScreen,
  history: HistoryScreen,
  storage: StorageScreen,
  backups: BackupsScreen
}
