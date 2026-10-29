import { app, BrowserWindow, clipboard, dialog, shell, type IpcMain } from 'electron'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ArchiveApi, ArchiveList, ArchiveStatus, ArchivedSession, SearchHit } from '@shared/api/archive'
import type { TranscriptEntry } from '@shared/api/projects'
import { formatDateTime } from '@shared/format'
import { hold, holdTree, unhold, type HoldMode } from '../archive/hold'
import { emptyFacts, foldLine, keyOf, matchSession, queryTerms, resumeCommand, splitKey, titleOf, toMarkdown, type Facts } from '../archive/model'
import { folderKey } from '../connect/folder'
import { defineDomain, emit } from '../ipcx'
import { configDir, installKind, isSecret, onConfigDirChanged, openConfigDir, samePath, userDataDir, usesHomeState, writesAllowed } from '../paths'
import { startCommand } from '../profiles/model'
import { placeNewFile, trash as trashInConfig } from '../safeWrite'
import { NO_CAPS, entriesFromLine, iterLines, parseLine } from '../transcripts/parse'
import { onSessionsTrashed, projectDirName, readTranscriptPage, sessionFileId } from './projects'

/**
 * The session archive: Claude Code deletes a transcript `cleanupPeriodDays` (30) days after it was last touched, at its
 * next start; Claudock keeps every one. Each profile folder has its own archive, `<userData>/archive/<folder key>/`
 * (the key is the connect folder's): `projects/<project>/<id>.jsonl` (and the session's folder of sub-agent transcripts)
 * hard-linked to Claude Code's files where the disk allows (src/main/archive/hold.ts), so it costs nothing until Claude
 * Code deletes one; `text/<project>/<id>.txt`, the prompts and replies to search (src/main/archive/model.ts); and
 * `index.json`, what is known about each session. App data, written directly like prefs.json, never snapshotted; nothing
 * is written into the config folder except when a deleted session is put back to resume it (`placeNewFile`).
 *
 * A sweep runs a few seconds after launch and every 10 minutes over every profile (`watchArchiveFolders`), and when the
 * Sessions screen asks: first it holds every transcript (fast), then reads what is new for search (slow the first time).
 * A development build only archives folders it may write (the fixture), so `npm run dev:real` never links real files.
 */

const SWEEP_EVERY_MS = 10 * 60_000
const FIRST_SWEEP_MS = 4000
/** The Sessions screen waits this long for the holding pass before showing what's known. */
const LIST_WAIT_MS = 3000
const FRESH_MS = 10_000
const WIN = process.platform === 'win32'
/** Screenshots never touch the clipboard of the Mac they run on. */
const SHOT = process.env.CLAUDOCK_SHOT === '1'

interface Meta extends Facts {
  bytes: number
  mtimeMs: number
  /** The live file's inode when last seen; 0 once Claude Code's file is gone. */
  ino: number
  /** Bytes of the transcript turned into search text (whole lines only). */
  parsed: number
  /** Claude Code's file is gone: only the archive has it. */
  gone: boolean
  /** How the archive holds it; null when it doesn't. */
  held: HoldMode | null
}

interface Stored {
  v: 1
  dir: string
  on: boolean
  sessions: Record<string, Meta>
}

interface Folder {
  dir: string
  root: string
  state: Stored
  sweeping: Promise<void> | null
  /** Resolves when the running sweep has held every transcript. */
  held: Promise<void> | null
  lastSweep: number
  indexing: { done: number; total: number } | null
  /** Everything that changes the index or the files runs one at a time per folder (`locked`). */
  lock: Promise<unknown>
}

const folders = new Map<string, Folder>()
let profileDirs: string[] = []

/**
 * A folder's archive. A development build keeps its own (`archive.dev`, like profiles.dev.json): it shares userData with
 * an installed copy, and must never change the archive that copy keeps for a real folder.
 */
export const archiveRootOf = (dir: string): string => path.join(userDataDir(), installKind() === 'dev' ? 'archive.dev' : 'archive', folderKey(dir))
const rootOf = archiveRootOf

const isMeta = (m: unknown): m is Meta =>
  !!m && typeof m === 'object' && typeof (m as Meta).bytes === 'number' && typeof (m as Meta).parsed === 'number' && typeof (m as Meta).gone === 'boolean'

async function folder(dir: string): Promise<Folder> {
  const k = folderKey(dir)
  const had = folders.get(k)
  if (had) return had
  const root = rootOf(dir)
  let state: Stored = { v: 1, dir, on: true, sessions: {} }
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(root, 'index.json'), 'utf8')) as Partial<Stored>
    if (raw.v === 1 && raw.sessions && typeof raw.sessions === 'object') {
      const sessions: Record<string, Meta> = {}
      for (const [key, m] of Object.entries(raw.sessions)) if (splitKey(key) && isMeta(m)) sessions[key] = { ...emptyFacts(), ...m }
      state = { v: 1, dir, on: raw.on !== false, sessions }
    }
  } catch {
    /* new, or unreadable: the sweep rebuilds it from the files */
  }
  // another call may have loaded it meanwhile
  const again = folders.get(k)
  if (again) return again
  const f: Folder = { dir, root, state, sweeping: null, held: null, lastSweep: 0, indexing: null, lock: Promise.resolve() }
  folders.set(k, f)
  return f
}

/**
 * Run `fn` alone on this folder's archive: the sweep's holding pass, each transcript it reads, and every change made from
 * the screen or Projects. So a session moved to the Trash never comes back from a sweep that listed it a moment before.
 */
function locked<T>(f: Folder, fn: () => Promise<T>): Promise<T> {
  const next = f.lock.then(fn, fn)
  f.lock = next.catch(() => undefined)
  return next
}

async function save(f: Folder): Promise<void> {
  await fsp.mkdir(f.root, { recursive: true })
  const tmp = path.join(f.root, `.index.${crypto.randomBytes(4).toString('hex')}.tmp`)
  await fsp.writeFile(tmp, JSON.stringify(f.state) + '\n')
  await fsp.rename(tmp, path.join(f.root, 'index.json'))
}

/** A development build archives only folders it may write: never a real folder looked at with `npm run dev:real`. */
const mayArchive = (dir: string): boolean => writesAllowed(dir)
const archiving = (f: Folder): boolean => f.state.on && mayArchive(f.dir)

function assertMayArchive(f: Folder): void {
  if (!mayArchive(f.dir)) throw new Error('Writes are disabled in development unless CLAUDE_CONFIG_DIR points at a fixture (run `npm run dev`).')
}

const liveFile = (f: Folder, p: string, sid: string): string => path.join(f.dir, 'projects', p, `${sid}.jsonl`)
const liveSide = (f: Folder, p: string, sid: string): string => path.join(f.dir, 'projects', p, sid)
const heldFile = (f: Folder, p: string, sid: string): string => path.join(f.root, 'projects', p, `${sid}.jsonl`)
const heldSide = (f: Folder, p: string, sid: string): string => path.join(f.root, 'projects', p, sid)
const textFile = (f: Folder, p: string, sid: string): string => path.join(f.root, 'text', p, `${sid}.txt`)

const isFile = async (abs: string): Promise<boolean> => (await fsp.lstat(abs).catch(() => null))?.isFile() === true
const isDir = async (abs: string): Promise<boolean> => (await fsp.lstat(abs).catch(() => null))?.isDirectory() === true

/** `<projects>/<project>/<id>.jsonl` files directly in each project folder, with their stats. */
async function transcripts(projects: string): Promise<Map<string, { p: string; sid: string; size: number; mtimeMs: number; ino: number }>> {
  const out = new Map<string, { p: string; sid: string; size: number; mtimeMs: number; ino: number }>()
  const dirs = await fsp.readdir(projects, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    let p: string
    try {
      p = projectDirName(d.name)
    } catch {
      continue
    }
    const files = await fsp.readdir(path.join(projects, p), { withFileTypes: true }).catch(() => [])
    for (const e of files) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      let sid: string
      try {
        sid = sessionFileId(e.name.slice(0, -'.jsonl'.length))
      } catch {
        continue
      }
      const st = await fsp.stat(path.join(projects, p, e.name)).catch(() => null)
      if (st) out.set(keyOf(p, sid), { p, sid, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino })
    }
  }
  return out
}

const newMeta = (): Meta => ({ ...emptyFacts(), bytes: 0, mtimeMs: 0, ino: 0, parsed: 0, gone: false, held: null })

function resetFacts(m: Meta): void {
  Object.assign(m, emptyFacts(), { parsed: 0 })
}

/** The live file an archive file stands for. */
const liveOf = (f: Folder) => (heldAbs: string): string => path.join(f.dir, path.relative(f.root, heldAbs))

/**
 * Archiving stopped for a session Claude Code still has: drop the archive's links and copies of what Claude Code still
 * holds; a sub-agent file only the archive has stays in it. Says whether the transcript itself is still held.
 */
async function release(f: Folder, p: string, sid: string): Promise<boolean> {
  const only = await unhold(heldFile(f, p, sid), liveOf(f))
  await unhold(heldSide(f, p, sid), liveOf(f))
  return only.length > 0
}

/**
 * The user deleted a session (here or in Projects): Claude Code's files are in the Trash already, so the archive's links
 * to the same bytes go, and whatever only the archive has goes to the Trash too, together as one item named `name`.
 */
async function discard(f: Folder, sessions: Array<{ p: string; sid: string }>, name: string): Promise<void> {
  const only: string[] = []
  for (const { p, sid } of sessions) only.push(...(await unhold(heldFile(f, p, sid))), ...(await unhold(heldSide(f, p, sid))))
  await trashTogether(f, name, only)
}

/** Remove the empty folders left below `dir` (and `dir` itself when it ends up empty). */
async function dropEmptyDirs(dir: string): Promise<void> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) await dropEmptyDirs(path.join(dir, e.name))
  await fsp.rmdir(dir).catch(() => undefined)
}

/** Move archive files into one folder named `name` and send it to the Trash; on failure they go back where they were. */
async function trashTogether(f: Folder, name: string, files: string[]): Promise<void> {
  if (files.length === 0) return
  const wrap = path.join(f.root, `.trash-${crypto.randomBytes(4).toString('hex')}`)
  const bin = path.join(wrap, name)
  const moved: Array<[string, string]> = []
  try {
    for (const from of files) {
      const to = path.join(bin, path.relative(f.root, from))
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.rename(from, to)
      moved.push([from, to])
    }
    await shell.trashItem(bin)
  } catch (e) {
    for (const [from, to] of moved.reverse()) {
      await fsp.mkdir(path.dirname(from), { recursive: true }).catch(() => undefined)
      await fsp.rename(to, from).catch(() => undefined)
    }
    throw e
  } finally {
    await dropEmptyDirs(wrap)
  }
}

/** A name for a file or a Trash item from a session's title. */
function fileName(title: string, fallback: string): string {
  const plain = [...title].filter((c) => c >= ' ').join('')
  return plain.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback
}

async function forget(f: Folder, key: string): Promise<void> {
  const k = splitKey(key)
  delete f.state.sessions[key]
  dropText(`${folderKey(f.dir)}:${key}`)
  if (k) await fsp.rm(textFile(f, k.projectId, k.sessionId), { force: true })
}

/* ------------------------------------------------------------------ sweep */

/** Pass 1: hold every transcript (or let go of them when archiving is off) and notice what Claude Code deleted. */
async function holdAll(f: Folder): Promise<boolean> {
  let changed = false
  const on = archiving(f)
  const live = await transcripts(path.join(f.dir, 'projects'))
  const ss = f.state.sessions
  for (const [key, s] of live) {
    let m = ss[key]
    if (!m) {
      m = ss[key] = newMeta()
      changed = true
    }
    if (m.ino !== s.ino || s.size < m.parsed) {
      if (m.parsed > 0) resetFacts(m)
      changed = true
    }
    const touched = m.bytes !== s.size || m.mtimeMs !== s.mtimeMs || m.ino !== s.ino || m.gone
    if (touched) changed = true
    Object.assign(m, { bytes: s.size, mtimeMs: s.mtimeMs, ino: s.ino, gone: false })
    if (on) {
      const was = m.held
      m.held = await hold(liveFile(f, s.p, s.sid), heldFile(f, s.p, s.sid), m.held).catch(() => m.held)
      // sub-agent transcripts are written while the session runs, so only a session that changed needs its folder walked
      const side = liveSide(f, s.p, s.sid)
      if ((touched || was === null) && (await isDir(side))) await holdTree(side, heldSide(f, s.p, s.sid), m.held, isSecret).catch(() => null)
      if (m.held !== was) changed = true
    } else if (m.held && !f.state.on) {
      // stopped by the user; a build that may not archive here leaves another copy's links alone
      if (!(await release(f, s.p, s.sid))) m.held = null
      changed = true
    }
  }
  for (const key of Object.keys(ss)) {
    if (live.has(key)) continue
    const k = splitKey(key)
    const m = ss[key]
    if (k && (await isFile(heldFile(f, k.projectId, k.sessionId)))) {
      if (!m.gone) {
        Object.assign(m, { gone: true, ino: 0 })
        m.held ??= 'copy'
        changed = true
      }
    } else {
      await forget(f, key)
      changed = true
    }
  }
  // the archive's own files are the truth: a session the index lost (a damaged index.json) comes back
  for (const [key, s] of await transcripts(path.join(f.root, 'projects'))) {
    if (ss[key]) continue
    ss[key] = { ...newMeta(), bytes: s.size, mtimeMs: s.mtimeMs, gone: true, held: 'copy' }
    changed = true
  }
  return changed
}

/** Turn what is new in a transcript into search text and facts. A line still being written waits for the next sweep. */
async function readNew(f: Folder, key: string, m: Meta): Promise<void> {
  const k = splitKey(key)
  if (!k) return
  const src = m.gone ? heldFile(f, k.projectId, k.sessionId) : liveFile(f, k.projectId, k.sessionId)
  const out = textFile(f, k.projectId, k.sessionId)
  await fsp.mkdir(path.dirname(out), { recursive: true })
  if (m.parsed === 0) await fsp.writeFile(out, '')
  const lines: string[] = []
  const flush = async (): Promise<void> => {
    if (lines.length) await fsp.appendFile(out, lines.join('\n') + '\n')
    lines.length = 0
  }
  const fh = await fsp.open(src, 'r')
  try {
    for await (const l of iterLines(fh, m.parsed)) {
      if (l.open) break
      m.parsed = l.end
      if (!l.line || l.line.length === 0) continue
      const o = parseLine(l.line)
      if (!o) continue
      lines.push(...foldLine(m, o, l.start))
      if (lines.length >= 2000) await flush()
    }
    await flush()
  } finally {
    await fh.close().catch(() => undefined)
  }
  dropText(`${folderKey(f.dir)}:${key}`)
}

let progressAt = 0
function progress(f: Folder, force = false): void {
  if (!samePath(f.dir, openConfigDir())) return
  if (!force && Date.now() - progressAt < 2000) return
  progressAt = Date.now()
  emit('archive:changed', statusOf(f))
}

/** Pass 2: read what is new, newest sessions first, saving the index as it goes. */
async function readAll(f: Folder): Promise<boolean> {
  const ss = f.state.sessions
  const todo = Object.keys(ss)
    .filter((key) => ss[key].parsed < ss[key].bytes)
    .sort((a, b) => ss[b].mtimeMs - ss[a].mtimeMs)
  if (todo.length === 0) return false
  f.indexing = { done: 0, total: todo.length }
  let savedAt = Date.now()
  try {
    for (const key of todo) {
      // forgotten (moved to the Trash) or started over since the list was made: its turn comes in the next sweep
      await locked(f, async () => {
        const m = ss[key]
        if (m && m.parsed < m.bytes) await readNew(f, key, m)
      }).catch(() => undefined)
      f.indexing.done++
      if (Date.now() - savedAt > 5000) {
        savedAt = Date.now()
        await locked(f, () => save(f)).catch(() => undefined)
        progress(f)
      }
    }
  } finally {
    f.indexing = null
  }
  return true
}

/** Reading passes run one at a time across every profile: the first one reads every transcript once. */
let reading: Promise<unknown> = Promise.resolve()

/** Hold every transcript now, then read what is new once the other profiles' reading is done. */
function sweep(f: Folder): Promise<void> {
  if (f.sweeping) return f.sweeping
  const holding = locked(f, async () => {
    const changed = await holdAll(f)
    if (changed) await save(f)
    return changed
  })
  f.held = holding.then(
    () => undefined,
    () => undefined
  )
  const run = async (): Promise<void> => {
    try {
      if (await holding) progress(f, true)
      const read = reading.then(() => readAll(f))
      reading = read.catch(() => undefined)
      if (await read) {
        await locked(f, () => save(f))
        progress(f, true)
      }
    } finally {
      f.lastSweep = Date.now()
      f.sweeping = null
      f.held = null
    }
  }
  f.sweeping = run()
  return f.sweeping
}

/** Every profile is held first, so a long first read of one never leaves another unprotected. */
async function sweepAll(): Promise<void> {
  const dirs = [openConfigDir(), ...profileDirs.filter((d) => !samePath(d, openConfigDir()))]
  const all = await Promise.all(dirs.map((d) => folder(d)))
  await Promise.all(all.map((f) => sweep(f).catch(() => undefined)))
}

/** The profiles to archive (src/main/domains/profiles.ts); the open folder always is. */
export function watchArchiveFolders(dirs: string[]): void {
  profileDirs = dirs.map((d) => path.resolve(d))
}

/** Sweep the open profile now and wait for it (the screenshot flow). */
export async function sweepNow(): Promise<void> {
  const f = await folder(configDir())
  if (f.sweeping) await f.sweeping
  await sweep(f)
}

/* ------------------------------------------------------------------ list + status */

function statusOf(f: Folder): ArchiveStatus {
  let archived = 0
  let bytes = 0
  const all = Object.values(f.state.sessions)
  for (const m of all) {
    if (m.gone) archived++
    // a link shares Claude Code's bytes; what Claude Code deleted, and a copy on a disk without links, take space
    if (m.gone || m.held === 'copy') bytes += m.bytes
  }
  return { on: archiving(f), readOnly: !mayArchive(f.dir), sessions: all.length, archived, bytes, indexing: f.indexing && { ...f.indexing } }
}

function row(key: string, m: Meta): ArchivedSession {
  const k = splitKey(key) as { projectId: string; sessionId: string }
  return {
    key,
    id: k.sessionId,
    projectId: k.projectId,
    title: titleOf(m),
    cwd: m.cwd,
    startMs: m.startMs,
    endMs: m.endMs,
    mtimeMs: m.mtimeMs,
    messages: m.messages,
    bytes: m.bytes,
    archived: m.gone,
    pending: m.parsed < m.bytes && m.messages === 0
  }
}

const lastMs = (m: Meta): number => m.endMs ?? m.mtimeMs

/** Every session of the open profile, newest first (also the screenshot flow's view of them). */
export async function list(): Promise<ArchiveList> {
  const f = await folder(configDir())
  if (!f.sweeping && Date.now() - f.lastSweep > FRESH_MS) void sweep(f).catch(() => undefined)
  if (f.held) await Promise.race([f.held, new Promise((r) => setTimeout(r, LIST_WAIT_MS))])
  const ss = f.state.sessions
  const keys = Object.keys(ss).sort((a, b) => lastMs(ss[b]) - lastMs(ss[a]))
  return { sessions: keys.map((k) => row(k, ss[k])), status: statusOf(f) }
}

/* ------------------------------------------------------------------ search */

/** Search text kept in memory between searches, up to about 48M characters, oldest dropped first. */
const textCache = new Map<string, { parsed: number; text: string }>()
let cachedChars = 0
const CACHE_CHARS = 48_000_000

function dropText(ck: string): void {
  const c = textCache.get(ck)
  if (!c) return
  textCache.delete(ck)
  cachedChars -= c.text.length
}

async function textOf(f: Folder, key: string, m: Meta): Promise<string> {
  const ck = `${folderKey(f.dir)}:${key}`
  const c = textCache.get(ck)
  if (c && c.parsed === m.parsed) {
    textCache.delete(ck)
    textCache.set(ck, c)
    return c.text
  }
  dropText(ck)
  const k = splitKey(key)
  const text = k ? await fsp.readFile(textFile(f, k.projectId, k.sessionId), 'utf8').catch(() => '') : ''
  // one session bigger than the whole budget is read every time instead of emptying the cache
  if (text.length > CACHE_CHARS / 4) return text
  for (const [old] of textCache) {
    if (cachedChars + text.length <= CACHE_CHARS) break
    dropText(old)
  }
  textCache.set(ck, { parsed: m.parsed, text })
  cachedChars += text.length
  return text
}

let searchGen = 0
const MAX_HITS = 300

/** Full-text search of the open profile's sessions (also the screenshot flow's check). */
export async function search(query: string): Promise<SearchHit[]> {
  const gen = ++searchGen
  const terms = typeof query === 'string' && query.trim().length >= 2 ? queryTerms(query) : []
  if (terms.length === 0) return []
  const f = await folder(configDir())
  const ss = f.state.sessions
  const keys = Object.keys(ss).sort((a, b) => lastMs(ss[b]) - lastMs(ss[a]))
  const out: SearchHit[] = []
  for (let i = 0; i < keys.length && out.length < MAX_HITS; i++) {
    // a newer search started: this one's answer would be thrown away
    if (i % 50 === 49 && gen !== searchGen) return []
    const key = keys[i]
    const m = ss[key]
    if (!m) continue
    const hit = matchSession(titleOf(m), await textOf(f, key, m), terms)
    if (hit) out.push({ key, ...hit })
  }
  return gen === searchGen ? out : []
}

/** Best full-text hits for the command palette, newest first, within a time budget. */
export async function paletteHits(query: string, limit: number): Promise<Array<{ session: ArchivedSession; hit: SearchHit }>> {
  const terms = queryTerms(query)
  if (terms.length === 0 || query.trim().length < 3) return []
  const f = await folder(configDir())
  const ss = f.state.sessions
  const keys = Object.keys(ss).sort((a, b) => lastMs(ss[b]) - lastMs(ss[a]))
  const out: Array<{ session: ArchivedSession; hit: SearchHit }> = []
  const until = Date.now() + 150
  for (const key of keys) {
    if (out.length >= limit || Date.now() > until) break
    const m = ss[key]
    const hit = matchSession(titleOf(m), await textOf(f, key, m), terms)
    if (hit) out.push({ session: row(key, m), hit: { key, ...hit } })
  }
  return out
}

/** The open profile's newest sessions as the command palette lists them (no sweep: what the index knows). */
export async function archiveRows(limit: number): Promise<Array<{ key: string; title: string; project: string }>> {
  const f = await folder(configDir())
  const ss = f.state.sessions
  return Object.keys(ss)
    .sort((a, b) => lastMs(ss[b]) - lastMs(ss[a]))
    .slice(0, limit)
    .map((key) => {
      const m = ss[key]
      const project = m.cwd ? (m.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? m.cwd) : (splitKey(key)?.projectId ?? '').replace(/^-+/, '')
      return { key, title: titleOf(m), project }
    })
}

/* ------------------------------------------------------------------ one session */

async function find(key: unknown): Promise<{ f: Folder; key: string; p: string; sid: string; m: Meta }> {
  const k = splitKey(key)
  if (!k) throw new Error('Invalid session')
  const p = projectDirName(k.projectId)
  const sid = sessionFileId(k.sessionId)
  const f = await folder(configDir())
  const m = f.state.sessions[keyOf(p, sid)]
  if (!m) throw new Error('This session is no longer there')
  return { f, key: keyOf(p, sid), p, sid, m }
}

/** Claude Code's file when it is still there, else the archive's. */
async function sourceOf(f: Folder, p: string, sid: string): Promise<string> {
  const live = liveFile(f, p, sid)
  if (await isFile(live)) return live
  const held = heldFile(f, p, sid)
  if (await isFile(held)) return held
  throw new Error('This transcript no longer exists')
}

async function read(key: string, offset: number, limit: number): ReturnType<ArchiveApi['read']> {
  const { f, p, sid } = await find(key)
  return readTranscriptPage(await sourceOf(f, p, sid), offset, limit)
}

/** Put a session Claude Code deleted back in its project folder: the transcript, then its folder's files. */
async function restore(f: Folder, p: string, sid: string): Promise<void> {
  await placeNewFile(path.join('projects', p, `${sid}.jsonl`), heldFile(f, p, sid))
  const side = heldSide(f, p, sid)
  const walk = async (rel: string): Promise<void> => {
    for (const e of await fsp.readdir(path.join(side, rel), { withFileTypes: true }).catch(() => [])) {
      const r = path.join(rel, e.name)
      if (e.isDirectory()) await walk(r)
      else if (e.isFile()) await placeNewFile(path.join('projects', p, sid, r), path.join(side, r)).catch(() => undefined)
    }
  }
  await walk('')
}

async function resume(key: string): Promise<{ command: string; restored: boolean }> {
  const { f, key: k, p, sid } = await find(key)
  const { m, restored } = await locked(f, async () => {
    const m = f.state.sessions[k]
    if (!m) throw new Error('This session is no longer there')
    if (await isFile(liveFile(f, p, sid))) return { m, restored: false }
    await restore(f, p, sid)
    const st = await fsp.stat(liveFile(f, p, sid))
    Object.assign(m, { gone: false, ino: st.ino, mtimeMs: st.mtimeMs, bytes: st.size })
    if (m.parsed > st.size) resetFacts(m)
    await save(f).catch(() => undefined)
    return { m, restored: true }
  })
  if (restored) progress(f, true)
  const home = os.homedir()
  const start = startCommand(f.dir, home, { plain: usesHomeState(f.dir), windows: WIN })
  const command = resumeCommand(m.cwd, sid, start, { home, windows: WIN })
  if (!SHOT) clipboard.writeText(command)
  return { command, restored }
}

const time = (ts: string): string => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
}

function when(m: Meta): string {
  if (m.startMs === null) return formatDateTime(m.mtimeMs)
  const end = m.endMs ?? m.startMs
  const sameDay = new Date(m.startMs).toDateString() === new Date(end).toDateString()
  return sameDay && end !== m.startMs ? `${formatDateTime(m.startMs)} – ${time(new Date(end).toISOString())}` : formatDateTime(m.startMs)
}

/** The whole session as Markdown (src/main/archive/model.ts `toMarkdown`). */
export async function markdownOf(key: string): Promise<{ name: string; text: string }> {
  const { f, p, sid, m } = await find(key)
  const entries: TranscriptEntry[] = []
  const fh = await fsp.open(await sourceOf(f, p, sid), 'r')
  try {
    for await (const l of iterLines(fh, 0)) {
      if (!l.line || l.line.length === 0) continue
      const o = parseLine(l.line)
      if (!o) continue
      for (const e of entriesFromLine(o, String(l.start), NO_CAPS)) if (e.kind !== 'tool_result' && e.kind !== 'thinking') entries.push(e)
    }
  } finally {
    await fh.close().catch(() => undefined)
  }
  const title = titleOf(m)
  const text = toMarkdown({ title, cwd: m.cwd, id: sid, when: when(m) }, entries, time)
  const name = `${fileName(title, sid)}.md`
  return { name, text }
}

async function exportMarkdown(key: string): Promise<{ path: string } | null> {
  const { name, text } = await markdownOf(key)
  const win = BrowserWindow.getFocusedWindow()
  const options: Electron.SaveDialogOptions = {
    title: 'Export session',
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  }
  const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (r.canceled || !r.filePath) return null
  await fsp.writeFile(r.filePath, text)
  return { path: r.filePath }
}

async function trash(key: string): Promise<void> {
  const { f, key: k, p, sid } = await find(key)
  assertMayArchive(f)
  await locked(f, async () => {
    // Claude Code's files first (the archive's links keep their bytes meanwhile), then what the archive has
    if (await isFile(liveFile(f, p, sid))) await trashInConfig(path.join('projects', p, `${sid}.jsonl`))
    if (await isDir(liveSide(f, p, sid))) await trashInConfig(path.join('projects', p, sid))
    await discard(f, [{ p, sid }], fileName(titleOf(f.state.sessions[k] ?? emptyFacts()), sid))
    await forget(f, k)
    await save(f)
  })
  progress(f, true)
}

async function setOn(on: boolean, trashArchived = false): Promise<ArchiveStatus> {
  const f = await folder(configDir())
  assertMayArchive(f)
  await locked(f, async () => {
    f.state.on = on === true
    if (f.state.on) await holdAll(f)
    else await stop(f, trashArchived === true)
    await save(f)
  })
  progress(f, true)
  return statusOf(f)
}

/** Stop archiving: let go of what Claude Code still has, and move what only the archive has to the Trash if asked. */
async function stop(f: Folder, trashArchived: boolean): Promise<void> {
  for (const [key, m] of Object.entries(f.state.sessions)) {
    const k = splitKey(key)
    if (!k || m.gone || !m.held) continue
    if (!(await release(f, k.projectId, k.sessionId))) m.held = null
  }
  if (!trashArchived) return
  const gone = Object.keys(f.state.sessions).filter((key) => f.state.sessions[key].gone)
  const sessions = gone.flatMap((key) => {
    const k = splitKey(key)
    return k ? [{ p: k.projectId, sid: k.sessionId }] : []
  })
  // one Trash item; the sessions are forgotten only once it is there
  await discard(f, sessions, `Claudock archive ${new Date().toISOString().slice(0, 10)}`)
  for (const key of gone) await forget(f, key)
}

/* ------------------------------------------------------------------ domain */

export function register(ipcMain: IpcMain): void {
  const impl: ArchiveApi = {
    list,
    search,
    read,
    resume,
    exportMarkdown,
    trash,
    setOn,
    async reveal() {
      const f = await folder(configDir())
      await fsp.mkdir(f.root, { recursive: true })
      await shell.openPath(f.root)
    }
  }
  defineDomain(ipcMain, 'archive', impl)
  // Projects moved sessions Claude Code had to the Trash: the archive lets go of them too (their bytes are in the Trash)
  onSessionsTrashed(async (projectId, sessionIds) => {
    const f = await folder(configDir())
    const changed = await locked(f, async () => {
      let n = 0
      for (const sid of sessionIds) {
        const key = keyOf(projectId, sid)
        if (!f.state.sessions[key] || (await isFile(liveFile(f, projectId, sid)))) continue
        await discard(f, [{ p: projectId, sid }], fileName(titleOf(f.state.sessions[key]), sid))
        await forget(f, key)
        n++
      }
      if (n) await save(f)
      return n > 0
    })
    if (changed) progress(f, true)
  })
  onConfigDirChanged(() => void folder(openConfigDir()).then((f) => sweep(f), () => undefined))
  setTimeout(() => void sweepAll(), FIRST_SWEEP_MS)
  setInterval(() => void sweepAll(), SWEEP_EVERY_MS)
}

/** Sessions in the open profile, from its index (no scan); no badge before the first sweep has looked. */
export async function count(): Promise<number | undefined> {
  const f = await folder(configDir())
  const n = Object.keys(f.state.sessions).length
  return n === 0 && f.lastSweep === 0 ? undefined : n
}
