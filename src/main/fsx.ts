import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import type { DirEntryInfo, DirSize } from '@shared/types'
import { assertNotSecretReal, configDir, isSecret } from './paths'

/** Small read-only filesystem helpers. All take ABSOLUTE paths (use `resolveInside` first for renderer input). */

export async function readText(abs: string): Promise<string> {
  await assertNotSecretReal(abs)
  return fsp.readFile(abs, 'utf8')
}

/**
 * Refuse a save when the file changed since the editor loaded it. The message starts with `CHANGED_ON_DISK` (the
 * convention the renderer looks for to offer Reload / Keep my edits). Missing file: current is null.
 */
export async function assertUnchangedOnDisk(abs: string, expectedMtimeMs: unknown, label: string): Promise<void> {
  const st = await stat(abs)
  const current = st?.isFile ? st.mtimeMs : null
  const expected = typeof expectedMtimeMs === 'number' && Number.isFinite(expectedMtimeMs) ? expectedMtimeMs : null
  const same = current === expected || (current !== null && expected !== null && Math.abs(current - expected) < 1)
  if (!same) throw new Error(`CHANGED_ON_DISK: ${label} changed on disk since you opened it.`)
}

/** Give editor text (always LF) the line endings of the file on disk: CRLF if the original has any, as `applyForm` does. */
export function matchEol(original: string, text: string): string {
  return original.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text
}

export async function readTextOr(abs: string, fallback = ''): Promise<string> {
  try {
    return await readText(abs)
  } catch {
    return fallback
  }
}

/** Tolerant JSON read: returns `fallback` (default undefined) if missing or invalid. Strips a UTF-8 BOM. */
export async function readJson<T = unknown>(abs: string, fallback?: T): Promise<T | undefined> {
  try {
    const text = await readText(abs)
    return JSON.parse(text.replace(/^\uFEFF/, '')) as T
  } catch {
    return fallback
  }
}

/** Like readJson but tells you why it failed. */
export async function tryReadJson<T = unknown>(
  abs: string
): Promise<{ ok: true; value: T } | { ok: false; error: string; missing: boolean }> {
  let text: string
  try {
    text = await readText(abs)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return { ok: false, error: err.message, missing: err.code === 'ENOENT' }
  }
  try {
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) as T }
  } catch (e) {
    return { ok: false, error: (e as Error).message, missing: false }
  }
}

export interface StatInfo {
  size: number
  mtimeMs: number
  birthtimeMs: number
  isDir: boolean
  isFile: boolean
  isSymlink: boolean
  mode: number
}

/** lstat (never follows symlinks). Null if missing. */
export async function stat(abs: string): Promise<StatInfo | null> {
  try {
    const s = await fsp.lstat(abs)
    return {
      size: s.size,
      mtimeMs: s.mtimeMs,
      birthtimeMs: s.birthtimeMs,
      isDir: s.isDirectory(),
      isFile: s.isFile(),
      isSymlink: s.isSymbolicLink(),
      mode: s.mode
    }
  } catch {
    return null
  }
}

export async function exists(abs: string): Promise<boolean> {
  return (await stat(abs)) !== null
}

/** Directory listing with lstat info, sorted by name. Returns [] if missing. Paths in `rel` are config-dir-relative when inside it. */
export async function listDir(abs: string): Promise<DirEntryInfo[]> {
  let names: string[]
  try {
    names = await fsp.readdir(abs)
  } catch {
    return []
  }
  const root = configDir()
  const out = await Promise.all(
    names.map(async (name): Promise<DirEntryInfo | null> => {
      const full = path.join(abs, name)
      const s = await stat(full)
      if (!s) return null
      const r = path.relative(root, full)
      return {
        name,
        rel: r.startsWith('..') ? full : r,
        isDir: s.isDir,
        isFile: s.isFile,
        isSymlink: s.isSymlink,
        size: s.size,
        mtimeMs: s.mtimeMs,
        secret: isSecret(full)
      }
    })
  )
  return out.filter((e): e is DirEntryInfo => e !== null).sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ concurrency + dirSize */

const MAX_FS_OPS = 32
let active = 0
let waiters: Array<() => void> = []
let waitHead = 0

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_FS_OPS) await new Promise<void>((r) => waiters.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    const next = waiters[waitHead]
    if (next) {
      waiters[waitHead++] = () => undefined
      next()
      if (waitHead > 1024 && waitHead * 2 > waiters.length) {
        waiters = waiters.slice(waitHead)
        waitHead = 0
      }
    }
  }
}

interface CacheEntry {
  mtimeMs: number
  at: number
  value: DirSize
}
const SIZE_TTL_MS = 60_000
const sizeCache = new Map<string, CacheEntry>()

/** Forget cached sizes at or below `abs` (all when omitted). Call after deleting/writing large things. */
export function invalidateSizes(abs?: string): void {
  if (!abs) return sizeCache.clear()
  const prefix = abs + path.sep
  for (const k of sizeCache.keys()) if (k === abs || k.startsWith(prefix)) sizeCache.delete(k)
}

export interface DirSizeOptions {
  /** Bypass the cache. */
  force?: boolean
  /** Called at most every ~150 ms with running totals. */
  onProgress?: (p: { bytes: number; files: number }) => void
  signal?: AbortSignal
}

/**
 * Recursive size of a folder. Async, concurrency-limited (32 fs ops), never follows symlinks (a symlink counts as
 * its own tiny entry), skips secrets. Cached per directory by path + mtime for 60 s (directory mtime alone does not
 * change when a file is appended to, hence the TTL). A file path returns its own size.
 */
export async function dirSize(abs: string, opts: DirSizeOptions = {}): Promise<DirSize> {
  const running = { bytes: 0, files: 0 }
  let lastEmit = 0
  const tick = (): void => {
    if (!opts.onProgress) return
    const now = Date.now()
    if (now - lastEmit >= 150) {
      lastEmit = now
      opts.onProgress({ ...running })
    }
  }

  async function walk(dir: string): Promise<DirSize> {
    if (opts.signal?.aborted) throw new Error('aborted')
    const st = await withSlot(() => fsp.lstat(dir).catch(() => null))
    if (!st) return { bytes: 0, files: 0, dirs: 0, at: Date.now() }
    if (!st.isDirectory()) {
      if (isSecret(dir)) return { bytes: 0, files: 0, dirs: 0, at: Date.now() }
      running.bytes += st.size
      running.files++
      tick()
      return { bytes: st.size, files: 1, dirs: 0, at: Date.now() }
    }
    const cached = sizeCache.get(dir)
    if (!opts.force && cached && cached.mtimeMs === st.mtimeMs && Date.now() - cached.at < SIZE_TTL_MS) {
      running.bytes += cached.value.bytes
      running.files += cached.value.files
      tick()
      return cached.value
    }
    const names = await withSlot(() => fsp.readdir(dir)).catch(() => [] as string[])
    const parts = await Promise.all(names.map((n) => walk(path.join(dir, n))))
    const total: DirSize = { bytes: 0, files: 0, dirs: 1, at: Date.now() }
    for (const p of parts) {
      total.bytes += p.bytes
      total.files += p.files
      total.dirs += p.dirs
    }
    sizeCache.set(dir, { mtimeMs: st.mtimeMs, at: Date.now(), value: total })
    return total
  }

  const result = await walk(abs)
  opts.onProgress?.({ ...running })
  return result
}

export interface ChildSize extends DirEntryInfo {
  /** Recursive size for folders, own size for files. 0 for secrets. */
  bytes: number
  files: number
}

/** Sizes of the direct children of a folder (for storage bars / drill-down), largest first. */
export async function childSizes(abs: string, opts: DirSizeOptions = {}): Promise<ChildSize[]> {
  const entries = await listDir(abs)
  const out = await Promise.all(
    entries.map(async (e): Promise<ChildSize> => {
      if (e.secret) return { ...e, bytes: 0, files: 0 }
      const full = path.isAbsolute(e.rel) ? e.rel : path.join(configDir(), e.rel)
      const s = await dirSize(full, { force: opts.force, signal: opts.signal })
      return { ...e, bytes: s.bytes, files: s.files }
    })
  )
  return out.sort((a, b) => b.bytes - a.bytes)
}

/* ------------------------------------------------------------------ jsonl */

export interface JsonlOptions {
  /** Stop after this many lines (counting blank/invalid lines). */
  maxLines?: number
  /** Skip this many lines first. */
  skip?: number
  signal?: AbortSignal
}

/** Stream a .jsonl file line by line; invalid lines are yielded as `{ line, value: undefined, error }`. */
export async function* streamJsonl<T = unknown>(
  abs: string,
  opts: JsonlOptions = {}
): AsyncGenerator<{ index: number; value: T | undefined; line: string; error?: string }> {
  await assertNotSecretReal(abs)
  const stream = fs.createReadStream(abs, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let index = -1
  try {
    for await (const line of rl) {
      index++
      if (opts.signal?.aborted) break
      if (opts.skip && index < opts.skip) continue
      if (opts.maxLines !== undefined && index - (opts.skip ?? 0) >= opts.maxLines) break
      if (!line.trim()) continue
      try {
        yield { index, value: JSON.parse(line) as T, line }
      } catch (e) {
        yield { index, value: undefined, line, error: (e as Error).message }
      }
    }
  } finally {
    rl.close()
    stream.destroy()
  }
}

/** Collect parsed lines (invalid ones skipped). Returns [] if the file is missing. */
export async function readJsonl<T = unknown>(abs: string, opts: JsonlOptions = {}): Promise<T[]> {
  const out: T[] = []
  try {
    for await (const r of streamJsonl<T>(abs, opts)) if (r.value !== undefined) out.push(r.value)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return out
}
