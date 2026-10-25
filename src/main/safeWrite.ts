import { shell } from 'electron'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SnapshotInfo } from '@shared/types'
import { invalidateSizes } from './fsx'
import {
  GLOBAL_STATE_REL,
  assertNotSecretReal,
  assertWritable,
  configDir,
  globalStateFile,
  isSecret,
  isSecretReal,
  resolveInside,
  samePath,
  snapshotsDir
} from './paths'

/**
 * Every write to the config folder goes through this module (SPEC safety rules 2-5):
 *   snapshot current file(s) -> write temp file in the same folder -> rename over target (atomic).
 * Nothing here ever writes into the config dir except via `atomicWrite`, and snapshots live in userData.
 */

/* ------------------------------------------------------------------ serialisation */

const chains = new Map<string, Promise<unknown>>()
/**
 * Serialise operations per target path so two writes to one file never interleave. Keys are case-folded on macOS and
 * Windows, whose disks are case-insensitive by default, so `Settings.json` and `settings.json` share one chain.
 */
function serial<T>(rawKey: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'linux' ? rawKey : rawKey.toLowerCase()
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(
    key,
    next.catch(() => undefined)
  )
  return next
}

/**
 * Serialise read-modify-write cycles on one config file across every domain (Settings, Hooks, Permissions, Skills and
 * Plugins all edit settings.json). Uses its own chain, separate from the internal write chain, so `fn` may call
 * safeWrite* without deadlocking.
 */
export function withFileLock<T>(rel: string, fn: () => Promise<T>): Promise<T> {
  return serial(`rmw:${resolveInside(rel)}`, fn)
}

/* ------------------------------------------------------------------ snapshots */

function snapshotId(date: Date): string {
  return date.toISOString().replace(/:/g, '-')
}

/** Exactly the format `snapshotId()` produces (plus the `-N` suffix of `uniqueSnapshotDir`). Never `.`, `..` or anything with a separator. */
const SNAPSHOT_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z(?:-\d{1,3})?$/

export function assertSnapshotId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !SNAPSHOT_ID_RE.test(id)) throw new Error('Invalid snapshot id')
}

async function uniqueSnapshotDir(): Promise<{ id: string; dir: string; at: string }> {
  const now = new Date()
  const base = snapshotId(now)
  for (let n = 0; n < 100; n++) {
    const id = n === 0 ? base : `${base}-${n}`
    const dir = path.join(snapshotsDir(), id)
    try {
      await fsp.mkdir(dir, { recursive: false })
      return { id, dir, at: now.toISOString() }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        await fsp.mkdir(snapshotsDir(), { recursive: true })
        n--
        continue
      }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error('Could not allocate a snapshot folder')
}

/**
 * Copy the given files (paths relative to the config dir; `.claude.json` = global state file) into a new snapshot.
 * Missing files and secrets are skipped. Returns null if nothing was copied.
 */
export async function snapshot(relPaths: string[], reason: string): Promise<SnapshotInfo | null> {
  const copied: string[] = []
  const { id, dir, at } = await uniqueSnapshotDir()
  for (const rel of relPaths) {
    const abs = resolveInside(rel)
    if (await isSecretReal(abs)) continue
    const st = await fsp.lstat(abs).catch(() => null)
    if (!st || !st.isFile()) continue
    const key = abs === globalStateFile() ? GLOBAL_STATE_REL : path.relative(configDir(), abs)
    const dest = path.join(dir, key)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(abs, dest)
    copied.push(key)
  }
  if (copied.length === 0) {
    await fsp.rm(dir, { recursive: true, force: true })
    return null
  }
  const info: SnapshotInfo = { id, at, reason, files: copied }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ at, reason, files: copied }, null, 2) + '\n')
  invalidateSnapshotIndex()
  return info
}

/* ---- snapshot index: cached, keyed on the snapshots folder's mtime, invalidated on create / trash */

const MANIFEST_CONCURRENCY = 16
let indexCache: { mtimeMs: number; list: SnapshotInfo[] } | null = null
let indexGen = 0

function invalidateSnapshotIndex(): void {
  indexGen++
  indexCache = null
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function listSnapshots(): Promise<SnapshotInfo[]> {
  const dirStat = await fsp.stat(snapshotsDir()).catch(() => null)
  if (!dirStat) return []
  if (indexCache && indexCache.mtimeMs === dirStat.mtimeMs) return indexCache.list
  const gen = indexGen
  let ids: string[]
  try {
    ids = await fsp.readdir(snapshotsDir())
  } catch {
    return []
  }
  const valid = ids.filter((id) => SNAPSHOT_ID_RE.test(id))
  const found = await mapLimit(valid, MANIFEST_CONCURRENCY, async (id): Promise<SnapshotInfo | null> => {
    try {
      const m = JSON.parse(await fsp.readFile(path.join(snapshotsDir(), id, 'manifest.json'), 'utf8')) as {
        at: string
        reason: string
        files: string[]
      }
      return { id, at: m.at, reason: m.reason, files: m.files }
    } catch {
      return null /* not a snapshot folder (or still being written) */
    }
  })
  const list = found.filter((x): x is SnapshotInfo => x !== null).sort((a, b) => b.at.localeCompare(a.at))
  // A folder that exists without a manifest is a snapshot being written: do not cache that state.
  if (gen === indexGen && list.length === valid.length) indexCache = { mtimeMs: dirStat.mtimeMs, list }
  return list
}

/** The snapshot `id`, only if it has the exact id format AND is one of ours (listed with a manifest). */
async function requireSnapshot(id: string): Promise<SnapshotInfo> {
  assertSnapshotId(id)
  const snap = (await listSnapshots()).find((s) => s.id === id)
  if (!snap) throw new Error('That snapshot no longer exists')
  return snap
}

/** Absolute path of `rel` inside snapshot `id`. The id must be well-formed; `rel` must be listed in the snapshot's manifest. */
export async function snapshotFilePath(id: string, rel: string): Promise<string> {
  const snap = await requireSnapshot(id)
  if (typeof rel !== 'string' || !snap.files.includes(rel)) throw new Error('That file is not in this snapshot')
  const root = path.join(snapshotsDir(), id)
  const abs = path.resolve(root, rel)
  const r = path.relative(root, abs)
  if (r === '' || r.startsWith('..') || path.isAbsolute(r) || isSecret(abs)) throw new Error('Invalid snapshot path')
  return abs
}

/** Read one file out of a snapshot (for diffs). */
export async function readSnapshotText(id: string, rel: string): Promise<string> {
  const abs = await snapshotFilePath(id, rel)
  await assertNotSecretReal(abs)
  return fsp.readFile(abs, 'utf8')
}

/** Restore `rel` from snapshot `id`. The current file is snapshotted first (via safeWrite). The global state file cannot be restored wholesale (Claude Code writes it constantly): use `readSnapshotText` + `writeGlobalStateKey`. */
export async function restoreSnapshot(id: string, rel: string): Promise<void> {
  if (rel === GLOBAL_STATE_REL) throw new Error('Restore single keys of .claude.json instead of the whole file')
  const abs = await snapshotFilePath(id, rel)
  await assertNotSecretReal(abs)
  const data = await fsp.readFile(abs)
  await atomicWriteWithSnapshot(rel, data, `Restore of ${rel} from snapshot ${id}`)
}

/** Move a snapshot folder to the OS Trash (never fs.rm). */
export async function trashSnapshot(id: string): Promise<void> {
  const snap = await requireSnapshot(id)
  const dir = path.join(snapshotsDir(), snap.id)
  if (path.dirname(dir) !== path.resolve(snapshotsDir())) throw new Error('Invalid snapshot id')
  await shell.trashItem(dir)
  invalidateSnapshotIndex()
}

/* ------------------------------------------------------------------ atomic write */

const WIN_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Windows: antivirus / indexers briefly hold files open, which makes rename / unlink fail with EPERM / EACCES / EBUSY.
 * Retry with backoff (about 2.8 s in total). Elsewhere those codes are real permission errors and throw at once.
 */
export async function retryWhileLocked<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [20, 50, 100, 200, 400, 800, 1200]
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || !WIN_RETRY_CODES.has(code) || i >= delays.length) throw e
      await new Promise((r) => setTimeout(r, delays[i]))
    }
  }
}

const renameWithRetry = (from: string, to: string): Promise<void> => retryWhileLocked(() => fsp.rename(from, to))

async function hasBom(abs: string): Promise<boolean> {
  try {
    const fh = await fsp.open(abs, 'r')
    try {
      const buf = Buffer.alloc(3)
      const { bytesRead } = await fh.read(buf, 0, 3, 0)
      return bytesRead === 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    } finally {
      await fh.close()
    }
  } catch {
    return false
  }
}

/**
 * Write `data` next to `abs` and rename it into place. With `createOnly` the target must not exist: the temp file is
 * hard-linked into place (which fails with EEXIST instead of replacing anything) and falls back to rename only where
 * links are unsupported.
 */
async function atomicWrite(abs: string, data: string | Buffer, opts: { createOnly?: boolean } = {}): Promise<void> {
  const dir = path.dirname(abs)
  await fsp.mkdir(dir, { recursive: true })
  const existing = await fsp.lstat(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  if (opts.createOnly && existing) throw Object.assign(new Error(`${path.basename(abs)} appeared while writing`), { code: 'EEXIST' })
  if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${path.basename(abs)}`)
  if (existing && !existing.isFile()) throw new Error(`Not a regular file: ${path.basename(abs)}`)
  const tmp = path.join(dir, `.${path.basename(abs)}.claudock-${crypto.randomBytes(4).toString('hex')}.tmp`)
  const fh = await fsp.open(tmp, 'w', existing ? existing.mode & 0o777 : 0o644)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } catch (e) {
    await fh.close().catch(() => undefined)
    await fsp.unlink(tmp).catch(() => undefined)
    throw e
  }
  await fh.close()
  try {
    if (opts.createOnly) {
      let linked = false
      try {
        await fsp.link(tmp, abs)
        linked = true
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EEXIST') throw e
        // no hard links here: last check, then rename
        if (await fsp.lstat(abs).then(() => true, () => false)) throw Object.assign(new Error(`${path.basename(abs)} appeared while writing`), { code: 'EEXIST' })
        await renameWithRetry(tmp, abs)
      }
      // the target is written; a temp name that cannot be removed (antivirus lock) is only litter, not a failure
      if (linked) await retryWhileLocked(() => fsp.unlink(tmp)).catch(() => undefined)
    } else {
      await renameWithRetry(tmp, abs)
    }
  } catch (e) {
    await fsp.unlink(tmp).catch(() => undefined)
    throw e
  }
  invalidateSizes(dir)
}

async function atomicWriteWithSnapshot(rel: string, data: string | Buffer, reason: string): Promise<{ snapshotId: string | null }> {
  assertWritable()
  const abs = resolveInside(rel)
  await assertNotSecretReal(abs)
  if (samePath(abs, configDir())) throw new Error('Cannot write the config folder itself')
  return serial(abs, async () => {
    // keep a UTF-8 BOM if the file had one (editors strip it from the text they hand back)
    if (typeof data === 'string' && !data.startsWith('\uFEFF') && (await hasBom(abs))) data = '\uFEFF' + data
    const snap = await snapshot([rel], reason)
    await atomicWrite(abs, data)
    return { snapshotId: snap?.id ?? null }
  })
}

export interface WriteResult {
  /** Snapshot that holds the previous content, or null if the file did not exist. */
  snapshotId: string | null
}

/** Write text to a config-dir-relative path. `.json` files are validated (a leading BOM is ignored) and get a trailing newline. */
export async function safeWriteText(rel: string, text: string, reason: string): Promise<WriteResult> {
  let out = text
  if (rel.toLowerCase().endsWith('.json')) {
    try {
      JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch (e) {
      throw new Error(`Not valid JSON, nothing was written: ${(e as Error).message}`, { cause: e })
    }
    if (!out.endsWith('\n')) out += '\n'
  }
  return atomicWriteWithSnapshot(rel, out, reason)
}

/** Validate, serialise with 2-space indent + trailing newline, and write. */
export async function safeWriteJson(rel: string, obj: unknown, reason: string): Promise<WriteResult> {
  if (obj === undefined) throw new Error('Cannot write undefined as JSON')
  const text = JSON.stringify(obj, null, 2)
  JSON.parse(text) // round-trip validation
  return atomicWriteWithSnapshot(rel, text + '\n', reason)
}

/**
 * Change the global state file (.claude.json), which Claude Code rewrites constantly. `mutate` receives the state
 * freshly re-read inside the write lock and returns the new state (or edits it in place and returns nothing); it may
 * throw to abort. The file is re-read on every attempt, and the attempt is redone if the file changed between the
 * read and the rename. Refuses to touch a file that does not parse. Only ENOENT counts as "missing": any other stat
 * error (EPERM, EBUSY, EACCES) aborts instead of writing a file that holds just one key.
 */
export async function updateGlobalState(
  mutate: (current: Record<string, unknown>) => Record<string, unknown> | void,
  reason: string
): Promise<WriteResult> {
  assertWritable()
  const abs = globalStateFile()
  return serial(abs, async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await fsp.lstat(abs).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null
        throw new Error(`.claude.json could not be checked (${e.code ?? e.message}), nothing was written`, { cause: e })
      })
      if (before && !before.isFile()) throw new Error('.claude.json is not a regular file, nothing was written')
      let state: Record<string, unknown> = {}
      let indent: string | number = 2
      let bom = false
      let eol = '\n'
      if (before) {
        const raw = await fsp.readFile(abs, 'utf8')
        bom = raw.startsWith('\uFEFF')
        const text = raw.replace(/^\uFEFF/, '')
        try {
          const parsed: unknown = JSON.parse(text)
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
          state = parsed as Record<string, unknown>
        } catch (e) {
          throw new Error(`.claude.json could not be parsed, nothing was written: ${(e as Error).message}`, { cause: e })
        }
        const m = /^\{\r?\n([ \t]+)"/.exec(text)
        if (m) indent = m[1]
        if (/\r\n/.test(text)) eol = '\r\n'
      }
      const next = mutate(state) ?? state
      if (next === null || typeof next !== 'object' || Array.isArray(next)) throw new Error('The global state must stay a JSON object')
      let out = JSON.stringify(next, null, indent) + '\n'
      JSON.parse(out)
      if (eol === '\r\n') out = out.replace(/\n/g, '\r\n')
      if (bom) out = '\uFEFF' + out
      const now = await fsp.lstat(abs).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null
        throw new Error(`.claude.json could not be checked (${e.code ?? e.message}), nothing was written`, { cause: e })
      })
      if (before ? !now || now.mtimeMs !== before.mtimeMs || now.size !== before.size : now !== null) continue // changed under us: redo
      const snap = await snapshot([GLOBAL_STATE_REL], reason)
      try {
        await atomicWrite(abs, out, { createOnly: !before })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue // created by Claude Code in the meantime: redo against it
        throw e
      }
      return { snapshotId: snap?.id ?? null }
    }
    throw new Error('.claude.json kept changing while writing; try again')
  })
}

/** Set (or, with `undefined`, remove) ONE top-level key of the global state file. See `updateGlobalState`. */
export function writeGlobalStateKey(key: string, value: unknown, reason = `Edit ${key} in .claude.json`): Promise<WriteResult> {
  if (!key || key.includes('\0')) return Promise.reject(new Error('Invalid key'))
  return updateGlobalState((state) => {
    if (value === undefined) delete state[key]
    else state[key] = value
  }, reason)
}

/** Move a file/folder inside the config dir to the OS Trash. Refuses the config root, the global state file and secrets (also behind symlinks). */
export async function trash(rel: string): Promise<void> {
  assertWritable()
  const abs = resolveInside(rel)
  if (samePath(abs, configDir()) || samePath(abs, globalStateFile())) throw new Error('Refusing to trash this path')
  await assertNotSecretReal(abs)
  await shell.trashItem(abs)
  invalidateSizes(path.dirname(abs))
}
