import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ShareSettings, WeekStats } from '@shared/api/overview'
import { isPlanChoice, type PlanChoice } from '@shared/prices'
import { formatCount } from '@shared/format'
import { formatRange, weekValue } from '@shared/wrapped'
import { postAlert } from '../alerts'
import { folderKey, writeOwn } from '../connect/folder'
import { isPaused } from '../connect/sessionModel'
import { installKind, openConfigDir, samePath, userDataDir } from '../paths'
import { emptyScans, scanSince, type Scans } from '../share/scan'
import { isMonday, midnightOf, mondayOf, recapDue, sumWeek } from '../share/week'
import { mainWindow, showMainWindow } from '../windows'
import { archiveRootOf } from './archive'
import { currentAlertPrefs } from './sessions'

/**
 * The week card and the Monday recap, per profile folder. Numbers come from the folder's transcripts and the session
 * archive's copies (src/main/share/scan.ts, summed by src/main/share/week.ts at the prices in src/shared/prices.ts).
 * What the user picked (the plan beside the value, the recap switch) and the last week recapped are Claudock's own
 * data: `<userData>/share/<folder key>.json` (`share.dev` in a git clone), written directly like prefs.json.
 */

/* ------------------------------------------------------------------ scans */

interface Entry {
  s: Scans
  at: number
  /** Last asked for: another folder's scan not asked for in IDLE_MS is let go. */
  used: number
  running: Promise<void> | null
}
const scans = new Map<string, Entry>()
const IDLE_MS = 10 * 60_000

/** One scan at a time per folder; a finished one is reused for 5 s when it already reaches back to `from`. */
async function scanned(dir: string, from: number): Promise<Scans> {
  const k = folderKey(dir)
  for (const [other, x] of scans) if (other !== k && !x.running && Date.now() - x.used > IDLE_MS) scans.delete(other)
  let e = scans.get(k)
  if (!e) scans.set(k, (e = { s: emptyScans(), at: 0, used: 0, running: null }))
  e.used = Date.now()
  while (e.running) await e.running
  if (Date.now() - e.at > 5000 || e.s.from > from) {
    const entry = e
    entry.running = scanSince(entry.s, [dir, archiveRootOf(dir)], from).finally(() => {
      entry.at = Date.now()
      entry.running = null
    })
    await entry.running
  }
  return e.s
}

/** The Monday `start` week of `dir` (null: the one holding `now`). */
export async function weekIn(dir: string, start: string | null, now = Date.now()): Promise<WeekStats> {
  const current = mondayOf(now)
  const week = start ?? current
  if (!isMonday(week) || week > current) throw new Error('There is no such week to show')
  const s = await scanned(dir, midnightOf(week))
  const oldest = s.oldest === null ? current : mondayOf(s.oldest)
  return sumWeek([...s.files.values()], week, now, oldest < current ? oldest : current)
}

/** The week last sent to the window, per folder: Post on X writes the numbers the card was drawn from. */
const shown = new Map<string, WeekStats>()

export async function weekForCard(dir: string, start: string | null): Promise<WeekStats> {
  const w = await weekIn(dir, start)
  shown.set(folderKey(dir), w)
  return w
}

export async function weekShown(dir: string, start: string): Promise<WeekStats> {
  const w = shown.get(folderKey(dir))
  return w?.start === start ? w : weekIn(dir, start)
}

/* ------------------------------------------------------------------ settings */

interface Stored extends ShareSettings {
  /** Monday of the last week a recap was sent (or skipped as empty) for. */
  recapSent: string | null
}

const DEFAULTS: Stored = { plan: 'value', recap: false, recapSent: null }
const settingsDir = (): string => path.join(userDataDir(), installKind() === 'dev' ? 'share.dev' : 'share')
const fileOf = (dir: string): string => `${folderKey(dir)}.json`

async function readStored(dir: string): Promise<Stored> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(settingsDir(), fileOf(dir)), 'utf8')) as Record<string, unknown>
    return {
      plan: isPlanChoice(raw.plan) ? raw.plan : DEFAULTS.plan,
      recap: raw.recap === true,
      recapSent: isMonday(raw.recapSent) ? raw.recapSent : null
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Changes to one folder's file, one at a time, so two never save over each other. */
const chains = new Map<string, Promise<unknown>>()
function update(dir: string, fn: (s: Stored) => Stored): Promise<Stored> {
  const k = folderKey(dir)
  const next = (chains.get(k) ?? Promise.resolve()).then(async () => {
    const s = fn(await readStored(dir))
    await writeOwn(fileOf(dir), JSON.stringify({ v: 1, ...s }, null, 2) + '\n', 0o644, settingsDir())
    return s
  })
  chains.set(
    k,
    next.catch(() => undefined)
  )
  return next
}

const visible = (s: Stored): ShareSettings => ({ plan: s.plan, recap: s.recap })

export const shareSettingsOf = async (dir: string): Promise<ShareSettings> => visible(await readStored(dir))

export async function setShareSettingsOf(dir: string, patch: Partial<ShareSettings>): Promise<ShareSettings> {
  if (typeof patch !== 'object' || patch === null) throw new Error('Nothing to change')
  const { plan, recap } = patch
  if (plan !== undefined && !isPlanChoice(plan)) throw new Error('Unknown plan')
  if (recap !== undefined && typeof recap !== 'boolean') throw new Error('Unknown recap setting')
  return visible(await update(dir, (s) => ({ ...s, ...(plan !== undefined ? { plan } : {}), ...(recap !== undefined ? { recap } : {}) })))
}

/* ------------------------------------------------------------------ the recap */

interface Folder {
  id: string
  name: string
  dir: string
}
let folders: Folder[] = []
let openProfile: ((id: string) => Promise<void>) | null = null
let timer: NodeJS.Timeout | null = null
const CHECK_MS = 10 * 60_000

/** A recap clicked: the week to open in Share once Today shows that folder. Forgotten after a minute. */
let pending: { key: string; week: string; at: number } | null = null

/** What Today shows when it opens on `dir`: the week a recap click asked for, once. */
export function takeShareOf(dir: string): string | null {
  const p = pending
  if (!p || Date.now() - p.at > 60_000 || p.key !== folderKey(dir)) return null
  pending = null
  return p.week
}

/** Every profile's folder, from src/main/domains/profiles.ts (with how it opens one in the window). */
export function watchRecapFolders(list: Array<{ name: string; dir: string }>, open: (id: string) => Promise<void>): void {
  folders = list.map((p) => ({ id: folderKey(path.resolve(p.dir)), name: p.name, dir: p.dir }))
  openProfile = open
  // a removed profile's transcripts aren't kept in memory
  const ids = new Set(list.map((p) => folderKey(p.dir)))
  for (const k of scans.keys()) if (!ids.has(k)) scans.delete(k)
  for (const k of shown.keys()) if (!ids.has(k)) shown.delete(k)
  if (timer) return
  // a failed check (Claudock's own folder not writable) tries again next time
  const check = (): void => void checkRecaps(Date.now()).catch(() => undefined)
  timer = setInterval(check, CHECK_MS)
  timer.unref()
  setTimeout(check, 30_000).unref()
}

/** The notification: "Your week in Claude Code" / "20 – 26 Oct · 38 sessions · ≈ $1,012 at API prices". */
export function recapText(w: WeekStats, plan: PlanChoice, profile: string | null): { title: string; body: string } {
  const value = weekValue(w, plan)
  const body = [formatRange(w.start, w.end), `${formatCount(w.sessions)} ${w.sessions === 1 ? 'session' : 'sessions'}`, value ? `${value} at API prices` : '']
  return { title: profile ? `${profile}: your week in Claude Code` : 'Your week in Claude Code', body: body.filter(Boolean).join(' · ') }
}

let checking: Promise<void> | null = null

/** Send each due recap: Mondays from 09:00, once per profile and week, not while alerts are paused, never for an empty week. */
export function checkRecaps(now: number): Promise<void> {
  checking ??= (async () => {
    const prefs = currentAlertPrefs()
    if (isPaused(prefs, now)) return
    for (const f of folders) {
      const st = await readStored(f.dir)
      const week = st.recap ? recapDue(now, st.recapSent) : null
      if (!week) continue
      const w = await weekIn(f.dir, week, now).catch(() => null)
      if (!w) continue
      await update(f.dir, (s) => ({ ...s, recapSent: week }))
      if (w.sessions === 0) continue
      postAlert(recapText(w, st.plan, folders.length > 1 ? f.name : null), { sound: prefs.sound, onClick: () => openRecap(f, week) })
    }
  })().finally(() => {
    checking = null
  })
  return checking
}

/** Today on the recap's profile, with Share open on its week (Today asks with takeShare when it mounts or is navigated to). */
export function openRecap(f: { id: string; dir: string }, week: string): void {
  pending = { key: folderKey(f.dir), week, at: Date.now() }
  const had = mainWindow()
  showMainWindow()
  const w = mainWindow()
  if (!w) return
  const other = !samePath(f.dir, openConfigDir())
  const send = (): void => {
    w.webContents.send('system:navigate', { screen: 'today', ...(other ? {} : { id: 'share' }) })
    // another profile opens after unsaved edits are asked about, and its Today takes the week
    if (other) void openProfile?.(f.id).catch(() => undefined)
  }
  if (had && !w.webContents.isLoading()) send()
  else w.webContents.once('did-finish-load', send)
}
