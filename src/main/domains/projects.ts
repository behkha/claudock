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

function projectDirName(id: string): string {
  if (typeof id !== 'string' || !SAFE_NAME.test(id) || id === '.' || id === '..') throw new Error('Invalid project')
  return id
}

function sessionFileId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(id) || id.startsWith('.')) throw new Error('Invalid session')
  return id
}

const relProject = (id: string): string => path.join('projects', id)
const relSession = (id: string, sid: string): string => path.join('projects', id, `${sid}.jsonl`)

/* ------------------------------------------------------------------ reading helpers (exported for memory / search) */

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

interface RawLine {
  /** Bytes of the line without the newline; null if the line was larger than `maxLine` and was skipped. */
  line: Buffer | null
  start: number
  /** Offset just after the newline (or the file end). */
  end: number
  /** The line had no terminating newline (a transcript being written right now). */
  open: boolean
}

const CHUNK = 256 * 1024
const MAX_LINE = 16 * 1024 * 1024

/** Lazily yield the lines of a file from a byte offset. Lines above `maxLine` are skipped, not buffered. */
async function* iterLines(fh: FileHandle, start: number, maxLine = MAX_LINE): AsyncGenerator<RawLine> {
  const buf = Buffer.allocUnsafe(CHUNK)
  let pos = start
  let lineStart = start
  let carry: Buffer[] = []
  let carryLen = 0
  let overflow = false
  for (;;) {
    const { bytesRead } = await fh.read(buf, 0, CHUNK, pos)
    if (bytesRead === 0) break
    const view = buf.subarray(0, bytesRead)
    let s = 0
    for (;;) {
      const nl = view.indexOf(10, s)
      if (nl < 0) {
        if (!overflow) {
          carry.push(Buffer.from(view.subarray(s)))
          carryLen += bytesRead - s
          if (carryLen > maxLine) {
            overflow = true
            carry = []
          }
        } else {
          carryLen += bytesRead - s
        }
        break
      }
      let line: Buffer | null = null
      if (!overflow) {
        carry.push(Buffer.from(view.subarray(s, nl)))
        line = carry.length === 1 ? carry[0] : Buffer.concat(carry)
        if (line.length > maxLine) line = null
      }
      const end = pos + nl + 1
      yield { line, start: lineStart, end, open: false }
      carry = []
      carryLen = 0
      overflow = false
      lineStart = end
      s = nl + 1
    }
    pos += bytesRead
  }
  if (carryLen > 0) {
    const line = overflow ? null : carry.length === 1 ? carry[0] : Buffer.concat(carry)
    yield { line, start: lineStart, end: pos, open: true }
  }
}

/* ------------------------------------------------------------------ transcript parsing */

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** Real text of a user message, or null for system noise (reminders, command output, interrupts). Slash commands become `/name args`. */
function userText(raw: string): { text: string; command: boolean } | null {
  let t = raw
  const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(t)
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? ''
    const name = cmd[1].startsWith('/') ? cmd[1] : `/${cmd[1]}`
    return { text: args ? `${name} ${args}` : name, command: true }
  }
  t = t.replace(REMINDER, '')
  const open = t.indexOf('<system-reminder>')
  if (open >= 0) t = t.slice(0, open)
  t = t.trim()
  if (!t) return null
  if (/^<local-command-(stdout|stderr|caveat)>/.test(t) || /^<command-message>/.test(t)) return null
  if (t.startsWith('Caveat: The messages below were generated by the user while running local commands')) return null
  if (t.startsWith('[Request interrupted by user')) return null
  return { text: t, command: false }
}

function summariseInput(input: unknown): string {
  if (!isObj(input)) return typeof input === 'string' ? input.slice(0, 120) : ''
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'name', 'subject']) {
    const v = input[k]
    if (typeof v === 'string' && v.trim()) return v.trim().split('\n')[0].slice(0, 140)
  }
  try {
    return JSON.stringify(input).slice(0, 140)
  } catch {
    return ''
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObj(b) ? (b.type === 'text' ? str(b.text) : b.type === 'image' ? '[image]' : '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

const TEXT_CAP = 40_000
const RESULT_CAP = 3_000
const THINK_CAP = 6_000

function capped(text: string, cap: number): { text: string; truncated?: boolean; chars?: number } {
  return text.length > cap ? { text: text.slice(0, cap), truncated: true, chars: text.length } : { text }
}

function entriesFromLine(o: Json, key: string): TranscriptEntry[] {
  const type = o.type
  if (type !== 'user' && type !== 'assistant') return []
  if (o.isMeta === true) return []
  const message = isObj(o.message) ? o.message : null
  if (!message) return []
  const content = message.content
  const ts = typeof o.timestamp === 'string' ? o.timestamp : undefined
  const out: TranscriptEntry[] = []
  const push = (e: Omit<TranscriptEntry, 'key' | 'ts'>): void => {
    out.push({ key: `${key}:${out.length}`, ts, ...e })
  }

  if (type === 'user') {
    if (typeof content === 'string') {
      const u = userText(content)
      if (u) push({ kind: u.command ? 'command' : 'user', ...capped(u.text, TEXT_CAP) })
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!isObj(b)) continue
        if (b.type === 'text') {
          const u = userText(str(b.text))
          if (u) push({ kind: u.command ? 'command' : 'user', ...capped(u.text, TEXT_CAP) })
        } else if (b.type === 'tool_result') {
          const text = resultText(b.content)
          push({ kind: 'tool_result', error: b.is_error === true, ...capped(text, RESULT_CAP), chars: text.length })
        }
      }
    }
    return out
  }

  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isObj(b)) continue
      if (b.type === 'text') {
        const t = str(b.text).trim()
        if (t) push({ kind: 'assistant', ...capped(t, TEXT_CAP) })
      } else if (b.type === 'thinking') {
        const t = str(b.thinking).trim()
        if (t) push({ kind: 'thinking', ...capped(t, THINK_CAP) })
      } else if (b.type === 'tool_use') {
        push({ kind: 'tool_use', name: str(b.name) || 'tool', summary: summariseInput(b.input), text: '' })
      }
    }
  } else if (typeof content === 'string' && content.trim()) {
    push({ kind: 'assistant', ...capped(content.trim(), TEXT_CAP) })
  }
  return out
}

function parseLine(line: Buffer): Json | null {
  try {
    const v: unknown = JSON.parse(line.toString('utf8'))
    return isObj(v) ? v : null
  } catch {
    return null
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
 * the project folder that holds `<id>.jsonl`. Null when there is none (yet).
 */
export async function findTranscript(id: string, cwd: string | null): Promise<string | null> {
  let sid: string
  try {
    sid = sessionFileId(id)
  } catch {
    return null
  }
  const known = transcriptDirs.get(sid)
  const guesses = [known, cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : undefined].filter((d): d is string => !!d && SAFE_NAME.test(d))
  for (const d of guesses) {
    const abs = path.join(projectsDir(), d, `${sid}.jsonl`)
    if ((await stat(abs))?.isFile) return (transcriptDirs.set(sid, d), abs)
  }
  const dirs = await fsp.readdir(projectsDir(), { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const abs = path.join(projectsDir(), d.name, `${sid}.jsonl`)
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

let listCache: { at: number; value: Promise<ProjectSummary[]> } | null = null

/** Project list, cached for 5 s so Memory / Search / the Projects screen share one scan. */
export function listProjectSummaries(fresh = false): Promise<ProjectSummary[]> {
  if (!fresh && listCache && Date.now() - listCache.at < 5000) return listCache.value
  const value = buildList()
  listCache = { at: Date.now(), value }
  value.catch(() => {
    if (listCache?.value === value) listCache = null
  })
  return value
}

function invalidateProjects(): void {
  listCache = null
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

async function readSession(projectId: string, sessionId: string, offset: number, limit: number): Promise<SessionPage> {
  const abs = path.join(projectsDir(), projectDirName(projectId), `${sessionFileId(sessionId)}.jsonl`)
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
      try {
        for (const sid of done.sessionIds) await trashSessionFiles(id, sid)
      } finally {
        invalidateProjects()
      }
      return done
    },

    async trashProject(projectId) {
      const id = projectDirName(projectId)
      const st = await stat(path.join(projectsDir(), id))
      if (!st?.isDir) throw new Error('This project folder no longer exists')
      await trash(relProject(id))
      invalidateProjects()
      cwdCache.delete(id)
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
