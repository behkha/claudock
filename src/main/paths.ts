import { app } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { InstallKind } from '@shared/types'

/**
 * CLAUDE_CONFIG_DIR, trimmed, or null when unset or blank. On Windows `set CLAUDE_CONFIG_DIR="C:\x"` keeps the quotes in
 * the value, and '"' can never be part of a Windows path, so one surrounding pair is dropped there.
 */
function envConfigDir(): string | null {
  let v = (process.env.CLAUDE_CONFIG_DIR ?? '').trim()
  if (process.platform === 'win32' && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).trim()
  return v || null
}

/** The folder Claudock was started on: CLAUDE_CONFIG_DIR if set, else ~/.claude (same rule as Claude Code). */
export function launchConfigDir(): string {
  return path.resolve(envConfigDir() ?? path.join(os.homedir(), '.claude'))
}

/** CLAUDE_CONFIG_DIR as Claudock was started with it, for a login item that starts it the same way. */
export const launchEnv = (): Record<string, string> => (envConfigDir() !== null ? { CLAUDE_CONFIG_DIR: launchConfigDir() } : {})

/** The folder of the profile open in the window (src/main/domains/profiles.ts); null until profiles load: the launch folder. */
let active: string | null = null
const dirListeners = new Set<() => void>()
/** The folder an IPC call started on, kept for all of that call (`withConfigDir`). */
const pinned = new AsyncLocalStorage<string>()

/**
 * Config dir: the folder the running IPC call started on, else the open profile's folder (the launch folder until
 * another profile is opened). So a write that is under way when another profile opens finishes in its own folder.
 */
export function configDir(): string {
  return pinned.getStore() ?? openConfigDir()
}

/** The folder open in the window right now, whatever folder the running call started on. */
export function openConfigDir(): string {
  return active ?? launchConfigDir()
}

/** Run `fn` (an IPC handler) on the folder open now, to the end of it, even if another profile opens meanwhile. */
export const withConfigDir = <T>(fn: () => T): T => pinned.run(openConfigDir(), fn)

/** Open another profile's folder. Modules that cache per folder clear themselves through `onConfigDirChanged`. */
export function setConfigDir(dir: string): void {
  const next = path.resolve(dir)
  if (active !== null && samePath(active, next)) return
  active = next
  // outside any call's pinned folder: the listeners work on the folder now open
  pinned.exit(() => {
    for (const cb of dirListeners) cb()
  })
}

/** The folder snapshots taken before profiles (no `dir` in their manifest) belong to: the launch folder profiles first saw. */
let legacy: string | null = null
export const setLegacySnapshotDir = (dir: string): void => void (legacy = path.resolve(dir))
export const legacySnapshotDir = (): string => legacy ?? launchConfigDir()

export const onConfigDirChanged = (cb: () => void): void => void dirListeners.add(cb)

/**
 * Claude Code keeps its global state in `~/.claude.json` only for `~/.claude` started without CLAUDE_CONFIG_DIR; any
 * folder given through the env var keeps it inside. A profile on `~/.claude` is started with plain `claude`, unless it is
 * the launch folder and the env var named it (then the app was started the way Claude Code is).
 */
export function usesHomeState(dir: string): boolean {
  if (!samePath(dir, path.join(os.homedir(), '.claude'))) return false
  return envConfigDir() === null || !samePath(dir, launchConfigDir())
}

/** The global state file lives inside the config dir (it isn't `~/.claude.json`). */
export function isCustomConfigDir(): boolean {
  return !usesHomeState(configDir())
}

/** Global state file: `~/.claude.json` for `~/.claude` started without the env var, else `.claude.json` inside the folder. */
export function globalStateFile(): string {
  return usesHomeState(configDir()) ? path.join(os.homedir(), '.claude.json') : path.join(configDir(), '.claude.json')
}

/** Key used for the global state file inside snapshots and in `rel` arguments. */
export const GLOBAL_STATE_REL = '.claude.json'

export function userDataDir(): string {
  return app.getPath('userData')
}

export function snapshotsDir(): string {
  return path.join(userDataDir(), 'snapshots')
}

let kind: InstallKind | undefined

/**
 * How this copy was installed. `npx claudock` runs the plain app folder with npm's Electron, so `app.isPackaged` is false
 * there too; that folder sits directly in a node_modules folder, a git clone does not.
 */
export function installKind(): InstallKind {
  return (kind ??= detectInstallKind())
}

function detectInstallKind(): InstallKind {
  // the Claudock.app `npx claudock` keeps in userData on macOS (bin/macApp.js) holds a copy of the npm app folder
  if (fs.existsSync(path.join(app.getAppPath(), 'claudock-npm-copy.json'))) return 'npm'
  if (app.isPackaged) return 'installer'
  return path.basename(path.dirname(app.getAppPath())) === 'node_modules' ? 'npm' : 'dev'
}

/**
 * Development safety (SPEC rule 7): a development build (not an installer, not from npm) refuses to write unless the open
 * folder is the one CLAUDE_CONFIG_DIR named (point it at ./.fixture/claude) or a synthetic one (FIXTURE_MARK, like
 * ./.fixture/claude-work), or CLAUDOCK_ALLOW_REAL_WRITES=1 is set explicitly.
 * CLAUDOCK_READONLY=1 refuses every write, however it was installed.
 */
export function writesAllowed(): boolean {
  if (process.env.CLAUDOCK_READONLY === '1') return false
  if (installKind() !== 'dev') return true
  if (process.env.CLAUDOCK_ALLOW_REAL_WRITES === '1') return true
  // the folder CLAUDE_CONFIG_DIR named, or a synthetic profile beside it (never a real folder added as a profile)
  return (envConfigDir() !== null && samePath(configDir(), launchConfigDir())) || fs.existsSync(path.join(configDir(), FIXTURE_MARK))
}

/** In a folder the fixture generators (or a development build's "New folder") made: a development build may write there. */
export const FIXTURE_MARK = '.claudock-fixture'

export function assertWritable(): void {
  if (!writesAllowed()) {
    throw new Error(
      'Writes are disabled in development unless CLAUDE_CONFIG_DIR points at a fixture (run `npm run dev`, or set CLAUDOCK_ALLOW_REAL_WRITES=1).'
    )
  }
}

/** `abs` is `root` or below it. Safe across drives: there `path.relative` returns an absolute path, which counts as outside. */
export function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * Resolve a renderer-supplied path to an absolute path inside the config dir. Accepts a path relative to the
 * config dir, or an absolute path that is already inside it. Throws on escape (`..`, other roots, NUL bytes).
 * The special rel `.claude.json` maps to the global state file (which may live outside the config dir).
 * Lexical check only: symlinked children are allowed to be read (users symlink skills), but safeWrite refuses
 * to replace a symlink.
 */
export function resolveInside(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('Path is empty')
  if (rel.includes('\0')) throw new Error('Invalid path')
  if (rel === GLOBAL_STATE_REL) return globalStateFile()
  const root = configDir()
  const abs = path.resolve(root, rel)
  // any spelling of the global state file (other case, other separators) gets the exact path, so writes go through updateGlobalState's rules
  if (samePath(abs, globalStateFile())) return globalStateFile()
  if (!isInside(root, abs)) throw new Error(`Path escapes the config folder: ${rel}`)
  return abs
}

/** Config-dir-relative path (OS separators) for an absolute path; throws if outside. The global state file maps to `.claude.json`. */
export function toRel(abs: string): string {
  if (samePath(abs, globalStateFile())) return GLOBAL_STATE_REL
  const root = configDir()
  const resolved = path.resolve(abs)
  if (!isInside(root, resolved)) throw new Error(`Path is outside the config folder: ${abs}`)
  return path.relative(root, resolved)
}

/** Compare paths the way every supported filesystem might: resolved, and case-folded (macOS / Windows are case-insensitive by default). */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

const WIN = process.platform === 'win32'

/** Split a path into lower-cased segments. On Windows trailing dots/spaces are ignored by the filesystem. */
function segmentsOf(p: string): string[] {
  const norm = path.normalize(p)
  return norm.split(WIN ? /[\\/]+/ : /\/+/).map((seg) => {
    const s = seg.toLowerCase()
    return WIN ? s.replace(/[. ]+$/, '') : s
  })
}

/** Windows: ':' only belongs in a drive prefix; elsewhere it is an alternate data stream (`.credentials.json::$DATA`). */
function hasStreamSuffix(segs: string[]): boolean {
  return WIN && segs.some((seg, i) => seg.includes(':') && !(i <= 2 && /^[a-z]:$/.test(seg)))
}

/**
 * Secrets that must never be read, copied, displayed or snapshotted:
 * `.credentials.json` anywhere, and `*.key` files below any `sessions` folder.
 * The comparison is case-insensitive on every OS (over-blocking on Linux is harmless) and on Windows ignores trailing
 * dots/spaces and refuses alternate data streams. This is lexical: use `isSecretReal` before touching the file, so a
 * symlink or 8.3 short name cannot smuggle a secret through.
 */
export function isSecret(p: string): boolean {
  const segs = segmentsOf(p)
  if (hasStreamSuffix(segs)) return true
  const base = segs[segs.length - 1] ?? ''
  if (base === '.credentials.json') return true
  if (base.endsWith('.key')) {
    let parents = segs.slice(0, -1)
    const norm = path.normalize(p)
    if (path.isAbsolute(norm)) {
      const r = path.relative(configDir(), norm)
      if (!r.startsWith('..') && !path.isAbsolute(r)) parents = segmentsOf(r).slice(0, -1)
    }
    if (parents.includes('sessions')) return true
  }
  return false
}

/** realpath of `abs`, or of its deepest existing ancestor plus the missing tail. Throws on anything but "not there yet". */
export async function realPathLoose(abs: string): Promise<string> {
  let cur = path.resolve(abs)
  const tail: string[] = []
  for (;;) {
    try {
      const r = await fsp.realpath(cur)
      return tail.length ? path.join(r, ...tail.reverse()) : r
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(abs)
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

/** Lexical check plus a check of where the path really points (symlinks, junctions, 8.3 names). */
export async function isSecretReal(abs: string): Promise<boolean> {
  if (isSecret(abs)) return true
  return isSecret(await realPathLoose(abs))
}

export function assertNotSecret(p: string): void {
  if (isSecret(p)) throw new Error('This file is hidden for safety')
}

export async function assertNotSecretReal(p: string): Promise<void> {
  if (await isSecretReal(p)) throw new Error('This file is hidden for safety')
}
