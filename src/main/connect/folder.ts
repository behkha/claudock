import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { configDir, userDataDir } from '../paths'
import type { Baseline } from './baseline'

/**
 * Claudock's own folder for "Connect to Claude Code": `<userData>/connect/<config dir hash>/`, one per config folder,
 * so the fixture and the real folder (and several accounts) never share anything. Holds the status line step
 * (statusline.sh, limits.json), the session hooks' script (hook.sh) and the lines they append per session (sessions/*.jsonl),
 * and state.json. App data, not config: written directly (temp file + rename), like prefs.json, never snapshotted.
 */

const WIN = process.platform === 'win32'

/** A config folder's key: its connect folder's name, and its profile id (src/main/domains/profiles.ts). */
export function folderKey(configFolder: string): string {
  const key = WIN || process.platform === 'darwin' ? configFolder.toLowerCase() : configFolder
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12)
}

/** The connect folder of any config folder; every profile has its own. */
export const connectDirFor = (configFolder: string): string => path.join(userDataDir(), 'connect', folderKey(configFolder))

/** The connect folder of the profile open in the window. */
export const connectDir = (): string => connectDirFor(configDir())

export async function writeOwn(name: string, text: string, mode = 0o644, dir = connectDir()): Promise<void> {
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  await fsp.writeFile(tmp, text, { mode })
  await fsp.rename(tmp, path.join(dir, name))
}

export const removeOwn = (name: string): Promise<void> => fsp.rm(path.join(connectDir(), name), { recursive: true, force: true })

/** What was connected and how to undo it. Written before settings.json changes, removed after Disconnect. */
export interface ConnectState {
  v: 2
  /** The status line step is installed: statusLine exactly as it was before (`present: false` when there was none). */
  statusLine: { original: { present: true; value: unknown } | { present: false } } | null
  /** The session hooks are installed: the containers adding them created, so removing them drops exactly those. */
  hooks: { hooksKey: boolean; events: string[] } | null
  /**
   * settings.json before the first connect, for a byte-identical Disconnect: the snapshot holding its bytes (null when
   * the file did not exist), and the SHA-256 of the text Claudock wrote last. Null once anything else changed the file.
   */
  baseline: Baseline | null
  at: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function readConnectState(dir = connectDir()): Promise<ConnectState | null> {
  try {
    const s = JSON.parse(await fsp.readFile(path.join(dir, 'state.json'), 'utf8')) as ConnectState
    if (s?.v !== 2) return null
    if (s.statusLine !== null && !(isObj(s.statusLine) && isObj(s.statusLine.original) && typeof s.statusLine.original.present === 'boolean')) return null
    if (s.hooks !== null && !(isObj(s.hooks) && typeof s.hooks.hooksKey === 'boolean' && Array.isArray(s.hooks.events))) return null
    if (s.baseline !== null && !(isObj(s.baseline) && typeof s.baseline.existed === 'boolean' && typeof s.baseline.sha === 'string')) return null
    return s
  } catch {
    return null
  }
}

export const writeConnectState = (s: ConnectState): Promise<void> => writeOwn('state.json', JSON.stringify(s, null, 2) + '\n')

export const sha256 = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex')

let chain: Promise<unknown> = Promise.resolve()
/** Connect, Disconnect and any rewrite of the connect folder's scripts run one at a time. */
export function connectSerial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}
