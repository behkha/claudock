import { app } from 'electron'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LAUNCH_AGENT_LABEL, LOGIN_ARG, autostartEntry, launchAgent, unstablePath } from './menubar/loginFiles'
import { installKind, isInside, launchEnv } from './paths'
import { demoMode } from './demo'

/**
 * Open at login, for the menu bar. macOS: a LaunchAgent in ~/Library/LaunchAgents; Linux: an autostart entry in
 * ~/.config/autostart; Windows: the Run key, through Electron. Each starts this copy with `--login`, which opens only
 * the menu bar item. A git clone can't, and neither can a copy in npx's cache, whose path changes; the copy
 * `npx claudock` keeps in Claudock's own folder on macOS (bin/macApp.js) has a fixed path, so it can.
 */

const MAC = process.platform === 'darwin'
const WIN = process.platform === 'win32'

/** The command that starts this copy, or null when a login item for it would break. */
function command(): string[] | null {
  // the demo would start at login on a made-up config, from a login item the real copy shares
  if (installKind() === 'dev' || demoMode) return null
  // an AppImage runs from a temporary mount; APPIMAGE is the file itself
  const exe = process.env.APPIMAGE || process.execPath
  const appPath = app.getAppPath()
  if (unstablePath(exe) || unstablePath(appPath)) return null
  // a line break in a path would end the plist string or the desktop entry's Exec line
  if ([exe, appPath, ...Object.values(env())].some((p) => [...p].some((c) => c.charCodeAt(0) < 0x20))) return null
  // a packaged app, or a macOS bundle with the app folder inside it, loads its app by itself
  const loadsItself = app.isPackaged || (MAC && isInside(path.resolve(path.dirname(exe), '..', 'Resources'), appPath))
  // Linux: started without Chromium's sandbox because the system blocks it (bin/claudock.js), so at login too
  const noSandbox = process.platform === 'linux' && !process.env.APPIMAGE && process.argv.includes('--no-sandbox')
  return [exe, ...(noSandbox ? ['--no-sandbox'] : []), ...(loadsItself ? [] : [appPath]), LOGIN_ARG]
}

// the folder it was started on, not the profile open now: at login it reopens the last profile by itself
const env = launchEnv

function file(): string {
  if (MAC) return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'claudock.desktop')
}

const text = (cmd: string[]): string => (MAC ? launchAgent(cmd, env()) : autostartEntry(cmd, env()))

/** This copy started from its login item. */
export const openedAtLogin = (): boolean => process.argv.includes(LOGIN_ARG)

export const loginItemAvailable = (): boolean => command() !== null

export async function isOpenAtLogin(): Promise<boolean> {
  const cmd = command()
  if (!cmd) return false
  if (WIN) return app.getLoginItemSettings({ path: cmd[0], args: cmd.slice(1) }).openAtLogin
  return (await fsp.stat(file()).catch(() => null))?.isFile() === true
}

export async function setOpenAtLogin(on: boolean): Promise<void> {
  const cmd = command()
  if (!cmd) throw new Error('Open at login needs Claudock from an installer or from npm install -g claudock')
  if (WIN) return app.setLoginItemSettings({ openAtLogin: on, path: cmd[0], args: cmd.slice(1) })
  if (!on) return void (await fsp.rm(file(), { force: true }))
  await writeAtomic(file(), text(cmd))
}

async function writeAtomic(target: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  await fsp.writeFile(tmp, body, { mode: 0o644 })
  await fsp.rename(tmp, target)
}
