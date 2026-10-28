import { type IpcMain } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AlertPrefs, HooksStatus, LiveSession, SessionsApi, SessionsState } from '@shared/api/sessions'
import { connectDir, connectSerial, removeOwn, writeOwn } from '../connect/folder'
import { HOOKS, hookCommand, hookEntry, hookScript } from '../connect/hookScript'
import { AlertRule, SESSION_FILE_RE, applyLines, isGone, normalizeAlertPrefs, toLiveSessions, transitions, type SessionFold } from '../connect/sessionModel'
import { hasHooks, type HookGroup } from '../connect/settingsHooks'
import { postAlert } from '../alerts'
import { defineDomain, emit } from '../ipcx'
import { showMainWindow } from '../windows'
import { loadPrefs, savePrefs } from '../prefs'
import { readSettings } from './extendShared'
import { findTranscript, ownSessionName, sessionTitle } from './projects'

/**
 * Sessions: which running Claude Code sessions are working, waiting for you or done, from the session hooks "Connect to
 * Claude Code" adds (src/main/domains/connect.ts installs them; src/main/connect/hookScript.ts is the script). Each
 * hook appends a line to `<connect dir>/sessions/<session id>.jsonl`; this file reads what was added (only that),
 * works out each session's state from the lines (`applyEvent` in src/main/connect/sessionModel.ts), watches the folder, drops sessions whose
 * Claude Code process has exited, and posts the "needs me" alert (the rule is `AlertRule` in
 * src/main/connect/sessionModel.ts; sessions already waiting at launch don't alert). Native notifications follow
 * Focus / Do Not Disturb by themselves. Sound, a reminder and a done alert are off unless prefs.json `alerts` says so.
 */

const WIN = process.platform === 'win32'
const MAC = process.platform === 'darwin'
const TICK_MS = 30_000

/* ------------------------------------------------------------------ the hooks in settings.json */

const sessionsDir = (): string => path.join(connectDir(), 'sessions')

/** Claudock's hook commands, exactly as they appear in settings.json. */
export const ourHookCommands = (): Set<string> => new Set(HOOKS.map((h) => hookCommand(connectDir(), h.step)))

/** The groups Connect appends to settings.json, one per hook. */
export const hookGroups = (): HookGroup[] => HOOKS.map((h) => ({ event: h.event, matcher: h.matcher, entry: hookEntry(connectDir(), h) }))

export const hooksInstalled = (settings: Record<string, unknown>): boolean => hasHooks(settings, ourHookCommands())

/** The hook script and an empty sessions folder. Must exist before settings.json points at the script. */
export async function writeHookFiles(): Promise<void> {
  await writeOwn('hook.sh', hookScript(connectDir()), 0o755)
  await fsp.mkdir(sessionsDir(), { recursive: true })
}

/** The hook script and every session file, when settings.json never pointed at them (a Connect that failed). */
export async function removeHookFiles(): Promise<void> {
  await Promise.all([removeOwn('hook.sh'), removeOwn('sessions')])
}

/**
 * After Disconnect: the session files go, and hook.sh becomes a script that does nothing, so a session that runs the
 * old hooks until Claude Code reloads settings.json stays quiet instead of showing a hook error.
 */
export async function retireHookFiles(): Promise<void> {
  await removeOwn('sessions')
  await writeOwn('hook.sh', '#!/bin/sh\n# Claudock is disconnected from Claude Code: this does nothing.\nexit 0\n', 0o755)
}

/* ------------------------------------------------------------------ reading sessions */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** What has been read of one session's file: lines are only ever appended, so each read starts where the last ended. */
interface FileRead {
  ino: number
  offset: number
  /** Bytes after the last newline: a line still being written. */
  rest: Buffer
  fold: SessionFold | null
}
const reads = new Map<string, FileRead>()

/** Each session's state from its file; files of sessions that are gone are deleted (Claudock's own data). */
async function readFolds(): Promise<SessionFold[]> {
  const dir = sessionsDir()
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  const now = Date.now()
  const out: SessionFold[] = []
  const seen = new Set<string>()
  for (const n of names) {
    const id = SESSION_FILE_RE.exec(n)?.[1]
    if (!id) continue
    const abs = path.join(dir, n)
    const st = await fsp.lstat(abs).catch(() => null)
    if (!st?.isFile()) continue
    seen.add(id)
    let r = reads.get(id)
    // a new file under the same name (SessionEnd, then a late line) or a shorter one: read it from the start
    if (!r || r.ino !== st.ino || st.size < r.offset) r = { ino: st.ino, offset: 0, rest: Buffer.alloc(0), fold: null }
    if (st.size > r.offset) {
      const chunk = await readRange(abs, r.offset, st.size).catch(() => null)
      if (chunk) {
        const buf = Buffer.concat([r.rest, chunk])
        const end = buf.lastIndexOf(0x0a) + 1
        r.fold = applyLines(r.fold, id, buf.toString('utf8', 0, end).split('\n'))
        r.rest = Buffer.from(buf.subarray(end))
        r.offset += chunk.length
      }
    }
    reads.set(id, r)
    if (r.fold && isGone(r.fold, now, alive)) {
      await fsp.rm(abs, { force: true })
      reads.delete(id)
      continue
    }
    if (r.fold) out.push(r.fold)
  }
  for (const id of reads.keys()) if (!seen.has(id)) reads.delete(id)
  // a hook killed by its timeout between writing its line and appending it leaves the line file behind
  for (const n of names) {
    if (!/^\..+\.line$/.test(n)) continue
    const st = await fsp.lstat(path.join(dir, n)).catch(() => null)
    if (st?.isFile() && now - st.mtimeMs > 60_000) await fsp.rm(path.join(dir, n), { force: true })
  }
  return out
}

async function readRange(abs: string, from: number, to: number): Promise<Buffer> {
  const fh = await fsp.open(abs, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

let hooks: HooksStatus = WIN ? 'unsupported' : 'off'
let sessions: LiveSession[] = []
/** The previous list by id; null until the first read, so sessions already waiting at launch don't alert. */
let prev: Map<string, LiveSession> | null = null
/** Terminal app per session, for `show()`. */
let apps = new Map<string, string | null>()
let published = ''

const snapshot = (): SessionsState => ({ hooks, sessions, waiting: sessions.filter((s) => s.status === 'waiting').length })

/** Everything Today and the menu bar show. */
export async function currentSessions(): Promise<SessionsState> {
  await refresh()
  return snapshot()
}

type Listener = (s: SessionsState) => void
const listeners = new Set<Listener>()

/** For main-process surfaces (the menu bar glance). Returns the unsubscribe function. */
export function onSessionsChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let running: Promise<void> | null = null
let rerun = false

/** Re-read settings.json and the sessions folder. Calls made while a read runs share one more read after it. */
function refresh(): Promise<void> {
  if (running) {
    rerun = true
    return running
  }
  running = (async () => {
    do {
      rerun = false
      await readOnce()
    } while (rerun)
  })().finally(() => {
    running = null
  })
  return running
}

async function readOnce(): Promise<void> {
  if (WIN) return
  const settings = await readSettings()
  // settings.json mid-write or unreadable: keep what is known rather than drop every session (and alert again after)
  if (settings.error) return
  const on = hooksInstalled(settings.data)
  hooks = on ? 'on' : 'off'
  if (on !== watching) await watch(on)
  const folds = on ? await readFolds() : []
  if (!on) reads.clear()
  const next = await withNames(toLiveSessions(folds))
  const changes = transitions(prev, next)
  prev = new Map(next.map((s) => [s.id, s]))
  apps = new Map(folds.map((f) => [f.id, f.app]))
  sessions = next
  rule.update(next, changes)
  const json = JSON.stringify(snapshot())
  if (json === published) return
  published = json
  const state = snapshot()
  emit('sessions:changed', state)
  for (const l of listeners) l(state)
}

/** First prompts by session id: they never change, so each transcript's head is read once. */
const firstPrompts = new Map<string, string>()

/**
 * Each session's own name from its transcript (cached there), else its first prompt, so rows say which session, not
 * only which folder.
 */
async function withNames(list: LiveSession[]): Promise<LiveSession[]> {
  const ids = new Set(list.map((s) => s.id))
  for (const id of firstPrompts.keys()) if (!ids.has(id)) firstPrompts.delete(id)
  return Promise.all(
    list.map(async (s) => {
      const abs = await findTranscript(s.id, s.cwd).catch(() => null)
      if (!abs) return s
      const own = await ownSessionName(abs)
      if (own) return { ...s, title: own }
      let first = firstPrompts.get(s.id)
      if (first === undefined) {
        first = await sessionTitle(abs)
        if (first) firstPrompts.set(s.id, first)
      }
      return { ...s, title: first || null }
    })
  )
}

/* ------------------------------------------------------------------ alerts */

let prefs: AlertPrefs = normalizeAlertPrefs(undefined)
/** Stored prefs, loaded once; changes wait for it so they never save over values not read yet. */
let prefsReady: Promise<void> | null = null
const ready = (): Promise<void> => (prefsReady ??= loadPrefs().then((p) => void (prefs = p.alerts), () => undefined))

function post(text: { title: string; body: string }, id: string): void {
  postAlert(text, { sound: prefs.sound, onClick: () => void show(id) })
}

const rule = new AlertRule({ now: Date.now, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as NodeJS.Timeout) }, () => prefs, post)

/* ------------------------------------------------------------------ show */

/** Bring the session's terminal app forward (macOS, when the hook knew it), else Claudock's own window. */
export async function show(id: string): Promise<void> {
  if (typeof id !== 'string') throw new Error('Unknown session')
  const bundle = apps.get(id)
  if (!MAC || !bundle || !/^[A-Za-z0-9.-]+$/.test(bundle)) return showMainWindow()
  await new Promise<void>((resolve) => {
    execFile('/usr/bin/open', ['-b', bundle], (err) => {
      if (err) showMainWindow()
      resolve()
    })
  })
}

/* ------------------------------------------------------------------ watching */

let watcher: fs.FSWatcher | null = null
let watching = false
let soon: NodeJS.Timeout | null = null

function refreshSoon(): void {
  if (soon) clearTimeout(soon)
  soon = setTimeout(() => {
    soon = null
    void refresh().catch(() => undefined)
  }, 150)
}

/**
 * Watch the sessions folder while the hooks are in settings.json. Turning on also makes sure hook.sh is the current
 * script: Claudock's folder may have been cleared, or Disconnect left its no-op and the hooks came back (a snapshot
 * restored in Backups).
 */
async function watch(on: boolean): Promise<void> {
  watching = on
  watcher?.close()
  watcher = null
  if (!on) return
  // checked again under the connect lock, so a Disconnect that just ran keeps its no-op
  await connectSerial(async () => {
    const text = await fsp.readFile(path.join(connectDir(), 'hook.sh'), 'utf8').catch(() => null)
    if (text === hookScript(connectDir())) return
    const { data, error } = await readSettings()
    if (!error && hooksInstalled(data)) await writeHookFiles()
  }).catch(() => undefined)
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true })
    const w = fs.watch(sessionsDir(), () => refreshSoon())
    // the tick keeps reading if the watcher fails
    w.on('error', () => {
      w.close()
      if (watcher === w) watcher = null
    })
    watcher = w
  } catch {
    /* folder can't be made: the tick still reads it */
  }
}

/** After Connect or Disconnect: re-read (which starts or stops watching) and tell every surface. */
export function hooksChanged(): void {
  refreshSoon()
}

/** The alert settings as last loaded or set, for the limit alert rule's tick (src/main/menubar.ts). */
export const currentAlertPrefs = (): AlertPrefs => prefs

/** The alert settings (the menu bar popover's settings view and "Pause 1 h"). */
export async function alertPrefs(): Promise<AlertPrefs> {
  await ready()
  return prefs
}

/** Change some alert settings; returns all of them. Invalid values keep the current ones. */
export async function setAlertPrefs(patch: Partial<AlertPrefs>): Promise<AlertPrefs> {
  await ready()
  prefs = normalizeAlertPrefs(patch, prefs)
  await savePrefs({ alerts: prefs })
  return prefs
}

export function register(ipcMain: IpcMain): void {
  const impl: SessionsApi = { get: currentSessions, show, alertPrefs, setAlertPrefs }
  defineDomain(ipcMain, 'sessions', impl)
  void ready()
  if (WIN) return
  void refresh().catch(() => undefined)
  // always, connected or not: sessions whose Claude Code process exited, the clock on "4 min", and hooks that appear
  // in settings.json some other way (a read that failed at launch, a snapshot restored in Backups)
  setInterval(refreshSoon, TICK_MS)
}
