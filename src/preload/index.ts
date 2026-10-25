import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isAllowedChannel, type ClaudockBridge } from '@shared/ipc'
import type { Platform } from '@shared/types'

/**
 * Generic bridge: no per-method code lives here. The renderer's `api` facade (src/renderer/lib/api.ts) turns
 * `api.<domain>.<method>(...args)` into `invoke('<domain>:<method>', ...args)`. Only `<known domain>:<name>`
 * channels are forwarded, in both directions.
 */
const bridge: ClaudockBridge = {
  invoke(channel, ...args) {
    if (!isAllowedChannel(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${String(channel)}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel, cb) {
    if (!isAllowedChannel(channel)) throw new Error(`Blocked IPC channel: ${String(channel)}`)
    const handler = (_e: IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, handler)
    return () => void ipcRenderer.removeListener(channel, handler)
  },
  platform: process.platform as Platform
}

contextBridge.exposeInMainWorld('claudock', bridge)
