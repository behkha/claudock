import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * The one writer for files outside the config folder (src/main/domains/team.ts): the team folder the user picked and
 * the `.claude/settings.json` of a project they connected. Plain Node, no Electron, so `npm test` runs it on temp
 * folders; the domain passes in whether writing is allowed and how a file goes to the Trash.
 *
 * Every path is relative to the folder, checked to stay inside it, and never written through a link (a link in the
 * repo could otherwise point anywhere on the disk). Each file is written to a temp file beside it and renamed over the
 * old one; a file whose bytes are already the same is left alone, so a second write with nothing changed touches
 * nothing. Removed files go to the Trash, never `rm`.
 */

/** Same rule as `writesAllowed()` in src/main/paths.ts, for a folder outside the config folder. */
export const FIXTURE_MARK = '.claudock-fixture'

export interface WriteGuard {
  /** False in a development build unless the folder carries FIXTURE_MARK or real writes were allowed. */
  allowed(dir: string): boolean
  trash(abs: string): Promise<void>
}

/** A development build writes a team folder or project only when it is synthetic, or when real writes were allowed. */
export function devAllowed(dir: string, env: { readonly?: boolean; dev: boolean; allowReal: boolean }): boolean {
  if (env.readonly) return false
  if (!env.dev || env.allowReal) return true
  return fs.existsSync(path.join(dir, FIXTURE_MARK))
}

/** `rel` as a safe relative path with forward slashes, or an error. */
export function checkRel(rel: string): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.includes('\\') || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error(`Refusing the path ${JSON.stringify(rel)}`)
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error(`Refusing the path ${JSON.stringify(rel)}`)
  return rel
}

/** Each folder from `dir` down to the file's parent exists as a real folder (made when missing), never a link. */
async function ensureParents(dir: string, rel: string): Promise<string> {
  let at = dir
  const parts = rel.split('/')
  for (const p of parts.slice(0, -1)) {
    at = path.join(at, p)
    const st = await fsp.lstat(at).catch(() => null)
    if (!st) await fsp.mkdir(at)
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${rel} would be written through ${path.relative(dir, at)}, which is not a plain folder`)
  }
  return path.join(dir, ...parts)
}

/**
 * False when a folder between `dir` and the file is a link (or not a folder). The list of files to remove comes from
 * `.claudock.json` in the repo, which anyone with the repo can edit, so a link there must never lead out of the folder.
 */
export async function plainParents(dir: string, rel: string): Promise<boolean> {
  let at = dir
  for (const p of rel.split('/').slice(0, -1)) {
    at = path.join(at, p)
    const st = await fsp.lstat(at).catch(() => null)
    if (!st) return true
    if (st.isSymbolicLink() || !st.isDirectory()) return false
  }
  return true
}

/** The file's bytes, or null when it is missing. A link or a folder in its place is refused. */
async function current(abs: string, rel: string): Promise<Buffer | null> {
  const st = await fsp.lstat(abs).catch(() => null)
  if (!st) return null
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${rel} is not a plain file, so Claudock will not replace it`)
  return fsp.readFile(abs)
}

async function atomic(abs: string, data: Uint8Array, mode: number): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  try {
    await fsp.writeFile(tmp, data, { mode })
    await fsp.chmod(tmp, mode)
    await fsp.rename(tmp, abs)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

export interface WriteOutcome {
  /** Files whose bytes changed (new ones included). */
  written: string[]
  removed: string[]
}

/** Scripts in a plugin's `bin/` keep the run bit: Claude Code runs them by path. */
const modeFor = (rel: string): number => (/(^|\/)bin\/[^/]+$/.test(rel) ? 0o755 : 0o644)

/**
 * Write `writes` into `dir` and move `removes` to the Trash, then drop folders a removal left empty (inside the folder
 * of each removed file only, never `dir` itself).
 */
export async function writeFiles(dir: string, writes: Map<string, Uint8Array>, removes: string[], guard: WriteGuard): Promise<WriteOutcome> {
  const root = path.resolve(dir)
  if (!guard.allowed(root)) throw new Error('Writes to this folder are turned off in development (it has no .claudock-fixture file).')
  const st = await fsp.lstat(root).catch(() => null)
  if (!st?.isDirectory()) throw new Error('The team folder is not there anymore')
  const out: WriteOutcome = { written: [], removed: [] }
  // check every path before changing anything
  for (const rel of [...writes.keys(), ...removes]) checkRel(rel)
  for (const [rel, data] of [...writes].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const abs = await ensureParents(root, rel)
    const now = await current(abs, rel)
    if (now && Buffer.compare(now, Buffer.from(data)) === 0) {
      const want = modeFor(rel)
      // same bytes but a script lost its run bit: put it back without a write
      if (want === 0o755 && ((await fsp.stat(abs)).mode & 0o111) === 0) await fsp.chmod(abs, want)
      continue
    }
    await atomic(abs, data, modeFor(rel))
    out.written.push(rel)
  }
  for (const rel of [...removes].sort()) {
    const abs = path.join(root, ...rel.split('/'))
    if (!(await plainParents(root, rel))) throw new Error(`${rel} sits behind a link, so Claudock will not remove it`)
    const now = await fsp.lstat(abs).catch(() => null)
    if (!now) continue
    if (!now.isFile()) throw new Error(`${rel} is not a plain file, so Claudock will not remove it`)
    await guard.trash(abs)
    out.removed.push(rel)
    // folders the removal left empty, up to (not including) the first level under the root
    for (let d = path.dirname(abs); path.dirname(d) !== root && d.startsWith(root + path.sep); d = path.dirname(d)) {
      const left = await fsp.readdir(d).catch(() => null)
      if (!left || left.length) break
      await fsp.rmdir(d).catch(() => undefined)
    }
  }
  return out
}

/** Write one text file (a project's `.claude/settings.json`) the same guarded way. Returns false when it was already the same. */
export async function writeOne(dir: string, rel: string, text: string, guard: WriteGuard): Promise<boolean> {
  const r = await writeFiles(dir, new Map([[rel, new TextEncoder().encode(text)]]), [], guard)
  return r.written.length > 0
}

/** The file as text, or null when missing; never through a link. */
export async function readText(dir: string, rel: string, max = 2_000_000): Promise<string | null> {
  checkRel(rel)
  const abs = path.join(path.resolve(dir), ...rel.split('/'))
  if (!(await plainParents(path.resolve(dir), rel))) throw new Error(`${rel} sits behind a link`)
  const st = await fsp.lstat(abs).catch(() => null)
  if (!st) return null
  if (!st.isFile()) throw new Error(`${rel} is not a plain file`)
  if (st.size > max) throw new Error(`${rel} is too big to read`)
  return fsp.readFile(abs, 'utf8')
}
