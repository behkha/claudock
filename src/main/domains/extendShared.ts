import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SaveResult } from '@shared/api/skills'
import { joinFrontmatter, parseFrontmatter, splitFrontmatter } from '@shared/frontmatter'
import { exists, readJson, stat, tryReadJson } from '../fsx'
import { assertNotSecretReal, configDir, resolveInside, toRel } from '../paths'
import { safeWriteJson, safeWriteText, withFileLock } from '../safeWrite'

/**
 * Helpers shared by the Extend domains (skills, agents, commands, plugins, mcp). Not a domain itself.
 * Everything here reads freely and writes only through safeWrite.
 */

export const SETTINGS_REL = 'settings.json'

export const toPosix = (p: string): string => p.split(path.sep).join('/')

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/* ------------------------------------------------------------------ reading */

/** First `bytes` of a text file (frontmatter lives at the top, so this is all the list views need). */
export async function readHead(abs: string, bytes = 32 * 1024): Promise<string> {
  await assertNotSecretReal(abs)
  const fh = await fsp.open(abs, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, '')
  } finally {
    await fh.close()
  }
}

export interface Capped {
  text: string
  size: number
  mtimeMs: number
  truncated: boolean
}

/** Read a text file, at most `maxBytes`. Follows symlinks. */
export async function readCapped(abs: string, maxBytes = 1_500_000): Promise<Capped> {
  await assertNotSecretReal(abs)
  const st = await fsp.stat(abs)
  if (!st.isFile()) throw new Error('Not a file')
  const fh = await fsp.open(abs, 'r')
  try {
    const len = Math.min(st.size, maxBytes)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, 0)
    return { text: buf.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, ''), size: st.size, mtimeMs: st.mtimeMs, truncated: st.size > maxBytes }
  } finally {
    await fh.close()
  }
}

/** True if `abs` is a directory (follows symlinks). */
export async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await fsp.stat(abs)).isDirectory()
  } catch {
    return false
  }
}

export async function isFile(abs: string): Promise<boolean> {
  try {
    return (await fsp.stat(abs)).isFile()
  } catch {
    return false
  }
}

/** Child folder names (following symlinks), skipping dot-folders. */
export async function childDirs(abs: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fsp.readdir(abs)
  } catch {
    return []
  }
  const flags = await Promise.all(names.map(async (n) => (!n.startsWith('.') && (await isDirectory(path.join(abs, n)))) as boolean))
  return names.filter((_, i) => flags[i]).sort((a, b) => a.localeCompare(b))
}

export interface MdRef {
  abs: string
  /** Relative to the config dir, forward slashes. */
  rel: string
  /** Relative to the scanned root, forward slashes, without ".md". */
  name: string
  size: number
  mtimeMs: number
}

/**
 * Markdown files below `root` (recursive, dot-folders and node_modules skipped, folder symlinks not followed,
 * file symlinks followed). Missing root gives [].
 */
export async function collectMd(root: string, opts: { maxDepth?: number; max?: number } = {}): Promise<MdRef[]> {
  const maxDepth = opts.maxDepth ?? 4
  const max = opts.max ?? 2000
  const out: MdRef[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    await Promise.all(
      entries.map(async (e) => {
        if (e.name.startsWith('.') || e.name === 'node_modules') return
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (depth < maxDepth) subdirs.push(full)
          return
        }
        if (!/\.md$/i.test(e.name)) return
        if (e.isSymbolicLink() || e.isFile()) {
          const st = await fsp.stat(full).catch(() => null)
          if (!st || !st.isFile()) return
          if (out.length >= max) return
          out.push({
            abs: full,
            rel: toPosix(path.relative(configDir(), full)),
            name: toPosix(path.relative(root, full)).replace(/\.md$/i, ''),
            size: st.size,
            mtimeMs: st.mtimeMs
          })
        }
      })
    )
    await Promise.all(subdirs.map((d) => walk(d, depth + 1)))
  }
  await walk(root, 0)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ settings.json (shared key-by-key writes) */

export interface SettingsRead {
  data: Record<string, unknown>
  /** Set when the file exists but cannot be parsed as an object. */
  error?: string
}

/** settings.json of the open profile, or of another profile's folder (the menu bar reads every profile). */
export async function readSettings(dir = configDir()): Promise<SettingsRead> {
  const r = await tryReadJson<unknown>(path.join(dir, SETTINGS_REL))
  if (!r.ok) return r.missing ? { data: {} } : { data: {}, error: `settings.json could not be read: ${r.error}` }
  if (!isObj(r.value)) return { data: {}, error: 'settings.json is not a JSON object' }
  return { data: r.value }
}

/**
 * Change settings.json: re-reads it right before the write, lets `mutate` edit the fresh object (return false for
 * "nothing to do"), and writes it with safeWriteJson. Refuses to touch a file that does not parse.
 */
export function updateSettings(mutate: (s: Record<string, unknown>) => boolean | void, reason: string): Promise<{ snapshotId: string | null; changed: boolean }> {
  const run = async (): Promise<{ snapshotId: string | null; changed: boolean }> => {
    const { data, error } = await readSettings()
    if (error) throw new Error(`${error}. Nothing was written.`)
    if (mutate(data) === false) return { snapshotId: null, changed: false }
    const r = await safeWriteJson(SETTINGS_REL, data, reason)
    return { snapshotId: r.snapshotId, changed: true }
  }
  return withFileLock(SETTINGS_REL, run)
}

/* ------------------------------------------------------------------ plugins on disk */

export interface PluginRecord {
  key: string
  name: string
  marketplace: string
  version: string
  scope: string
  installedAt?: string
  lastUpdated?: string
  gitCommitSha?: string
  /** Absolute install folder (derived from the cache layout, else from installPath if that is inside the config dir). */
  dir: string
  exists: boolean
}

export function splitPluginKey(key: string): { name: string; marketplace: string } {
  const i = key.lastIndexOf('@')
  return i > 0 ? { name: key.slice(0, i), marketplace: key.slice(i + 1) } : { name: key, marketplace: '' }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function insideConfig(abs: string): boolean {
  const r = path.relative(configDir(), abs)
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r)
}

/** Plugins from plugins/installed_plugins.json (version 1 and 2 shapes). */
export async function installedPlugins(): Promise<PluginRecord[]> {
  const raw = await readJson<unknown>(path.join(configDir(), 'plugins', 'installed_plugins.json'))
  if (!isObj(raw) || !isObj(raw.plugins)) return []
  const out: PluginRecord[] = []
  for (const [key, val] of Object.entries(raw.plugins)) {
    const entries = (Array.isArray(val) ? val : [val]).filter(isObj)
    if (entries.length === 0) continue
    const e = entries.find((x) => x.scope === 'user') ?? entries[0]
    const { name, marketplace } = splitPluginKey(key)
    const version = str(e.version) ?? 'unknown'
    let dir = path.join(configDir(), 'plugins', 'cache', marketplace, name, version)
    let ok = await isDirectory(dir)
    if (!ok) {
      const ip = str(e.installPath)
      if (ip && path.isAbsolute(ip) && insideConfig(ip) && (await isDirectory(ip))) {
        dir = ip
        ok = true
      }
    }
    out.push({
      key,
      name,
      marketplace,
      version,
      scope: str(e.scope) ?? 'user',
      installedAt: str(e.installedAt),
      lastUpdated: str(e.lastUpdated),
      gitCommitSha: str(e.gitCommitSha),
      dir,
      exists: ok
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** enabledPlugins from settings.json as a plain map. */
export function enabledMap(settings: Record<string, unknown>): Record<string, boolean> {
  const ep = settings.enabledPlugins
  const out: Record<string, boolean> = {}
  if (isObj(ep)) for (const [k, v] of Object.entries(ep)) if (typeof v === 'boolean') out[k] = v
  return out
}

/* ------------------------------------------------------------------ ids and paths */

/**
 * Resolve a renderer-supplied id (config-relative path) to absolute + normalised relative form, and make sure it is
 * inside one of `roots` (e.g. ['skills', 'plugins/cache']).
 */
export function resolveUnder(id: string, roots: string[]): { abs: string; rel: string } {
  if (typeof id !== 'string' || !id || id.startsWith('override:')) throw new Error('Unknown item')
  const abs = resolveInside(id)
  const rel = toPosix(toRel(abs))
  if (!roots.some((r) => rel.startsWith(r + '/'))) throw new Error('This item is outside the folders managed here')
  return { abs, rel }
}

/** A path that does not exist yet next to `base`: `<base>`, `<base>-2`, ... Returns the absolute path. */
export async function freePath(dir: string, stem: string, ext = ''): Promise<{ abs: string; stem: string }> {
  for (let n = 1; n < 1000; n++) {
    const s = n === 1 ? stem : `${stem}-${n}`
    const abs = path.join(dir, s + ext)
    if (!(await exists(abs))) return { abs, stem: s }
  }
  throw new Error('Could not find a free name')
}

/** Check that the file is unchanged since the editor loaded it. */
export async function assertUnchanged(abs: string, baseMtimeMs: number): Promise<void> {
  const st = await stat(abs)
  if (!st) throw new Error('This file no longer exists')
  if (typeof baseMtimeMs === 'number' && Math.abs(st.mtimeMs - baseMtimeMs) > 1) {
    throw new Error('This file changed on disk since you opened it. Reload it, then make your edit again.')
  }
}

/** Write text to a config-relative path after a conflict check; returns the new mtime. */
export async function saveText(rel: string, text: string, baseMtimeMs: number, reason: string): Promise<SaveResult> {
  const abs = resolveInside(rel)
  await assertUnchanged(abs, baseMtimeMs)
  const r = await safeWriteText(rel, text, reason)
  const st = await stat(abs)
  return { snapshotId: r.snapshotId, mtimeMs: st?.mtimeMs ?? Date.now() }
}

/* ------------------------------------------------------------------ frontmatter editing */

const RESERVED = /^(true|false|yes|no|on|off|null|~|[-+]?[0-9][0-9_.,e+-]*)$/i

/** A YAML scalar for `v`: plain when that is safe, else a double-quoted JSON string (valid YAML). */
export function yamlScalar(v: string): string {
  if (v === '') return '""'
  const plainOk =
    !/[\r\n]/.test(v) &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(v) &&
    !/[\s:]$/.test(v) &&
    !v.includes(': ') &&
    !v.includes(' #') &&
    !RESERVED.test(v)
  return plainOk ? v : JSON.stringify(v)
}

/**
 * Set (or remove, with null) one top-level key in the raw frontmatter text, leaving every other line untouched.
 * Continuation lines of the old value (indented lines, list items, block scalars) are replaced with it.
 */
export function setFmKey(raw: string | null, key: string, value: string | null): string {
  const lines = raw === null || raw === '' ? [] : raw.split(/\r?\n/)
  const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`)
  const idx = lines.findIndex((l) => keyRe.test(l))
  const next = value === null ? [] : [`${key}: ${yamlScalar(value)}`]
  if (idx < 0) return value === null ? lines.join('\n') : [...lines, ...next].join('\n')
  let end = idx + 1
  while (end < lines.length) {
    const l = lines[end]
    if (/^[ \t]+\S/.test(l) || /^-[ \t]/.test(l)) end++
    else if (/^[ \t]*$/.test(l)) {
      let j = end + 1
      while (j < lines.length && /^[ \t]*$/.test(lines[j])) j++
      if (j < lines.length && /^[ \t]+\S/.test(lines[j])) end = j
      else break
    } else break
  }
  lines.splice(idx, end - idx, ...next)
  return lines.join('\n')
}

export function normList(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  const arr = Array.isArray(v) ? v : v.split(',')
  return arr.map((s) => s.trim()).filter(Boolean)
}

export const asString = (v: string | string[] | undefined): string => (v === undefined ? '' : Array.isArray(v) ? v.join(', ') : v)

export interface MdParts {
  fm: ReturnType<typeof parseFrontmatter>
  text: string
}

export function parseMd(text: string): MdParts {
  return { fm: parseFrontmatter(text), text }
}

/**
 * Apply form values to a markdown file's text: only keys in `changes` are rewritten (value null removes the key),
 * the body is replaced by `body`, line endings of the original are kept.
 */
export function applyForm(original: string, changes: Record<string, string | null>, body: string): string {
  const { raw } = splitFrontmatter(original)
  let nextRaw: string | null = raw
  for (const [k, v] of Object.entries(changes)) nextRaw = setFmKey(nextRaw, k, v)
  if (nextRaw !== null && nextRaw.trim() === '') nextRaw = null
  const out = nextRaw === null ? body : joinFrontmatter(nextRaw, body)
  return original.includes('\r\n') ? out.replace(/\r?\n/g, '\r\n') : out
}

/** Rewrite the `name:` of a copy. Returns the new file text. */
export function renameInText(text: string, name: string): string {
  const { raw, body } = splitFrontmatter(text)
  const nextRaw = setFmKey(raw, 'name', name)
  const out = joinFrontmatter(nextRaw, body)
  return text.includes('\r\n') ? out.replace(/\r?\n/g, '\r\n') : out
}
