import type { IpcMain } from 'electron'
import type { SidebarCount } from '@shared/types'

/**
 * Shape of a domain module. `register` is required; `count` is optional and feeds the sidebar badge
 * for the screen with the same id (cheap! return undefined when it would need a slow scan).
 */
export interface DomainModule {
  register(ipcMain: IpcMain): void
  count?(): Promise<SidebarCount | undefined> | SidebarCount | undefined
}
