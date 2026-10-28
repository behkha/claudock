import { app, type IpcMain } from 'electron'
import type { MenubarApi } from '@shared/api/menubar'
import { defineDomain } from '../ipcx'
import { closePopover, fitPopover, menuBarState, openWindow, setMenuBar } from '../menubar'

/** Menu bar: what the popover asks for that only the menu bar has. The item itself lives in src/main/menubar.ts. */
export function register(ipcMain: IpcMain): void {
  const impl: MenubarApi = {
    get: menuBarState,
    set: (patch) => setMenuBar(typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? patch : {}),
    openWindow: async () => openWindow(),
    openPalette: async () => openWindow(true),
    fit: async (height) => fitPopover(height),
    close: async () => closePopover(),
    quit: async () => app.quit()
  }
  defineDomain(ipcMain, 'menubar', impl)
}
