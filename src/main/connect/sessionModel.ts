import type { AlertPrefs, LiveSession, SessionStatus, WaitKind } from '@shared/api/sessions'
import { waitText } from '../../shared/sessions.ts'

/**
 * Working out each session's state from the lines the hook script appends (src/main/connect/hookScript.ts), and the
 * "needs me" alert rule. Pure, so `npm test` loads it as is. Reading the files, the timers and the notifications live
 * in src/main/domains/sessions.ts.
 */

/** One line of `sessions/<id>.jsonl`. */
export interface SessionEvent {
  /** When the hook ran (ms since the epoch, whole seconds). */
  at: number
  e: 'prompt' | 'ask' | 'question' | 'tool' | 'notify' | 'stop'
  /** Tool name, as sent; "?" when it wasn't a plain name. */
  tool: string | null
  /** Subagent or teammate id; null for the main agent; "?" when it wasn't a plain name. */
  agent: string | null
  /** Notification type (notify only). */
  nt: string | null
  message: string | null
  cwd: string | null
  /** Claude Code's process id, 0 when unknown. */
  pid: number
  /** macOS bundle id of the terminal app. */
  app: string | null
}

const EVENTS: readonly SessionEvent['e'][] = ['prompt', 'ask', 'question', 'tool', 'notify', 'stop']
export const SESSION_FILE_RE = /^([A-Za-z0-9_-]{1,128})\.jsonl$/
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/
/** A tool or agent name the script passes through; anything else counts as "?", which matches nothing. */
const NAME_RE = /^[A-Za-z0-9_.:@-]{1,200}$/

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null)
const name = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : typeof v === 'string' && NAME_RE.test(v) ? v : '?')

/** One line, or null for anything the hook script would not have written. */
export function parseEvent(line: string): SessionEvent | null {
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  if (r.v !== 2 || typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at <= 0) return null
  if (!EVENTS.includes(r.e as SessionEvent['e'])) return null
  return {
    at: r.at * 1000,
    e: r.e as SessionEvent['e'],
    tool: name(r.tool),
    agent: name(r.agent),
    nt: str(r.nt, 100),
    message: str(r.message, 300),
    cwd: str(r.cwd, 4096),
    pid: typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : 0,
    app: typeof r.app === 'string' && APP_RE.test(r.app) ? r.app : null
  }
}

/** Something the session waits on, or a permission dialog that may become one. */
export interface Wait {
  kind: WaitKind
  /** The tool it is for (null: unknown, so any main-agent tool ends it). */
  tool: string | null
  agent: string | null
  message: string | null
  /** Claude Code said it needs you (a question or input request always; a permission dialog once notified). */
  notified: boolean
  /** Its line's place in the file: which came first, where whole-second times can tie. */
  seq: number
}

/** A session as its lines so far describe it. */
export interface SessionFold {
  id: string
  status: SessionStatus
  /** When it entered `status`. A session stays in one wait-time while one wait gives way to the next. */
  since: number
  /** The last line's time. */
  at: number
  /** Open dialogs and waits, oldest first. The session waits while any is notified; the first notified one shows. */
  waits: Wait[]
  /** The last permission dialog a finished tool answered before Claude Code's notification for it arrived. */
  answered: { at: number; dialogSeq: number } | null
  /** Lines applied so far. */
  seq: number
  cwd: string | null
  pid: number
  app: string | null
}

const WAIT_TYPES: Record<string, WaitKind> = { permission_prompt: 'permission', elicitation_dialog: 'input', elicitation_url_dialog: 'input' }
/** A tool line can land just before the notification for the dialog it answered (the two hooks race). */
const LATE_NOTIFY_MS = 3000

/** The wait to show: the oldest one Claude Code said needs you. */
export const shownWait = (f: SessionFold): Wait | null => f.waits.find((w) => w.notified) ?? null

/** Does a finished tool (tool, agent) end this wait? "?" names match nothing; a wait with no tool ends with any main-agent tool. */
const ends = (w: Wait, tool: string | null, agent: string | null): boolean =>
  w.tool === null ? agent === null : w.tool === tool && w.agent === agent && tool !== '?' && agent !== '?'

/**
 * Apply one line. The rules hold whatever order async hooks append in:
 * - prompt: working; stop: done. Both clear every dialog and wait.
 * - ask (PermissionRequest): notes a dialog for this tool and agent. Not a wait by itself: a quick approve or deny
 *   fires no hook, and Claude Code notifies only for a dialog still open after about 6 s.
 * - notify on a permission prompt: the newest noted dialog becomes a wait. Ignored when it belongs to a dialog a
 *   tool just answered (the tool's line beat it) or to a question already shown (AskUserQuestion asks permission too).
 *   With no dialog noted, a wait for an unknown tool. An MCP input request is an input wait.
 * - question (AskUserQuestion): a question wait; it takes over that agent's noted AskUserQuestion dialog, and a later
 *   one is not noted.
 * - tool: ends the first wait (or noted dialog) it answers. The session works again once no notified wait is left.
 * - tool and ask never move a session out of done: late async lines from the turn that stopped.
 */
export function applyEvent(s: SessionFold | null, id: string, ev: SessionEvent): SessionFold {
  const cur: SessionFold = s ?? { id, status: 'working', since: ev.at, at: ev.at, waits: [], answered: null, seq: 0, cwd: null, pid: 0, app: null }
  const seq = cur.seq + 1
  const base = { ...cur, seq, at: Math.max(cur.at, ev.at), cwd: ev.cwd ?? cur.cwd, pid: ev.pid || cur.pid, app: ev.app ?? cur.app }
  /** The state after the waits change: waiting while any is notified, `since` kept while the status holds. */
  const settle = (waits: Wait[], answered = cur.answered): SessionFold => {
    const status: SessionStatus = waits.some((w) => w.notified) ? 'waiting' : cur.status === 'waiting' ? 'working' : cur.status
    return { ...base, status, since: status === cur.status ? cur.since : ev.at, waits, answered }
  }
  const turn = (status: SessionStatus): SessionFold => ({ ...base, status, since: status === cur.status ? cur.since : ev.at, waits: [], answered: null })
  if (cur.status === 'done' && (ev.e === 'tool' || ev.e === 'ask')) return base
  switch (ev.e) {
    case 'prompt':
      return turn('working')
    case 'stop':
      return turn('done')
    case 'ask': {
      if (ev.tool === 'AskUserQuestion' && cur.waits.some((w) => w.kind === 'question' && w.agent === ev.agent)) return base
      return settle([...cur.waits, { kind: 'permission', tool: ev.tool, agent: ev.agent, message: null, notified: false, seq }])
    }
    case 'question': {
      const rest = cur.waits.filter((w) => !(w.kind === 'permission' && !w.notified && w.tool === 'AskUserQuestion' && w.agent === ev.agent))
      return settle([...rest, { kind: 'question', tool: 'AskUserQuestion', agent: ev.agent, message: null, notified: true, seq }])
    }
    case 'notify': {
      const kind = ev.nt ? WAIT_TYPES[ev.nt] : undefined
      if (!kind) return base
      if (kind === 'input') return settle([...cur.waits, { kind, tool: null, agent: null, message: ev.message, notified: true, seq }])
      const i = cur.waits.map((w) => !w.notified && w.kind === 'permission').lastIndexOf(true)
      const a = cur.answered
      // the notification of the dialog a tool just answered: the newest dialog left, if any, is older than that one
      if (a && ev.at - a.at <= LATE_NOTIFY_MS && (i < 0 || cur.waits[i].seq < a.dialogSeq)) return base
      if (i >= 0 && !(a && cur.waits[i].seq < a.dialogSeq)) return settle(cur.waits.map((w, j) => (j === i ? { ...w, notified: true, message: ev.message } : w)))
      // no dialog noted: a question already shown is what Claude Code means
      if (cur.waits.some((w) => w.kind === 'question')) return base
      return settle([...cur.waits, { kind, tool: null, agent: null, message: ev.message, notified: true, seq }])
    }
    case 'tool': {
      // a notified wait first, else a dialog still being decided
      const i = cur.waits.findIndex((w) => w.notified && ends(w, ev.tool, ev.agent))
      const j = i >= 0 ? i : cur.waits.findIndex((w) => !w.notified && w.tool !== null && ends(w, ev.tool, ev.agent))
      if (j < 0) return base
      const answered = cur.waits[j].notified ? cur.answered : { at: ev.at, dialogSeq: cur.waits[j].seq }
      return settle(
        cur.waits.filter((_, k) => k !== j),
        answered
      )
    }
  }
}

/** Fold complete lines (bad ones skipped) onto a session. */
export function applyLines(s: SessionFold | null, id: string, lines: readonly string[]): SessionFold | null {
  let out = s
  for (const line of lines) {
    const ev = line.trim() ? parseEvent(line) : null
    if (ev) out = applyEvent(out, id, ev)
  }
  return out
}

/** A session with no hook event for this long, whose process can't be checked, is dropped. */
export const STALE_MS = 12 * 3_600_000

/** The session's process has exited, or (when its process is unknown) it has been quiet for `STALE_MS`. */
export function isGone(s: SessionFold, now: number, alive: (pid: number) => boolean): boolean {
  return s.pid > 0 ? !alive(s.pid) : now - s.at > STALE_MS
}

/** Last folder name of the session's folder, else the start of its id. */
export function sessionName(cwd: string | null, id: string): string {
  const last = cwd
    ?.split(/[\\/]+/)
    .filter(Boolean)
    .pop()
  return last || id.slice(0, 8)
}

/** Sessions to show, in order: waiting (longest first), working, done (latest first). */
export function toLiveSessions(folds: readonly SessionFold[]): LiveSession[] {
  const rank: Record<SessionStatus, number> = { waiting: 0, working: 1, done: 2 }
  return folds
    .map(
      (f): LiveSession => ({
        id: f.id,
        status: f.status,
        since: f.since,
        cwd: f.cwd,
        name: sessionName(f.cwd, f.id),
        kind: f.status === 'waiting' ? (shownWait(f)?.kind ?? null) : null,
        tool: f.status === 'waiting' && shownWait(f)?.tool !== '?' ? (shownWait(f)?.tool ?? null) : null,
        message: f.status === 'waiting' ? (shownWait(f)?.message ?? null) : null
      })
    )
    .sort((a, b) => rank[a.status] - rank[b.status] || (a.status === 'waiting' ? a.since - b.since : b.since - a.since) || a.id.localeCompare(b.id))
}

export interface Transitions {
  /** Sessions that started waiting since the previous list. */
  waiting: LiveSession[]
  /** Sessions that went from working to done. */
  done: LiveSession[]
}

/**
 * What changed between two lists. `prev` null means this is the first read (at launch): nothing has "started"
 * waiting then, so nothing alerts.
 */
export function transitions(prev: ReadonlyMap<string, LiveSession> | null, next: readonly LiveSession[]): Transitions {
  const out: Transitions = { waiting: [], done: [] }
  if (!prev) return out
  for (const s of next) {
    const p = prev.get(s.id)
    if (s.status === 'waiting' && p?.status !== 'waiting') out.waiting.push(s)
    else if (s.status === 'done' && p?.status === 'working') out.done.push(s)
  }
  return out
}

/** "a", "a and b", "a, b and c". */
const list = (names: string[]): string => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** Title and body of one alert for one or more sessions. */
export function alertText(sessions: readonly LiveSession[], what: 'waiting' | 'reminder' | 'done'): { title: string; body: string } {
  const one = sessions.length === 1
  const names = sessions.map((s) => s.name)
  if (what === 'done') return one ? { title: `${names[0]} is done`, body: 'Claude finished' } : { title: `${sessions.length} sessions are done`, body: list(names) }
  const title = one ? `${names[0]} ${what === 'reminder' ? 'is still waiting' : 'is waiting'} for you` : `${sessions.length} sessions are ${what === 'reminder' ? 'still ' : ''}waiting for you`
  return { title, body: one ? waitText(sessions[0]) : list(names) }
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = { pausedUntil: null, reminderMinutes: null, doneAlert: false, sound: false, limitPercent: null, limitReset: false }

/** Alert prefs from untrusted input (prefs.json or the renderer), keeping `base` for anything missing or invalid. */
export function normalizeAlertPrefs(raw: unknown, base: AlertPrefs = DEFAULT_ALERT_PREFS): AlertPrefs {
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const out = { ...base }
  if (r.pausedUntil === null || (typeof r.pausedUntil === 'number' && Number.isFinite(r.pausedUntil) && r.pausedUntil > 0)) out.pausedUntil = r.pausedUntil as number | null
  if (r.reminderMinutes === null || (typeof r.reminderMinutes === 'number' && Number.isInteger(r.reminderMinutes) && r.reminderMinutes >= 1 && r.reminderMinutes <= 24 * 60)) {
    out.reminderMinutes = r.reminderMinutes as number | null
  }
  if (typeof r.doneAlert === 'boolean') out.doneAlert = r.doneAlert
  if (typeof r.sound === 'boolean') out.sound = r.sound
  if (r.limitPercent === null || (typeof r.limitPercent === 'number' && Number.isInteger(r.limitPercent) && r.limitPercent >= 1 && r.limitPercent <= 100)) {
    out.limitPercent = r.limitPercent as number | null
  }
  if (typeof r.limitReset === 'boolean') out.limitReset = r.limitReset
  return out
}

export const isPaused = (p: AlertPrefs, now: number): boolean => p.pausedUntil !== null && p.pausedUntil > now

/* ------------------------------------------------------------------ the alert rule, with its timers */

/** Changes within this window go into one alert. */
export const GROUP_MS = 1500
/**
 * A question or an MCP input request alerts only if it is still unanswered after this. A permission wait needs none:
 * it starts with Claude Code's own notification, which already waits about this long.
 */
export const GRACE_MS = 6000

/** Timers and time, injected so tests can drive them. */
export interface AlertClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

export type AlertPost = (text: { title: string; body: string }, sessionId: string) => void

/**
 * The "needs me" alert rule. Feed it every new list with `update()`:
 *   - a session that starts waiting alerts once (a question or input request only if still unanswered after GRACE_MS);
 *     several within GROUP_MS go into one alert;
 *   - nothing while paused;
 *   - with `reminderMinutes` set, one reminder per wait if it still waits, then silence;
 *   - with `doneAlert` on, one alert when a working session finishes, grouped the same way.
 * A wait counts as the same wait while its `since` is unchanged; leaving waiting cancels its alert and reminder.
 */
export class AlertRule {
  private current = new Map<string, LiveSession>()
  private readonly pending = { waiting: new Map<string, number>(), done: new Map<string, number>() }
  private readonly flushes: { waiting: unknown; done: unknown } = { waiting: null, done: null }
  private readonly reminders = new Map<string, unknown>()

  private readonly clock: AlertClock
  private readonly prefs: () => AlertPrefs
  private readonly post: AlertPost

  // plain fields, not parameter properties: Node's type stripping (npm test) can't run those
  constructor(clock: AlertClock, prefs: () => AlertPrefs, post: AlertPost) {
    this.clock = clock
    this.prefs = prefs
    this.post = post
  }

  update(next: readonly LiveSession[], changes: Transitions): void {
    this.current = new Map(next.map((s) => [s.id, s]))
    for (const s of changes.waiting) this.startedWaiting(s)
    if (this.prefs().doneAlert) for (const s of changes.done) this.queue('done', s)
    for (const [id, t] of this.reminders) {
      if (this.current.get(id)?.status !== 'waiting') {
        this.clock.clearTimeout(t)
        this.reminders.delete(id)
      }
    }
  }

  /** The same session in the same status since the same moment, or null. */
  private same(id: string, since: number, status: LiveSession['status']): LiveSession | null {
    const s = this.current.get(id)
    return s && s.status === status && s.since === since ? s : null
  }

  private startedWaiting(s: LiveSession): void {
    if (s.kind !== 'permission') this.clock.setTimeout(() => (this.same(s.id, s.since, 'waiting') ? this.queue('waiting', s) : undefined), GRACE_MS)
    else this.queue('waiting', s)
    const minutes = this.prefs().reminderMinutes
    if (minutes === null) return
    this.clock.clearTimeout(this.reminders.get(s.id))
    this.reminders.set(
      s.id,
      this.clock.setTimeout(() => {
        this.reminders.delete(s.id)
        const now = this.same(s.id, s.since, 'waiting')
        if (now && !isPaused(this.prefs(), this.clock.now())) this.post(alertText([now], 'reminder'), now.id)
      }, minutes * 60_000)
    )
  }

  private queue(what: 'waiting' | 'done', s: LiveSession): void {
    this.pending[what].set(s.id, s.since)
    this.flushes[what] ??= this.clock.setTimeout(() => this.flush(what), GROUP_MS)
  }

  private flush(what: 'waiting' | 'done'): void {
    this.flushes[what] = null
    const due = [...this.pending[what]]
    this.pending[what].clear()
    const list = due.map(([id, since]) => this.same(id, since, what)).filter((s): s is LiveSession => s !== null)
    if (list.length === 0 || isPaused(this.prefs(), this.clock.now())) return
    this.post(alertText(list, what), list[0].id)
  }
}
