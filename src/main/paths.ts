import { app } from 'electron'
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

/** Config dir: CLAUDE_CONFIG_DIR if set, else ~/.claude (same rule as Claude Code). */
export function configDir(): string {
  return path.resolve(envConfigDir() ?? path.join(os.homedir(), '.claude'))
}

export function isCustomConfigDir(): boolean {
  return envConfigDir() !== null
}

/** Global state file: $CLAUDE_CONFIG_DIR/.claude.json when the env var is set, else ~/.claude.json. */
export function globalStateFile(): string {
  return isCustomConfigDir() ? path.join(configDir(), '.claude.json') : path.join(os.homedir(), '.claude.json')
}

/** Key used for the global state file inside snapshots and in `rel` arguments. */
export const GLOBAL_STATE_REL = '.claude.json'

export function userDataDir(): string {
  return app.getPath('userData')
}

export function snapshotsDir(): string {
  return path.join(userDataDir(), 'snapshots')
}

/**
 * How this copy was installed. `npx claudock` runs the plain app folder with npm's Electron, so `app.isPackaged` is false
 * there too; that folder sits directly in a node_modules folder, a git clone does not.
 */
export function installKind(): InstallKind {
  if (app.isPackaged) return 'installer'
  return path.basename(path.dirname(app.getAppPath())) === 'node_modules' ? 'npm' : 'dev'
}

/**
 * Development safety (SPEC rule 7): a development build (not an installer, not from npm) refuses to write unless
 * CLAUDE_CONFIG_DIR is set (point it at ./.fixture/claude) or CLAUDOCK_ALLOW_REAL_WRITES=1 is set explicitly.
 * CLAUDOCK_READONLY=1 refuses every write, however it was installed.
 */
export function writesAllowed(): boolean {
  if (process.env.CLAUDOCK_READONLY === '1') return false
  if (installKind() !== 'dev') return true
  return isCustomConfigDir() || process.env.CLAUDOCK_ALLOW_REAL_WRITES === '1'
}

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
