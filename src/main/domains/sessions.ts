import { type IpcMain } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AlertPrefs, HooksStatus, LiveSession, SessionsApi, SessionsState } from '@shared/api/sessions'
import { connectDir, connectDirFor, connectSerial, folderKey, removeOwn, writeOwn } from '../connect/folder'
import { HOOKS, hookCommand, hookEntry, hookScript } from '../connect/hookScript'
import { AlertRule, SESSION_FILE_RE, applyLines, isGone, normalizeAlertPrefs, sortLive, toLiveSessions, transitions, type SessionFold } from '../connect/sessionModel'
import { hasHooks, type HookGroup } from '../connect/settingsHooks'
import { postAlert } from '../alerts'
import { defineDomain, emit } from '../ipcx'
import { showMainWindow } from '../windows'
import { loadPrefs, savePrefs } from '../prefs'
import { configDir, onConfigDirChanged, openConfigDir, samePath } from '../paths'
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
let registered = false

/* ------------------------------------------------------------------ the hooks in settings.json */

const sessionsDirOf = (conn: string): string => path.join(conn, 'sessions')

/** Claudock's hook commands, exactly as they appear in settings.json. */
export const ourHookCommands = (conn = connectDir()): Set<string> => new Set(HOOKS.map((h) => hookCommand(conn, h.step)))

/** The groups Connect appends to settings.json, one per hook. */
export const hookGroups = (): HookGroup[] => HOOKS.map((h) => ({ event: h.event, matcher: h.matcher, entry: hookEntry(connectDir(), h) }))

export const hooksInstalled = (settings: Record<string, unknown>, conn = connectDir()): boolean => hasHooks(settings, ourHookCommands(conn))

/** The hook script and an empty sessions folder. Must exist before settings.json points at the script. */
export async function writeHookFiles(conn = connectDir()): Promise<void> {
  await writeOwn('hook.sh', hookScript(conn), 0o755, conn)
  await fsp.mkdir(sessionsDirOf(conn), { recursive: true })
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

/**
 * One profile's sessions: its settings.json says whether the hooks are in, and its connect folder holds what they wrote.
 * Every profile is watched at once, so the menu bar and the alerts cover them all; the window shows the open one's.
 */
class Watch {
  readonly dir: string
  readonly conn: string
  /** The profile's name, while there are several (rows and alerts say which profile). */
  label: string | null = null
  hooks: HooksStatus = WIN ? 'unsupported' : 'off'
  sessions: LiveSession[] = []
  /** The previous list by id; null until the first read, so sessions already waiting at launch don't alert. */
  private prev: Map<string, LiveSession> | null = null
  /** Terminal app per session, for `show()`. */
  apps = new Map<string, string | null>()
  private published = ''
  private readonly reads = new Map<string, FileRead>()
  /** First prompts by session id: they never change, so each transcript's head is read once. */
  private readonly firstPrompts = new Map<string, string>()
  private watcher: fs.FSWatcher | null = null
  private watching = false
  private soon: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private rerun = false
  private closed = false

  constructor(dir: string) {
    this.dir = dir
    this.conn = connectDirFor(dir)
  }

  snapshot(): SessionsState {
    return { hooks: this.hooks, sessions: this.sessions, waiting: this.sessions.filter((s) => s.status === 'waiting').length }
  }

  /** Re-read settings.json and the sessions folder. Calls made while a read runs share one more read after it. */
  refresh(): Promise<void> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.rerun = false
        await this.readOnce()
      } while (this.rerun)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  refreshSoon(): void {
    if (this.soon) clearTimeout(this.soon)
    this.soon = setTimeout(() => {
      this.soon = null
      void this.refresh().catch(() => undefined)
    }, 150)
  }

  close(): void {
    this.closed = true
    if (this.soon) clearTimeout(this.soon)
    this.watcher?.close()
    this.watcher = null
  }

  private async readOnce(): Promise<void> {
    if (WIN || this.closed) return
    const settings = await readSettings(this.dir)
    // settings.json mid-write or unreadable: keep what is known rather than drop every session (and alert again after)
    if (settings.error) return
    const on = hooksInstalled(settings.data, this.conn)
    this.hooks = on ? 'on' : 'off'
    if (on !== this.watching) await this.watch(on)
    const folds = on ? await this.readFolds() : []
    if (!on) this.reads.clear()
    const next = await this.withNames(toLiveSessions(folds))
    if (this.closed) return
    const changes = transitions(this.prev, next)
    this.prev = new Map(next.map((s) => [s.id, s]))
    this.apps = new Map(folds.map((f) => [f.id, f.app]))
    this.sessions = next
    const label = (s: LiveSession): LiveSession => (this.label ? { ...s, profile: this.label } : s)
    rule.update(everySession(), { waiting: changes.waiting.map(label), done: changes.done.map(label) })
    const json = JSON.stringify(this.snapshot())
    if (json === this.published) return
    this.published = json
    changed(this)
  }

  /** Each session's state from its file; files of sessions that are gone are deleted (Claudock's own data). */
  private async readFolds(): Promise<SessionFold[]> {
    const dir = sessionsDirOf(this.conn)
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
      let r = this.reads.get(id)
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
      this.reads.set(id, r)
      if (r.fold && isGone(r.fold, now, alive)) {
        await fsp.rm(abs, { force: true })
        this.reads.delete(id)
        continue
      }
      if (r.fold) out.push(r.fold)
    }
    for (const id of this.reads.keys()) if (!seen.has(id)) this.reads.delete(id)
    // a hook killed by its timeout between writing its line and appending it leaves the line file behind
    for (const n of names) {
      if (!/^\..+\.line$/.test(n)) continue
      const st = await fsp.lstat(path.join(dir, n)).catch(() => null)
      if (st?.isFile() && now - st.mtimeMs > 60_000) await fsp.rm(path.join(dir, n), { force: true })
    }
    return out
  }

  /**
   * Each session's own name from its transcript (cached there), else its first prompt, so rows say which session, not
   * only which folder.
   */
  private async withNames(list: LiveSession[]): Promise<LiveSession[]> {
    const ids = new Set(list.map((s) => s.id))
    for (const id of this.firstPrompts.keys()) if (!ids.has(id)) this.firstPrompts.delete(id)
    const root = path.join(this.dir, 'projects')
    return Promise.all(
      list.map(async (s) => {
        const abs = await findTranscript(s.id, s.cwd, root).catch(() => null)
        if (!abs) return s
        const own = await ownSessionName(abs)
        if (own) return { ...s, title: own }
        let first = this.firstPrompts.get(s.id)
        if (first === undefined) {
          first = await sessionTitle(abs)
          if (first) this.firstPrompts.set(s.id, first)
        }
        return { ...s, title: first || null }
      })
    )
  }

  /**
   * Watch the sessions folder while the hooks are in settings.json. Turning on also makes sure hook.sh is the current
   * script: Claudock's folder may have been cleared, or Disconnect left its no-op and the hooks came back (a snapshot
   * restored in Backups).
   */
  private async watch(on: boolean): Promise<void> {
    this.watching = on
    this.watcher?.close()
    this.watcher = null
    if (!on) return
    // checked again under the connect lock, so a Disconnect that just ran keeps its no-op
    await connectSerial(async () => {
      const text = await fsp.readFile(path.join(this.conn, 'hook.sh'), 'utf8').catch(() => null)
      if (text === hookScript(this.conn)) return
      const { data, error } = await readSettings(this.dir)
      if (!error && hooksInstalled(data, this.conn)) await writeHookFiles(this.conn)
    }).catch(() => undefined)
    if (this.closed) return
    try {
      fs.mkdirSync(sessionsDirOf(this.conn), { recursive: true })
      const w = fs.watch(sessionsDirOf(this.conn), () => this.refreshSoon())
      // the tick keeps reading if the watcher fails
      w.on('error', () => {
        w.close()
        if (this.watcher === w) this.watcher = null
      })
      this.watcher = w
    } catch {
      /* folder can't be made: the tick still reads it */
    }
  }
}

/** Every watched profile by folder key. The open profile always has one. */
const watches = new Map<string, Watch>()

function watchFor(dir: string): Watch {
  const key = folderKey(dir)
  let w = watches.get(key)
  if (!w) {
    w = new Watch(dir)
    watches.set(key, w)
    if (registered) w.refreshSoon()
  }
  return w
}

const open = (): Watch => watchFor(openConfigDir())

/** Every profile's sessions in one list, each naming its profile while there are several: the alert rule and the popover. */
export function everySession(): LiveSession[] {
  return sortLive([...watches.values()].flatMap((w) => (w.label ? w.sessions.map((s) => ({ ...s, profile: w.label as string })) : w.sessions)))
}

/**
 * The profiles to watch, with their names (src/main/domains/profiles.ts). Names go on rows and alerts only when there are
 * several. Folders no longer listed stop being watched, except the open one.
 */
export function watchFolders(list: { dir: string; name: string }[]): void {
  const keep = new Set(list.map((p) => folderKey(p.dir)))
  keep.add(folderKey(openConfigDir()))
  for (const [k, w] of watches) {
    if (keep.has(k)) continue
    w.close()
    watches.delete(k)
  }
  for (const p of list) {
    const w = watchFor(p.dir)
    const label = list.length > 1 ? p.name : null
    if (w.label !== label) {
      w.label = label
      changed(w)
    }
  }
}

/** Everything Today and the menu bar show, for the open profile (the calling window's). */
export async function currentSessions(): Promise<SessionsState> {
  const w = watchFor(configDir())
  await w.refresh()
  return w.snapshot()
}

/** One profile's sessions (the menu bar reads every profile). */
export async function sessionsIn(dir: string): Promise<SessionsState> {
  const w = watchFor(dir)
  await w.refresh()
  return w.snapshot()
}

type Listener = (dir: string) => void
const listeners = new Set<Listener>()

/** For main-process surfaces (the menu bar glance): a profile's sessions changed. Returns the unsubscribe function. */
export function onSessionsChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function changed(w: Watch): void {
  if (samePath(w.dir, openConfigDir())) emit('sessions:changed', w.snapshot())
  for (const l of listeners) l(w.dir)
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
  let bundle: string | null | undefined
  for (const w of watches.values()) if (w.apps.has(id)) bundle = w.apps.get(id)
  if (!MAC || !bundle || !/^[A-Za-z0-9.-]+$/.test(bundle)) return showMainWindow()
  await new Promise<void>((resolve) => {
    execFile('/usr/bin/open', ['-b', bundle], (err) => {
      if (err) showMainWindow()
      resolve()
    })
  })
}

/* ------------------------------------------------------------------ after Connect or Disconnect */

/** After Connect or Disconnect (on the open profile): re-read (which starts or stops watching) and tell every surface. */
export function hooksChanged(): void {
  watchFor(configDir()).refreshSoon()
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
  registered = true
  // another profile opened: the window gets its sessions (they were already being watched)
  onConfigDirChanged(() => {
    const w = open()
    // a quick switch away and back: only the folder still open is sent
    void w.refresh().then(() => samePath(w.dir, openConfigDir()) && emit('sessions:changed', w.snapshot()), () => undefined)
  })
  if (WIN) return
  open().refreshSoon()
  // always, connected or not: sessions whose Claude Code process exited, the clock on "4 min", and hooks that appear
  // in settings.json some other way (a read that failed at launch, a snapshot restored in Backups)
  setInterval(() => {
    for (const w of watches.values()) w.refreshSoon()
  }, TICK_MS)
}
