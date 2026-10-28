import { app, shell, type IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SystemApi } from '@shared/api/system'
import type { Platform } from '@shared/types'
import { dirSize, exists } from '../fsx'
import { defineDomain, emit } from '../ipcx'
import { configDir, globalStateFile, assertNotSecretReal, installKind, isCustomConfigDir, isSecret, resolveInside, userDataDir, writesAllowed } from '../paths'
import { checkUpdate } from '../update'
import { currentTheme, setTheme } from '../theme'
import { shouldReveal } from '../firstRun'
import { loadPrefs, savePrefs } from '../prefs'
import { status as connectStatus } from './connect'
import { collectCounts } from './index'

declare const __APP_VERSION__: string

const SHOT = process.env.CLAUDOCK_SHOT === '1'
/** CLAUDOCK_REVEAL=1: show the first-run reveal on every launch, without writing that it was seen (development). */
const REVEAL = process.env.CLAUDOCK_REVEAL === '1'
/** settings.json unreadable: count as not connected, so the reveal still offers Connect (the sheet explains). */
const OFF = { statusLine: 'off', hooks: 'off' } as const

/** Extensions we are willing to hand to the OS default app. Never scripts or executables. */
const OPENABLE = new Set(['.md', '.markdown', '.mdx', '.json', '.jsonl', '.txt', '.yml', '.yaml', '.toml', '.log', '.ini', '.cfg', '.csv'])

const impl: SystemApi = {
  async configInfo() {
    return {
      configDir: configDir(),
      globalStateFile: globalStateFile(),
      exists: await exists(configDir()),
      home: os.homedir(),
      sep: path.sep,
      platform: process.platform as Platform,
      customDir: isCustomConfigDir(),
      writable: writesAllowed(),
      userData: userDataDir()
    }
  },

  async configSize(opts) {
    const scanId = opts?.scanId ?? 'config'
    const result = await dirSize(configDir(), {
      force: opts?.force,
      followRoot: true,
      onProgress: (p) => emit('system:sizeProgress', { scanId, ...p, done: false })
    })
    emit('system:sizeProgress', { scanId, bytes: result.bytes, files: result.files, done: true })
    return result
  },

  async appInfo() {
    return {
      name: app.getName(),
      version: __APP_VERSION__,
      electron: process.versions.electron,
      platform: process.platform as Platform,
      arch: process.arch,
      packaged: app.isPackaged,
      install: installKind()
    }
  },

  async checkUpdate() {
    return checkUpdate()
  },

  async reveal(p) {
    const abs = resolveInside(p)
    await assertNotSecretReal(abs)
    shell.showItemInFolder(abs)
  },

  async openInEditor(p) {
    const abs = resolveInside(p)
    // Judge the file the OS will really open: a symlink named notes.md must not smuggle in a script or a secret.
    let real: string
    try {
      real = await fsp.realpath(abs)
    } catch {
      throw new Error('This file no longer exists')
    }
    if (isSecret(abs) || isSecret(real)) throw new Error('This file is hidden for safety')
    if (!OPENABLE.has(path.extname(abs).toLowerCase()) || !OPENABLE.has(path.extname(real).toLowerCase())) {
      throw new Error('Only text files can be opened in an editor. Use Reveal instead.')
    }
    if (!(await fsp.stat(real)).isFile()) throw new Error('Only files can be opened in an editor. Use Reveal instead.')
    const err = await shell.openPath(real)
    if (err) throw new Error(err)
  },

  async getTheme() {
    return currentTheme()
  },

  async setTheme(pref) {
    return setTheme(pref)
  },

  async sidebarCounts() {
    return collectCounts()
  },

  async firstRun() {
    const [prefs, connect] = await Promise.all([loadPrefs(), connectStatus().catch(() => OFF)])
    return shouldReveal({ revealed: prefs.revealed, connect, forced: REVEAL, shot: SHOT })
  },

  async finishFirstRun() {
    if (!REVEAL) await savePrefs({ revealed: true })
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'system', impl)
}
