import { BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import type { ClaudockApi, ClaudockEvents, DomainName } from '@shared/ipc'
import { channel } from '@shared/ipc'
import { withConfigDir } from './paths'

/**
 * Register every method of a domain implementation as `ipcMain.handle('<domain>:<method>')`.
 * `impl` must implement the whole `<Domain>Api` interface, so a method added to the interface but not implemented
 * is a compile error. Handlers only answer the main frame of our own windows.
 */
export function defineDomain<K extends DomainName>(ipcMain: IpcMain, domain: K, impl: ClaudockApi[K]): void {
  for (const [method, fn] of Object.entries(impl as unknown as Record<string, (...a: unknown[]) => unknown>)) {
    if (typeof fn !== 'function') continue
    ipcMain.handle(channel(domain, method), (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!BrowserWindow.fromWebContents(e.sender)) throw new Error('Unknown sender')
      // Only the top-level page may call us: never a sub-frame, and never a frame that has already gone away.
      if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) throw new Error('Unknown sender')
      // the whole call works on the folder open when it started (profiles is what changes it)
      return domain === 'profiles' ? fn(...args) : withConfigDir(() => fn(...args))
    })
  }
}

/** Send a main->renderer event to every window. `name` must be a key of `ClaudockEvents` (`<domain>:<event>`). */
export function emit<K extends keyof ClaudockEvents>(name: K, payload: ClaudockEvents[K]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(name as string, payload)
}
