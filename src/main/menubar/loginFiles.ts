/**
 * The files that open Claudock at login, as text: a LaunchAgent on macOS, an autostart entry on Linux. Pure, so
 * `npm test` loads it as is; src/main/loginItem.ts writes and removes them. Both pass `--login`, which tells Claudock
 * to start with only its menu bar item.
 */

export const LOGIN_ARG = '--login'
export const LAUNCH_AGENT_LABEL = 'app.claudock.login'

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** ~/Library/LaunchAgents/app.claudock.login.plist: runs `args` once at login, in the user's GUI session. */
export function launchAgent(args: readonly string[], env: Readonly<Record<string, string>> = {}): string {
  const keys = Object.keys(env)
  const envBlock = keys.length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${keys.map((k) => `    <key>${xml(k)}</key>\n    <string>${xml(env[k])}</string>\n`).join('')}  </dict>\n`
    : ''
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    `  <key>Label</key>\n  <string>${LAUNCH_AGENT_LABEL}</string>\n` +
    `  <key>ProgramArguments</key>\n  <array>\n${args.map((a) => `    <string>${xml(a)}</string>\n`).join('')}  </array>\n` +
    envBlock +
    '  <key>RunAtLoad</key>\n  <true/>\n' +
    '  <key>LimitLoadToSessionType</key>\n  <string>Aqua</string>\n' +
    '</dict>\n</plist>\n'
  )
}

/** One argument of a desktop entry's Exec line, quoted per the Desktop Entry spec when it needs it. */
export function execArg(a: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a)) return a
  return `"${a.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`
}

/** ~/.config/autostart/claudock.desktop. Percent signs are doubled: the spec reserves them for field codes. */
export function autostartEntry(args: readonly string[], env: Readonly<Record<string, string>> = {}): string {
  const pre = Object.entries(env).map(([k, v]) => execArg(`${k}=${v}`))
  // the value itself is a string with its own escapes, so each backslash from the quoting is doubled again
  const exec = [...(pre.length ? ['env', ...pre] : []), ...args.map(execArg)]
    .join(' ')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '%%')
  return `[Desktop Entry]\nType=Application\nName=Claudock\nExec=${exec}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`
}

/** Paths in npx's cache change from run to run, so a login item pointing there would break. */
export const inNpxCache = (p: string): boolean => /[\\/]_npx[\\/]/.test(p)

/**
 * A path a login item can't rely on: npx's cache, a disk image still mounted under /Volumes, or the temporary copy
 * macOS runs an app from before it is moved out of Downloads (App Translocation).
 */
export const unstablePath = (p: string): boolean => inNpxCache(p) || p.startsWith('/Volumes/') || p.includes('/AppTranslocation/')
