import { shell, type IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import type {
  CleanupPreview,
  ProjectSummary,
  SessionPage,
  SessionSummary,
  TranscriptEntry
} from '@shared/api/projects'
import { dirSize, exists, readJson, stat } from '../fsx'
import { defineDomain } from '../ipcx'
import { assertNotSecretReal, configDir, globalStateFile } from '../paths'
import { trash } from '../safeWrite'
import { entriesFromLine, isObj, iterLines, parseLine } from '../transcripts/parse'
import { historyProjectPaths } from './history'

/**
 * Projects: one folder per project under `projects/`. Real folder names come from the `cwd` field in the
 * transcripts (the folder name is a lossy encoding). Transcripts can be hundreds of MB, so nothing here reads a
 * whole file: names and titles come from the head of a file, the viewer streams pages by byte offset, and sizes
 * come from `stat`.
 */

const projectsDir = (): string => path.join(configDir(), 'projects')

/* ------------------------------------------------------------------ ids */

const SAFE_NAME = /^[^\\/\0]{1,255}$/

export function projectDirName(id: string): string {
  if (typeof id !== 'string' || !SAFE_NAME.test(id) || id === '.' || id === '..') throw new Error('Invalid project')
  return id
}

export function sessionFileId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(id) || id.startsWith('.')) throw new Error('Invalid session')
  return id
}

const relProject = (id: string): string => path.join('projects', id)
const relSession = (id: string, sid: string): string => path.join('projects', id, `${sid}.jsonl`)

/* ------------------------------------------------------------------ reading helpers (exported for memory / search / archive) */

/** First `bytes` of a file as text. A multi-byte character cut at the end becomes U+FFFD, which is fine for heads. */
export async function readHead(abs: string, bytes: number): Promise<string> {
  let fh: FileHandle | undefined
  try {
    await assertNotSecretReal(abs)
    fh = await fsp.open(abs, 'r')
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

/* ------------------------------------------------------------------ titles + cwd from the head of a transcript */

const HEAD_TITLE_BYTES = 2 * 1024 * 1024
const titleCache = new Map<string, { mtimeMs: number; size: number; title: string }>()

/** First real user prompt of a transcript, found by reading lines from the start (stops early; at most ~2 MB). */
async function firstPrompt(abs: string): Promise<string> {
  let fh: FileHandle | undefined
  try {
    fh = await fsp.open(abs, 'r')
    let read = 0
    for await (const l of iterLines(fh, 0, 1024 * 1024)) {
      read = l.end
      if (read > HEAD_TITLE_BYTES) break
      if (!l.line) continue
      const o = parseLine(l.line)
      if (!o || o.type !== 'user' || o.isMeta === true) continue
      const entries = entriesFromLine(o, '0').filter((e) => e.kind === 'user' || e.kind === 'command')
      if (entries.length) return entries[0].text.replace(/\s+/g, ' ').trim().slice(0, 160)
    }
  } catch {
    /* unreadable: no title */
  } finally {
    await fh?.close().catch(() => undefined)
  }
  return ''
}

/** Cached by path + mtime + size. Returns '' when there is no user prompt in the head. */
export async function sessionTitle(abs: string): Promise<string> {
  const st = await stat(abs)
  if (!st) return ''
  const c = titleCache.get(abs)
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.title
  const title = await firstPrompt(abs)
  titleCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, title })
  return title
}

/* ------------------------------------------------------------------ a session's own name */

const NAME_TAIL_BYTES = 256 * 1024
/** Claude Code appends these again and again while a session runs: the newest one is the name it shows. */
const NAME_LINE_RE = /"type":"(custom-title|agent-name)"/
const NAME_RECHECK_MS = 30_000
const nameCache = new Map<string, { checked: number; size: number; name: string | null }>()

async function readTail(abs: string, bytes: number, size: number): Promise<string> {
  const fh = await fsp.open(abs, 'r')
  try {
    const from = Math.max(0, size - bytes)
    const buf = Buffer.allocUnsafe(size - from)
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** The newest custom-title (else agent-name) in `text`, or null. */
function nameIn(text: string): string | null {
  let agent: string | null = null
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = NAME_LINE_RE.exec(lines[i])
    if (!m) continue
    const o = parseLine(Buffer.from(lines[i]))
    const v = m[1] === 'custom-title' ? o?.customTitle : o?.agentName
    if (typeof v !== 'string' || !v.trim()) continue
    const name = v.replace(/\s+/g, ' ').trim().slice(0, 160)
    if (m[1] === 'custom-title') return name
    agent ??= name
  }
  return agent
}

/**
 * The session's own name in Claude Code: the title it shows, or one set with /rename. Read from the end of the
 * transcript (then its head), at most every 30 s per file while it keeps growing. Null when it has none.
 */
export async function ownSessionName(abs: string): Promise<string | null> {
  const st = await stat(abs)
  if (!st) return null
  const c = nameCache.get(abs)
  if (c && (c.size === st.size || Date.now() - c.checked < NAME_RECHECK_MS)) return c.name
  let name: string | null = null
  try {
    await assertNotSecretReal(abs)
    name = nameIn(await readTail(abs, NAME_TAIL_BYTES, st.size))
    if (name === null && st.size > NAME_TAIL_BYTES) name = nameIn(await readHead(abs, NAME_TAIL_BYTES))
  } catch {
    /* unreadable: no name */
  }
  nameCache.set(abs, { checked: Date.now(), size: st.size, name })
  return name
}

const transcriptDirs = new Map<string, string>()

/**
 * A session's transcript: `projects/<cwd with every other character as ->/<id>.jsonl`, as Claude Code names it, else
 * the project folder that holds `<id>.jsonl`. Null when there is none (yet). `root`: another profile's projects folder.
 */
export async function findTranscript(id: string, cwd: string | null, root = projectsDir()): Promise<string | null> {
  let sid: string
  try {
    sid = sessionFileId(id)
  } catch {
    return null
  }
  const known = transcriptDirs.get(sid)
  const guesses = [known, cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : undefined].filter((d): d is string => !!d && SAFE_NAME.test(d))
  for (const d of guesses) {
    const abs = path.join(root, d, `${sid}.jsonl`)
    if ((await stat(abs))?.isFile) return (transcriptDirs.set(sid, d), abs)
  }
  const dirs = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const abs = path.join(root, d.name, `${sid}.jsonl`)
    if ((await stat(abs))?.isFile) return (transcriptDirs.set(sid, d.name), abs)
  }
  return null
}

const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/

async function cwdFromFile(abs: string): Promise<string | null> {
  for (const bytes of [64 * 1024, 1024 * 1024]) {
    const head = await readHead(abs, bytes)
    const m = CWD_RE.exec(head)
    if (m) {
      try {
        const v: unknown = JSON.parse(`"${m[1]}"`)
        if (typeof v === 'string' && v) return v
      } catch {
        /* keep looking */
      }
    }
    if (head.length < bytes / 2) break // the whole file was smaller than the window
  }
  return null
}

/* ------------------------------------------------------------------ project scan */

interface Scan {
  id: string
  files: Array<{ name: string; size: number; mtimeMs: number }>
  dirs: Set<string>
  other: number
  dirMtimeMs: number
}

async function scanProject(id: string): Promise<Scan | null> {
  const abs = path.join(projectsDir(), id)
  const st = await stat(abs)
  if (!st || !st.isDir) return null
  let ents
  try {
    ents = await fsp.readdir(abs, { withFileTypes: true })
  } catch {
    return null
  }
  const files: Scan['files'] = []
  const dirs = new Set<string>()
  let other = 0
  await Promise.all(
    ents.map(async (e) => {
      if (e.isDirectory()) {
        dirs.add(e.name)
        return
      }
      const fst = await stat(path.join(abs, e.name))
      if (!fst || !fst.isFile) return
      if (e.name.endsWith('.jsonl')) files.push({ name: e.name, size: fst.size, mtimeMs: fst.mtimeMs })
      else other += fst.size
    })
  )
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { id, files, dirs, other, dirMtimeMs: st.mtimeMs }
}

const encodePath = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-')

/** encoded folder name -> real path, from history.jsonl and the global state file (used when no transcript has a `cwd`). */
async function fallbackPaths(): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  for (const p of await historyProjectPaths()) m.set(encodePath(p), p)
  const state = await readJson<{ projects?: Record<string, unknown> }>(globalStateFile())
  if (state && isObj(state.projects)) for (const p of Object.keys(state.projects)) if (!m.has(encodePath(p))) m.set(encodePath(p), p)
  return m
}

const cwdCache = new Map<string, { newest: string; cwd: string | null; at: number }>()

async function resolveCwd(scan: Scan): Promise<string | null> {
  const newest = scan.files[0]?.name ?? ''
  const c = cwdCache.get(scan.id)
  if (c && c.newest === newest && (c.cwd !== null || Date.now() - c.at < 30_000)) return c.cwd
  let cwd: string | null = null
  for (const f of scan.files.slice(0, 3)) {
    cwd = await cwdFromFile(path.join(projectsDir(), scan.id, f.name))
    if (cwd) break
  }
  cwdCache.set(scan.id, { newest, cwd, at: Date.now() })
  return cwd
}

const baseName = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() ?? p
const fallbackName = (id: string): string => {
  const scratch = /scratch-(\d{4}-\d{2}-\d{2}-\w+)$/.exec(id)
  if (scratch) return `scratch ${scratch[1]}`
  return id.replace(/^-+/, '') || '/'
}

async function buildList(): Promise<ProjectSummary[]> {
  let names: string[]
  try {
    names = (await fsp.readdir(projectsDir(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const scans = (await Promise.all(names.map(scanProject))).filter((s): s is Scan => s !== null)
  const cwds = await Promise.all(scans.map(resolveCwd))
  let fallback: Map<string, string> | null = null
  const out: ProjectSummary[] = []
  for (let i = 0; i < scans.length; i++) {
    const s = scans[i]
    let cwd = cwds[i]
    if (!cwd) {
      fallback ??= await fallbackPaths()
      cwd = fallback.get(s.id) ?? null
    }
    const missing = cwd ? !(await exists(cwd)) : false
    out.push({
      id: s.id,
      name: cwd ? baseName(cwd) : fallbackName(s.id),
      path: cwd,
      missing,
      sessions: s.files.length,
      bytes: s.files.reduce((n, f) => n + f.size, 0) + s.other,
      lastActiveMs: s.files[0]?.mtimeMs ?? s.dirMtimeMs,
      hasMemory: s.dirs.has('memory')
    })
  }
  return out
}

let listCache: { dir: string; at: number; value: Promise<ProjectSummary[]> } | null = null

/** Project list, cached for 5 s so Memory / Search / the Projects screen share one scan (of the same profile). */
export function listProjectSummaries(fresh = false): Promise<ProjectSummary[]> {
  if (!fresh && listCache && listCache.dir === configDir() && Date.now() - listCache.at < 5000) return listCache.value
  const value = buildList()
  listCache = { dir: configDir(), at: Date.now(), value }
  value.catch(() => {
    if (listCache?.value === value) listCache = null
  })
  return value
}

function invalidateProjects(): void {
  listCache = null
}

type TrashListener = (projectId: string, sessionIds: string[]) => Promise<void>
const trashListeners = new Set<TrashListener>()

/** Sessions moved to the Trash here (alone, by a cleanup or with their project folder), so the session archive drops its copies too. */
export const onSessionsTrashed = (cb: TrashListener): void => void trashListeners.add(cb)

async function trashed(projectId: string, sessionIds: string[]): Promise<void> {
  for (const cb of trashListeners) await cb(projectId, sessionIds).catch(() => undefined)
}

/* ------------------------------------------------------------------ sessions */

async function listSessions(id: string): Promise<SessionSummary[]> {
  const scan = await scanProject(projectDirName(id))
  if (!scan) throw new Error('This project folder no longer exists')
  return scan.files.map((f) => {
    const sid = f.name.slice(0, -'.jsonl'.length)
    return { id: sid, rel: relSession(id, sid), bytes: f.size, mtimeMs: f.mtimeMs, hasSidecar: scan.dirs.has(sid) }
  })
}

/** Titles for many sessions, 6 files at a time. */
export async function sessionTitles(projectId: string, sessionIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const queue = sessionIds.map(sessionFileId)
  const worker = async (): Promise<void> => {
    for (let sid = queue.shift(); sid !== undefined; sid = queue.shift()) {
      out[sid] = await sessionTitle(path.join(projectsDir(), projectDirName(projectId), `${sid}.jsonl`))
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))
  return out
}

/** One page of a transcript file from byte `offset`: about `limit` entries. Also reads the session archive's copies. */
export async function readTranscriptPage(abs: string, offset: number, limit: number): Promise<SessionPage> {
  const st = await stat(abs)
  if (!st || !st.isFile) throw new Error('This transcript no longer exists')
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, st.size))
  const want = Math.max(1, Math.min(Math.floor(limit) || 200, 1000))
  const entries: TranscriptEntry[] = []
  let skipped = 0
  let next: number | null = null
  await assertNotSecretReal(abs)
  const fh = await fsp.open(abs, 'r')
  try {
    for await (const l of iterLines(fh, start)) {
      next = l.end
      if (!l.line) {
        skipped++
      } else if (l.line.length > 0) {
        const o = parseLine(l.line)
        if (!o) {
          if (!l.open) skipped++
        } else {
          for (const e of entriesFromLine(o, String(l.start))) entries.push(e)
        }
      }
      if (entries.length >= want) break
    }
  } finally {
    await fh.close().catch(() => undefined)
  }
  return { entries, nextOffset: next !== null && next < st.size ? next : null, totalBytes: st.size, skipped }
}

const readSession = (projectId: string, sessionId: string, offset: number, limit: number): Promise<SessionPage> =>
  readTranscriptPage(path.join(projectsDir(), projectDirName(projectId), `${sessionFileId(sessionId)}.jsonl`), offset, limit)

/* ------------------------------------------------------------------ trash + cleanup */

async function sidecarBytes(id: string, sid: string): Promise<number> {
  const dir = path.join(projectsDir(), id, sid)
  const st = await stat(dir)
  return st?.isDir ? (await dirSize(dir)).bytes : 0
}

async function trashSessionFiles(id: string, sid: string): Promise<void> {
  const file = path.join(projectsDir(), id, `${sid}.jsonl`)
  if (!(await exists(file))) throw new Error('This transcript no longer exists')
  await trash(relSession(id, sid))
  const side = path.join(projectsDir(), id, sid)
  const st = await stat(side)
  if (st?.isDir) await trash(path.join('projects', id, sid))
  titleCache.delete(file)
}

async function olderThan(projectId: string, days: number): Promise<SessionSummary[]> {
  if (!Number.isFinite(days) || days < 1) throw new Error('Pick a number of days')
  const cutoff = Date.now() - days * 86_400_000
  return (await listSessions(projectId)).filter((s) => s.mtimeMs < cutoff)
}

async function summarizeCleanup(id: string, old: SessionSummary[]): Promise<CleanupPreview> {
  const side = await Promise.all(old.map((s) => (s.hasSidecar ? sidecarBytes(id, s.id) : Promise.resolve(0))))
  return { count: old.length, bytes: old.reduce((n, s, i) => n + s.bytes + side[i], 0), sessionIds: old.map((s) => s.id) }
}

async function previewCleanup(projectId: string, days: number): Promise<CleanupPreview> {
  const id = projectDirName(projectId)
  return summarizeCleanup(id, await olderThan(id, days))
}

/* ------------------------------------------------------------------ domain */

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'projects', {
    list: () => listProjectSummaries(true),

    async sizes() {
      let names: string[] = []
      try {
        names = (await fsp.readdir(projectsDir(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
      } catch {
        /* no projects folder */
      }
      const out: Record<string, number> = {}
      await Promise.all(
        names.map(async (n) => {
          out[n] = (await dirSize(path.join(projectsDir(), n))).bytes
        })
      )
      return out
    },

    sessions: (projectId) => listSessions(projectId),
    titles: (projectId, sessionIds) => sessionTitles(projectId, sessionIds),
    readSession: (projectId, sessionId, offset, limit) => readSession(projectId, sessionId, offset, limit),

    async trashSession(projectId, sessionId) {
      await trashSessionFiles(projectDirName(projectId), sessionFileId(sessionId))
      invalidateProjects()
      await trashed(projectId, [sessionId])
    },

    cleanupPreview: (projectId, days) => previewCleanup(projectId, days),

    async cleanup(projectId, days, sessionIds) {
      const id = projectDirName(projectId)
      let targets = await olderThan(id, days) // still older than the cutoff right now
      if (sessionIds !== undefined) {
        // only what the user confirmed: a session resumed since the preview is no longer "old" and drops out
        if (!Array.isArray(sessionIds)) throw new Error('Invalid session list')
        const confirmed = new Set(sessionIds.map(sessionFileId))
        targets = targets.filter((s) => confirmed.has(s.id))
      }
      const done = await summarizeCleanup(id, targets)
      const gone: string[] = []
      try {
        for (const sid of done.sessionIds) {
          await trashSessionFiles(id, sid)
          gone.push(sid)
        }
      } finally {
        invalidateProjects()
        await trashed(id, gone)
      }
      return done
    },

    async trashProject(projectId) {
      const id = projectDirName(projectId)
      const st = await stat(path.join(projectsDir(), id))
      if (!st?.isDir) throw new Error('This project folder no longer exists')
      const sessions = (await listSessions(id)).map((s) => s.id)
      await trash(relProject(id))
      invalidateProjects()
      cwdCache.delete(id)
      await trashed(id, sessions)
    },

    async revealFolder(projectId) {
      const id = projectDirName(projectId)
      const p = (await listProjectSummaries()).find((x) => x.id === id)
      // the cwd comes from a transcript as written: it may use '/' on Windows, end in a separator or hold '..'
      if (!p?.path || !path.isAbsolute(p.path)) throw new Error('The real folder of this project is not known')
      const folder = path.resolve(p.path)
      if (!(await stat(folder))?.isDir) throw new Error('This folder no longer exists on disk')
      shell.showItemInFolder(folder)
    }
  })
}

export async function count(): Promise<number> {
  try {
    return (await fsp.readdir(projectsDir(), { withFileTypes: true })).filter((e) => e.isDirectory()).length
  } catch {
    return 0
  }
}
