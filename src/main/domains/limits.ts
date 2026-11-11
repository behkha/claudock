import type { IpcMain } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LimitHits, LimitsApi, LimitsState, LiveLimits, TokenWindow, TokenWindows } from '@shared/api/limits'
import { liveFrom, quotaHit, rememberWindows, windowInfo, windowsToDraw } from '@shared/limits'
import { connectDir, connectDirFor, folderKey, readConnectState, writeOwn, type ConnectState } from '../connect/folder'
import { shQuote } from '../connect/hookScript'
import { stepScript as scriptFor } from '../connect/limitScript'
import { defineDomain, emit } from '../ipcx'
import { configDir, onConfigDirChanged, openConfigDir, samePath } from '../paths'
import type { UsageFile } from '../today/activity'
import { isObj, readSettings } from './extendShared'

/**
 * Limits: token counts from the transcripts under projects/, and the percentages Claude Code hands to the status line
 * for whatever windows it tracks (which ones is its to say: @shared/limits reads and names them). The status line step is a small sh script in Claudock's connect folder
 * (`<userData>/connect/<config dir hash>/`, never the config folder): it saves `rate_limits` to limits.json there,
 * then runs the statusLine command the user had before, with the same input. "Connect to Claude Code"
 * (src/main/domains/connect.ts) installs and removes it; this file owns the script and reads what it saves.
 */

const DAY = 86_400_000
const HOUR = 3_600_000
const WIN = process.platform === 'win32'
const SCRIPT = 'statusline.sh'
const LIVE = 'limits.json'
/** Which windows Claude Code has sent, and when last (`rememberWindows`). */
const SEEN = 'windows.json'

/** The statusLine.command while the step is on. `conn`: a profile's connect folder (the open one by default). */
export function stepCommand(conn = connectDir()): string {
  return `sh ${shQuote(path.join(conn, SCRIPT))}`
}

/** settings.json's statusLine runs the step. */
export const isStepOn = (statusLine: unknown, conn = connectDir()): boolean => isObj(statusLine) && statusLine.command === stepCommand(conn)

/* ------------------------------------------------------------------ the status line step */

/** The step's script (src/main/connect/limitScript.ts) for a connect folder: the open profile's by default. */
export const stepScript = (original: string | null, conn = connectDir()): string => scriptFor(original, conn)

/** The statusLine.command the step wraps (the one the user had before), or null. */
export const commandOf = (state: ConnectState | null): string | null => {
  const o = state?.statusLine?.original
  return o?.present && isObj(o.value) && typeof o.value.command === 'string' ? o.value.command : null
}

/** Write the step's script for the statusLine it wraps. Must exist before settings.json points at it. */
export async function writeStepScript(original: string | null): Promise<void> {
  await Promise.all([LIVE, SEEN].map((n) => fsp.rm(path.join(connectDir(), n), { force: true })))
  await writeOwn(SCRIPT, stepScript(original), 0o755)
}

/** The step's files, when settings.json never pointed at them (a Connect that failed). */
export async function removeStepFiles(): Promise<void> {
  await Promise.all([SCRIPT, LIVE, SEEN].map((n) => fsp.rm(path.join(connectDir(), n), { force: true })))
}

/**
 * After Disconnect: the saved limits go; the script stays (it runs the user's own status line), so a session that
 * still runs it until Claude Code reloads settings.json keeps its status line. The next Connect rewrites it.
 */
export async function retireStepFiles(): Promise<void> {
  await Promise.all([LIVE, SEEN].map((n) => fsp.rm(path.join(connectDir(), n), { force: true })))
}

/**
 * The script is regenerated from state.json while settings.json points at it: when it went missing, and when an
 * earlier Claudock wrote it (its text differs from today's).
 */
async function ensureScript(dir: string): Promise<void> {
  if (WIN) return
  const conn = connectDirFor(dir)
  const st = await readConnectState(conn)
  if (!st?.statusLine) return
  const want = stepScript(commandOf(st), conn)
  if ((await fsp.readFile(path.join(conn, SCRIPT), 'utf8').catch(() => null)) === want) return
  if (!isStepOn((await readSettings(dir)).data.statusLine, conn)) return
  await writeOwn(SCRIPT, want, 0o755, conn)
}

/* ------------------------------------------------------------------ live limits (from the step) */

async function readLive(conn: string): Promise<LiveLimits | null> {
  try {
    return liveFrom(JSON.parse(await fsp.readFile(path.join(conn, LIVE), 'utf8')))
  } catch {
    return null
  }
}

/** Memory is rewritten when a window comes or goes, or its last sighting is this much older than the reading. */
const SEEN_EVERY = HOUR

/** The windows Claude Code has sent this profile, brought up to date with `live` and saved when that changed them. */
async function seenWindows(conn: string, live: LiveLimits | null): Promise<Record<string, number> | null> {
  let had: Record<string, number> | null = null
  try {
    const o = JSON.parse(await fsp.readFile(path.join(conn, SEEN), 'utf8')) as unknown
    if (isObj(o) && o.v === 1 && isObj(o.seen)) had = Object.fromEntries(Object.entries(o.seen).filter((e): e is [string, number] => typeof e[1] === 'number'))
  } catch {
    /* nothing remembered yet */
  }
  const now = rememberWindows(had, live)
  if (!now || !live) return now
  const keys = Object.keys(now)
  const changed = !had || keys.length !== Object.keys(had).length || keys.some((k) => !(k in had) || now[k] - had[k] >= SEEN_EVERY)
  if (changed) await writeOwn(SEEN, JSON.stringify({ v: 1, seen: now }) + '\n', 0o644, conn).catch(() => undefined)
  return now
}

/* ------------------------------------------------------------------ token windows (from transcripts) */

interface Entry {
  t: number
  /** message.id + requestId: Claude Code writes one message as several lines that repeat the same usage. */
  key: string
  tokens: number
  session: string
}

interface FileScan {
  size: number
  mtimeMs: number
  /** Bytes read so far, always at a line start. */
  offset: number
  entries: Entry[]
  /** The working folder the transcript's lines name. */
  cwd: string | null
  /** The newest limit Claude Code reported as reached in this file, per window. */
  hits: LimitHits
  /** The model ids its assistant lines name. */
  models: Set<string>
}

/** One profile's transcripts, read incrementally: the open profile's for Today, every profile's for the menu bar. */
interface Scanned {
  files: Map<string, FileScan>
  scanning: Promise<void> | null
  at: number
}
const scanned = new Map<string, Scanned>()
const scansOf = (dir: string): Scanned => {
  const k = folderKey(dir)
  let s = scanned.get(k)
  if (!s) scanned.set(k, (s = { files: new Map(), scanning: null, at: 0 }))
  return s
}
const CHUNK = 1024 * 1024
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function entryOf(line: string, cutoff: number, scan?: FileScan): Entry | null {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObj(o) || o.type !== 'assistant' || !isObj(o.message) || !isObj(o.message.usage)) return null
  if (scan && scan.cwd === null && typeof o.cwd === 'string' && o.cwd) scan.cwd = o.cwd
  const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  // a refused request: Claude Code's own record of a limit reached (desktop sessions write it too)
  const q = scan && o.quotaLimits !== undefined ? quotaHit(o.quotaLimits, t) : null
  if (q && scan && q.hit.at >= (scan.hits[q.window]?.at ?? 0)) scan.hits[q.window] = q.hit
  if (o.message.model === '<synthetic>') return null
  if (scan && typeof o.message.model === 'string' && o.message.model) scan.models.add(o.message.model)
  if (!Number.isFinite(t) || t < cutoff) return null
  const u = o.message.usage
  const tokens = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
  if (tokens === 0) return null
  const id = typeof o.message.id === 'string' ? o.message.id : ''
  const req = typeof o.requestId === 'string' ? o.requestId : ''
  const key = id || req ? `${id}:${req}` : typeof o.uuid === 'string' ? o.uuid : `${t}:${tokens}`
  return { t, key, tokens, session: typeof o.sessionId === 'string' ? o.sessionId : '' }
}

/** Read `abs` from `from` to `to`, push entries for complete lines, return the offset after the last one read. */
async function readFrom(abs: string, from: number, to: number, cutoff: number, scan: FileScan): Promise<number> {
  const out = scan.entries
  const fh = await fsp.open(abs, 'r')
  try {
    let pos = from
    let offset = from
    let rest = ''
    const buf = Buffer.alloc(CHUNK)
    while (pos < to) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, to - pos), pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const text = rest + buf.toString('utf8', 0, bytesRead)
      const lines = text.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        offset += Buffer.byteLength(line, 'utf8') + 1
        const e = entryOf(line, cutoff, scan)
        if (e) out.push(e)
      }
    }
    // a last line without a newline counts once it is whole (it parses); a line still being written does not
    if (rest.trim()) {
      try {
        JSON.parse(rest)
        const e = entryOf(rest, cutoff, scan)
        if (e) out.push(e)
        offset += Buffer.byteLength(rest, 'utf8')
      } catch {
        /* still being written: read again next time */
      }
    }
    return offset
  } finally {
    await fh.close()
  }
}

/** Transcripts changed since `cutoff`: projects/<p>/*.jsonl and projects/<p>/<session>/subagents/*.jsonl. */
async function recentTranscripts(dir: string, cutoff: number): Promise<{ abs: string; size: number; mtimeMs: number }[]> {
  const root = path.join(dir, 'projects')
  const out: { abs: string; size: number; mtimeMs: number }[] = []
  const add = async (abs: string): Promise<void> => {
    const st = await fsp.stat(abs).catch(() => null)
    if (st?.isFile() && st.mtimeMs >= cutoff) out.push({ abs, size: st.size, mtimeMs: st.mtimeMs })
  }
  const projects = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const dir = path.join(root, p.name)
    const items = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      items.map(async (it) => {
        if (it.isFile() && it.name.endsWith('.jsonl')) return add(path.join(dir, it.name))
        if (!it.isDirectory()) return
        const sub = path.join(dir, it.name, 'subagents')
        const agents = await fsp.readdir(sub).catch(() => [] as string[])
        await Promise.all(agents.filter((n) => n.endsWith('.jsonl')).map((n) => add(path.join(sub, n))))
      })
    )
  }
  return out
}

async function scanTranscripts(dir: string, scans: Map<string, FileScan>, now: number): Promise<void> {
  const cutoff = now - SCAN_MS
  const files = await recentTranscripts(dir, cutoff)
  const live = new Set(files.map((f) => f.abs))
  for (const k of scans.keys()) if (!live.has(k)) scans.delete(k)
  for (const f of files) {
    let s = scans.get(f.abs)
    if (s && s.size === f.size && s.mtimeMs === f.mtimeMs) continue
    // shrunk or rewritten in place: read it all again; grown: read only what was appended
    if (!s || f.size < s.offset || (f.size === s.size && f.mtimeMs !== s.mtimeMs)) s = { size: 0, mtimeMs: 0, offset: 0, entries: [], cwd: null, hits: {}, models: new Set() }
    try {
      s.offset = await readFrom(f.abs, s.offset, f.size, cutoff, s)
      s.size = f.size
      s.mtimeMs = f.mtimeMs
      scans.set(f.abs, s)
    } catch {
      scans.delete(f.abs)
    }
  }
  for (const s of scans.values()) if (s.entries.length && s.entries[0].t < cutoff) s.entries = s.entries.filter((e) => e.t >= cutoff)
}

/** Transcripts are scanned this far back, so tokens can stand in for windows up to this long. */
const SCAN_MS = 7 * DAY

/** Tokens since local midnight, and in each of `keys` whose name gives a length the scan covers. */
function tokenWindows(scans: Map<string, FileScan>, now: number, keys: string[]): TokenWindows {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const TODAY = ' today'
  const starts = new Map<string, number>([[TODAY, midnight.getTime()]])
  for (const k of keys) {
    const info = windowInfo(k)
    if (info.tokenSpan && info.spanMs !== null && info.spanMs <= SCAN_MS) starts.set(k, now - info.spanMs)
  }
  const acc = new Map([...starts.keys()].map((k) => [k, { tokens: 0, sessions: new Set<string>() }]))
  // a resumed session repeats earlier messages in its new file: count each message once across files
  const seen = new Set<string>()
  for (const s of scans.values()) {
    for (const e of s.entries) {
      if (seen.has(e.key)) continue
      seen.add(e.key)
      for (const [k, start] of starts) {
        if (e.t < start) continue
        const a = acc.get(k)!
        a.tokens += e.tokens
        if (e.session) a.sessions.add(e.session)
      }
    }
  }
  const out = (k: string): TokenWindow => ({ tokens: acc.get(k)!.tokens, sessions: acc.get(k)!.sessions.size })
  return { today: out(TODAY), windows: Object.fromEntries([...starts.keys()].filter((k) => k !== TODAY).map((k) => [k, out(k)])) }
}

/** Scans are incremental and shared: callers within 5 s reuse the last one. */
async function scan(dir: string): Promise<Map<string, FileScan>> {
  const s = scansOf(dir)
  if (Date.now() - s.at > 5000) {
    s.scanning ??= scanTranscripts(dir, s.files, Date.now()).finally(() => {
      s.at = Date.now()
      s.scanning = null
    })
    await s.scanning
  }
  return s.files
}

/**
 * The transcripts of the last 7 days as the scan keeps them, for Today (src/main/domains/today.ts): which project and
 * session each file belongs to (a subagent's file sits in its session's folder), its folder and its token lines.
 */
export async function transcriptUsage(): Promise<UsageFile[]> {
  const scans = await scan(configDir())
  const root = path.join(configDir(), 'projects')
  const out: UsageFile[] = []
  for (const [abs, s] of scans) {
    const rel = path.relative(root, abs).split(path.sep)
    if (rel.length < 2) continue
    out.push({ project: rel[0], session: rel.length > 2 ? rel[1] : path.basename(rel[1], '.jsonl'), cwd: s.cwd, entries: s.entries })
  }
  return out
}

/**
 * The model ids this profile has used, for the Model field in Settings: the last 7 days of transcripts as the scan
 * keeps them, and every model in Claude Code's own stats cache (all time). Read locally; sent nowhere.
 */
export async function usedModelIds(): Promise<string[]> {
  const ids = new Set<string>()
  for (const s of (await scan(configDir())).values()) for (const m of s.models) ids.add(m)
  try {
    const stats = JSON.parse(await fsp.readFile(path.join(configDir(), 'stats-cache.json'), 'utf8')) as unknown
    if (isObj(stats) && isObj(stats.modelUsage)) for (const m of Object.keys(stats.modelUsage)) ids.add(m)
  } catch {
    /* no stats cache */
  }
  return [...ids].filter((m) => m.length <= 120).sort()
}

/* ------------------------------------------------------------------ state, watching, events */

/** The newest reached limit per window across the scanned transcripts, while its window hasn't reset. */
function currentHits(scans: Map<string, FileScan>, now: number): LimitHits {
  const out: LimitHits = {}
  for (const s of scans.values())
    for (const [k, h] of Object.entries(s.hits)) {
      if (h.resetsAt > now && h.at >= (out[k]?.at ?? 0)) out[k] = h
    }
  return out
}

/** Everything the limits card and the menu bar glance show, for one profile's folder. */
export async function limitsIn(dir: string): Promise<LimitsState> {
  const scans = await scan(dir)
  const now = Date.now()
  const hits = currentHits(scans, now)
  const state = (step: LimitsState['step'], live: LiveLimits | null, seen: Record<string, number> | null): LimitsState => {
    const windows = windowsToDraw(seen, hits)
    return { step, live, tokens: tokenWindows(scans, now, windows), hits, windows }
  }
  if (WIN) return state('unsupported', null, null)
  const conn = connectDirFor(dir)
  const on = isStepOn((await readSettings(dir)).data.statusLine, conn)
  const live = on ? await readLive(conn) : null
  return state(on ? 'on' : 'off', live, on ? await seenWindows(conn, live) : null)
}

/** The open profile's limits. */
export const currentLimits = (): Promise<LimitsState> => limitsIn(configDir())

/** The statusLine command to show people: their own one while the step wraps it, else what settings.json says. */
export async function displayedStatusLine(statusLine: unknown): Promise<string | null> {
  if (!isObj(statusLine) || typeof statusLine.command !== 'string') return null
  if (!isStepOn(statusLine)) return statusLine.command
  return commandOf(await readConnectState())
}

type Listener = (dir: string) => void
const listeners = new Set<Listener>()

/** For main-process surfaces (the menu bar glance): a profile's limits changed. Returns the unsubscribe function. */
export function onLimitsChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const notifyTimers = new Map<string, NodeJS.Timeout>()
function notifySoon(dir: string): void {
  const k = folderKey(dir)
  clearTimeout(notifyTimers.get(k))
  notifyTimers.set(
    k,
    setTimeout(() => {
      notifyTimers.delete(k)
      // checked again after the read: a quick switch away and back sends only the folder still open
      if (samePath(dir, openConfigDir())) void limitsIn(dir).then((s) => samePath(dir, openConfigDir()) && emit('limits:changed', s), () => undefined)
      for (const l of listeners) l(dir)
    }, 250)
  )
}

/** A watcher on each profile's connect folder whose step is on, for the limits.json the status line step writes. */
const watchers = new Map<string, { dir: string; w: fs.FSWatcher | null }>()

function watch(dir: string, on: boolean): void {
  const k = folderKey(dir)
  const had = watchers.get(k)
  had?.w?.close()
  watchers.delete(k)
  if (!on) return
  const entry: { dir: string; w: fs.FSWatcher | null } = { dir, w: null }
  watchers.set(k, entry)
  try {
    entry.w = fs.watch(connectDirFor(dir), (_ev, name) => {
      if (name === null || name === LIVE) notifySoon(dir)
    })
    entry.w.on('error', () => {
      entry.w?.close()
      entry.w = null
    })
  } catch {
    /* folder missing: nothing to watch */
  }
}

/** Start watching a profile's folder if its step is on (making sure its script is there). */
async function follow(dir: string): Promise<void> {
  if (WIN) return
  const { data } = await readSettings(dir)
  const on = isStepOn(data.statusLine, connectDirFor(dir))
  if (on) await ensureScript(dir).catch(() => undefined)
  watch(dir, on)
}

/**
 * The profiles the menu bar reads (src/main/domains/profiles.ts). Folders no longer listed stop being watched and their scans
 * are dropped, except the open one's.
 */
export function watchLimitFolders(dirs: string[]): void {
  const keep = new Set([...dirs, openConfigDir()].map(folderKey))
  for (const [k, e] of watchers) {
    if (keep.has(k)) continue
    e.w?.close()
    watchers.delete(k)
  }
  for (const k of scanned.keys()) if (!keep.has(k)) scanned.delete(k)
  for (const d of dirs) if (!watchers.has(folderKey(d))) void follow(d).catch(() => undefined)
}

/* ------------------------------------------------------------------ after Connect or Disconnect */

/** statusLine must be missing or a command Claude Code runs; anything else is left alone. */
export function wrappable(statusLine: unknown): statusLine is undefined | { command: string } {
  if (statusLine === undefined) return true
  return isObj(statusLine) && (statusLine.type === undefined || statusLine.type === 'command') && typeof statusLine.command === 'string'
}

/** Watch for new limits while the open profile's step is on, and tell every surface the step changed. */
export function stepChanged(on: boolean): void {
  watch(configDir(), on)
  notifySoon(configDir())
}

export function register(ipcMain: IpcMain): void {
  const impl: LimitsApi = { get: currentLimits }
  defineDomain(ipcMain, 'limits', impl)
  // another profile opened: the window gets its limits
  onConfigDirChanged(() => {
    const dir = openConfigDir()
    if (!watchers.has(folderKey(dir))) void follow(dir).catch(() => undefined)
    notifySoon(dir)
  })
  void follow(configDir()).catch(() => undefined)
}
