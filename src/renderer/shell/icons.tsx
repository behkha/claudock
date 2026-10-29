import {
  Archive,
  Blocks,
  Bot,
  ClipboardList,
  FileText,
  FolderOpen,
  HardDrive,
  History,
  CalendarDays,
  MessagesSquare,
  Brain,
  Plug,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Webhook,
  type LucideIcon
} from 'lucide-react'
import type { ScreenId } from '@shared/nav'

export const SCREEN_ICONS: Record<ScreenId, LucideIcon> = {
  today: CalendarDays,
  settings: Settings,
  rules: FileText,
  hooks: Webhook,
  permissions: ShieldCheck,
  skills: Sparkles,
  agents: Bot,
  commands: Terminal,
  plugins: Puzzle,
  mods: Blocks,
  mcp: Plug,
  archive: MessagesSquare,
  projects: FolderOpen,
  memory: Brain,
  plans: ClipboardList,
  history: History,
  storage: HardDrive,
  backups: Archive
}
