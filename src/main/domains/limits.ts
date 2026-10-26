import type { IpcMain } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { LimitWindow, LimitsApi, LimitsPreview, LimitsState, LiveLimits, TokenWindow, TokenWindows } from '@shared/api/limits'
import { defineDomain, emit } from '../ipcx'
import { assertWritable, configDir, userDataDir } from '../paths'
import { isObj, readSettings, updateSettings } from './extendShared'

/**
 * Limits: token counts from the transcripts under projects/, and the 5-hour / weekly percentages Claude Code hands to
 * the status line. The status line step is a small sh script in Claudock's own data folder
 * (`<userData>/live-limits/<config dir hash>/`, never the config folder): it saves `rate_limits` to limits.json there,
 * then runs the statusLine command the user had before, with the same input. settings.json is only changed through
 * updateSettings (snapshot, atomic write), and turning the step off puts the previous statusLine value back exactly.
 */

const DAY = 86_400_000
const HOUR = 3_600_000
const WIN = process.platform === 'win32'
const SCRIPT = 'statusline.sh'
const STATE = 'state.json'
const LIVE = 'limits.json'

/* ------------------------------------------------------------------ own data folder */

/** One folder per config dir, so the fixture and the real folder (and several accounts) never share limits. */
function dataDir(): string {
  const key = WIN || process.platform === 'darwin' ? configDir().toLowerCase() : configDir()
  return path.join(userDataDir(), 'live-limits', crypto.createHash('sha256').update(key).digest('hex').slice(0, 12))
}

/** POSIX single quoting: safe for any string, including quotes and `$`. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** The statusLine.command while the step is on. */
export function stepCommand(): string {
  return `sh ${shQuote(path.join(dataDir(), SCRIPT))}`
}

const isOurs = (statusLine: unknown): boolean => isObj(statusLine) && statusLine.command === stepCommand()

interface StepState {
  v: 1
  /** statusLine exactly as it was before the step was turned on; `present: false` when there was none. */
  original: { present: true; value: unknown } | { present: false }
  at: string
}

async function readState(): Promise<StepState | null> {
  try {
    const s = JSON.parse(await fsp.readFile(path.join(dataDir(), STATE), 'utf8')) as StepState
    return s?.v === 1 && isObj(s.original) && typeof s.original.present === 'boolean' ? s : null
  } catch {
    return null
  }
}

/** App data, not config: written directly (temp file + rename), like prefs.json. */
async function writeOwn(name: string, text: string, mode = 0o644): Promise<void> {
  const dir = dataDir()
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  await fsp.writeFile(tmp, text, { mode })
  await fsp.rename(tmp, path.join(dir, name))
}

const removeOwn = (name: string): Promise<void> => fsp.rm(path.join(dataDir(), name), { force: true })

/* ------------------------------------------------------------------ the status line step */

/**
 * Finds the top-level "rate_limits" value in the status line JSON and prints it. String-aware (braces inside strings
 * do not count), so it needs no jq. Single quotes are not allowed in here: the program sits in a sh '...' string.
 */
const EXTRACT_AWK = String.raw`{ s = s $0 "\n" }
END {
  n = length(s); d = 0; i = 1; f = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") {
      j = i + 1
      while (j <= n) { e = substr(s, j, 1); if (e == "\\") j += 2; else if (e == "\"") break; else j++ }
      k = substr(s, i, j - i + 1); i = j + 1
      if (d == 1 && k == "\"rate_limits\"") {
        while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
        if (substr(s, i, 1) == ":") { f = 1; i++; break }
      }
      continue
    }
    if (c == "{" || c == "[") d++
    else if (c == "}" || c == "]") d--
    i++
  }
  if (!f) exit 1
  while (i <= n && substr(s, i, 1) ~ /[ \t\r\n]/) i++
  if (substr(s, i, 1) != "{") exit 1
  b = i; d = 0
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") { j = i + 1; while (j <= n) { e = substr(s, j, 1); if (e == "\\") j += 2; else if (e == "\"") break; else j++ }; i = j + 1; continue }
    if (c == "{" || c == "[") d++
    else if (c == "}" || c == "]") { d--; if (d == 0) { print substr(s, b, i - b + 1); exit 0 } }
    i++
  }
  exit 1
}`

/** For people with no status line of their own: "5h 42% · week 61%", only the windows Claude Code sent. */
const LINE_AWK = String.raw`{ s = s $0 }
function pct(name,   w, v) {
  if (!match(s, "\"" name "\"[ \t\r\n]*:[ \t\r\n]*[{][^}]*[}]")) return ""
  w = substr(s, RSTART, RLENGTH)
  if (!match(w, /"used_percentage"[ \t\r\n]*:[ \t\r\n]*-?[0-9.]+/)) return ""
  v = substr(w, RSTART, RLENGTH); sub(/.*:[ \t\r\n]*/, "", v)
  return int(v + 0.5) "%"
}
END {
  a = pct("five_hour"); b = pct("seven_day"); o = ""
  if (a != "") o = "5h " a
  if (b != "") o = (o == "" ? "" : o " · ") "week " b
  if (o != "") print o
}`

/** The step's script. `original` is the previous statusLine.command, run with the same stdin, cwd and env. */
function stepScript(original: string | null): string {
  return [
    '#!/bin/sh',
    '# Claudock live limits. Claude Code runs this as your status line: it saves the rate_limits it receives into',
    '# this folder, then runs the status line you had before. Turn live limits off in Claudock to put that back.',
    `dir=${shQuote(dataDir())}`,
    `cmd=${shQuote(original ?? '')}`,
    'in="$dir/.in.$$"',
    `trap 'rm -f "$in" "$dir/.limits.$$"; exit 143' HUP INT TERM`,
    'if ! cat 2>/dev/null > "$in"; then',
    '  rm -f "$in" 2>/dev/null',
    '  [ -n "$cmd" ] && exec /bin/sh -c "$cmd"',
    '  exit 0',
    'fi',
    `rl=$(LC_ALL=C awk '${EXTRACT_AWK}' "$in" 2>/dev/null)`,
    'if [ -n "$rl" ]; then',
    `  if printf '{"v":1,"at":%s,"rate_limits":%s}\\n' "$(date +%s)" "$rl" > "$dir/.limits.$$" 2>/dev/null; then`,
    '    mv -f "$dir/.limits.$$" "$dir/limits.json" 2>/dev/null || rm -f "$dir/.limits.$$"',
    '  else',
    '    rm -f "$dir/.limits.$$" 2>/dev/null',
    '  fi',
    'fi',
    'if [ -n "$cmd" ]; then',
    '  exec < "$in"',
    '  rm -f "$in"',
    '  trap - HUP INT TERM',
    '  if command -v bash >/dev/null 2>&1; then exec bash -c "$cmd"; fi',
    '  exec /bin/sh -c "$cmd"',
    'fi',
    'rm -f "$in"',
    `[ -n "$rl" ] && printf '%s\\n' "$rl" | LC_ALL=C awk '${LINE_AWK}'`,
    'exit 0',
    ''
  ].join('\n')
}

const commandOf = (state: StepState | null): string | null =>
  state?.original.present && isObj(state.original.value) && typeof state.original.value.command === 'string' ? state.original.value.command : null

/** The script is regenerated from state.json if it went missing while settings.json still points at it. */
async function ensureScript(): Promise<void> {
  if (WIN) return
  const st = await readState()
  if (!st || fs.existsSync(path.join(dataDir(), SCRIPT))) return
  if (!isOurs((await readSettings()).data.statusLine)) return
  await writeOwn(SCRIPT, stepScript(commandOf(st)), 0o755)
}

/* ------------------------------------------------------------------ live limits (from the step) */

function windowOf(v: unknown): LimitWindow | null {
  if (!isObj(v)) return null
  const p = v.used_percentage
  const r = v.resets_at
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || typeof r !== 'number' || !Number.isFinite(r) || r <= 0) return null
  return { usedPercentage: p, resetsAt: r * 1000 }
}

async function readLive(): Promise<LiveLimits | null> {
  try {
    const o = JSON.parse(await fsp.readFile(path.join(dataDir(), LIVE), 'utf8')) as unknown
    if (!isObj(o) || o.v !== 1 || typeof o.at !== 'number' || !isObj(o.rate_limits)) return null
    const fiveHour = windowOf(o.rate_limits.five_hour)
    const sevenDay = windowOf(o.rate_limits.seven_day)
    if (!fiveHour && !sevenDay) return null
    return { at: o.at * 1000, fiveHour, sevenDay }
  } catch {
    return null
  }
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
}

const scans = new Map<string, FileScan>()
const CHUNK = 1024 * 1024
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

function entryOf(line: string, cutoff: number): Entry | null {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObj(o) || o.type !== 'assistant' || !isObj(o.message) || !isObj(o.message.usage)) return null
  if (o.message.model === '<synthetic>') return null
  const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
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
async function readFrom(abs: string, from: number, to: number, cutoff: number, out: Entry[]): Promise<number> {
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
        const e = entryOf(line, cutoff)
        if (e) out.push(e)
      }
    }
    // a last line without a newline counts once it is whole (it parses); a line still being written does not
    if (rest.trim()) {
      try {
        JSON.parse(rest)
        const e = entryOf(rest, cutoff)
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
async function recentTranscripts(cutoff: number): Promise<{ abs: string; size: number; mtimeMs: number }[]> {
  const root = path.join(configDir(), 'projects')
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

async function scanTranscripts(now: number): Promise<void> {
  const cutoff = now - 7 * DAY
  const files = await recentTranscripts(cutoff)
  const live = new Set(files.map((f) => f.abs))
  for (const k of scans.keys()) if (!live.has(k)) scans.delete(k)
  for (const f of files) {
    let s = scans.get(f.abs)
    if (s && s.size === f.size && s.mtimeMs === f.mtimeMs) continue
    // shrunk or rewritten in place: read it all again; grown: read only what was appended
    if (!s || f.size < s.offset || (f.size === s.size && f.mtimeMs !== s.mtimeMs)) s = { size: 0, mtimeMs: 0, offset: 0, entries: [] }
    try {
      s.offset = await readFrom(f.abs, s.offset, f.size, cutoff, s.entries)
      s.size = f.size
      s.mtimeMs = f.mtimeMs
      scans.set(f.abs, s)
    } catch {
      scans.delete(f.abs)
    }
  }
  for (const s of scans.values()) if (s.entries.length && s.entries[0].t < cutoff) s.entries = s.entries.filter((e) => e.t >= cutoff)
}

function tokenWindows(now: number): TokenWindows {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const starts = { fiveHour: now - 5 * HOUR, today: midnight.getTime(), sevenDay: now - 7 * DAY }
  const acc = Object.fromEntries(Object.keys(starts).map((k) => [k, { tokens: 0, sessions: new Set<string>() }])) as Record<
    keyof TokenWindows,
    { tokens: number; sessions: Set<string> }
  >
  // a resumed session repeats earlier messages in its new file: count each message once across files
  const seen = new Set<string>()
  for (const s of scans.values()) {
    for (const e of s.entries) {
      if (seen.has(e.key)) continue
      seen.add(e.key)
      for (const k of Object.keys(starts) as (keyof TokenWindows)[]) {
        if (e.t < starts[k]) continue
        acc[k].tokens += e.tokens
        if (e.session) acc[k].sessions.add(e.session)
      }
    }
  }
  const out = (k: keyof TokenWindows): TokenWindow => ({ tokens: acc[k].tokens, sessions: acc[k].sessions.size })
  return { fiveHour: out('fiveHour'), today: out('today'), sevenDay: out('sevenDay') }
}

let scanning: Promise<void> | null = null
let scannedAt = 0
let scannedDir = ''

/** Scans are incremental and shared: callers within 5 s reuse the last one. */
async function currentTokens(): Promise<TokenWindows> {
  const now = Date.now()
  if (scannedDir !== configDir()) {
    scans.clear()
    scannedDir = configDir()
    scannedAt = 0
  }
  if (now - scannedAt > 5000) {
    scanning ??= scanTranscripts(now).finally(() => {
      scannedAt = Date.now()
      scanning = null
    })
    await scanning
  }
  return tokenWindows(Date.now())
}

/* ------------------------------------------------------------------ state, watching, events */

/** Everything the limits card and the menu bar glance show. */
export async function currentLimits(): Promise<LimitsState> {
  const tokens = await currentTokens()
  if (WIN) return { step: 'unsupported', live: null, tokens }
  const on = isOurs((await readSettings()).data.statusLine)
  return { step: on ? 'on' : 'off', live: on ? await readLive() : null, tokens }
}

/** The statusLine command to show people: their own one while the step wraps it, else what settings.json says. */
export async function displayedStatusLine(statusLine: unknown): Promise<string | null> {
  if (!isObj(statusLine) || typeof statusLine.command !== 'string') return null
  if (!isOurs(statusLine)) return statusLine.command
  return commandOf(await readState())
}

type Listener = (s: LimitsState) => void
const listeners = new Set<Listener>()

/** For main-process surfaces (the menu bar glance). Returns the unsubscribe function. */
export function onLimitsChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let notifyTimer: NodeJS.Timeout | null = null
function notifySoon(): void {
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    void currentLimits().then((s) => {
      emit('limits:changed', s)
      for (const l of listeners) l(s)
    }, () => undefined)
  }, 250)
}

let watcher: fs.FSWatcher | null = null
function watch(on: boolean): void {
  watcher?.close()
  watcher = null
  if (!on) return
  try {
    watcher = fs.watch(dataDir(), (_ev, name) => {
      if (name === null || name === LIVE) notifySoon()
    })
    watcher.on('error', () => watch(false))
  } catch {
    /* folder missing: nothing to watch */
  }
}

/* ------------------------------------------------------------------ turning the step on and off */

function assertSupported(): void {
  if (WIN) throw new Error('Live limits are not available on Windows yet')
}

/** statusLine must be missing or a command Claude Code runs; anything else is left alone. */
function wrappable(statusLine: unknown): statusLine is undefined | { command: string } {
  if (statusLine === undefined) return true
  return isObj(statusLine) && (statusLine.type === undefined || statusLine.type === 'command') && typeof statusLine.command === 'string'
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

async function preview(): Promise<LimitsPreview> {
  assertSupported()
  const { data, error } = await readSettings()
  if (error) throw new Error(error)
  const sl = data.statusLine
  if (isOurs(sl)) return { before: stepCommand(), after: commandOf(await readState()) }
  return { before: isObj(sl) && typeof sl.command === 'string' ? sl.command : null, after: stepCommand() }
}

async function enable(): Promise<{ snapshotId: string | null }> {
  assertSupported()
  assertWritable()
  const { data, error } = await readSettings()
  if (error) throw new Error(`${error}. Nothing was written.`)
  const before = data.statusLine
  if (isOurs(before)) return { snapshotId: null }
  if (!wrappable(before)) throw new Error("statusLine in settings.json isn't a command, so live limits can't run alongside it. Nothing was written.")
  const state: StepState = {
    v: 1,
    original: before === undefined ? { present: false } : { present: true, value: JSON.parse(JSON.stringify(before)) as unknown },
    at: new Date().toISOString()
  }
  // the script must exist before settings.json points at it: Claude Code runs a changed command at once
  await removeOwn(LIVE)
  await writeOwn(STATE, JSON.stringify(state, null, 2) + '\n')
  await writeOwn(SCRIPT, stepScript(before?.command ?? null), 0o755)
  const r = await updateSettings((s) => {
    if (!sameJson(s.statusLine, before)) throw new Error('settings.json changed while turning on live limits. Nothing was written; try again.')
    s.statusLine = before === undefined ? { type: 'command', command: stepCommand() } : { ...before, command: stepCommand() }
  }, 'Turn on live limits')
  watch(true)
  notifySoon()
  return { snapshotId: r.snapshotId }
}

async function disable(): Promise<{ snapshotId: string | null }> {
  assertSupported()
  assertWritable()
  const state = await readState()
  const r = await updateSettings((s) => {
    if (!isOurs(s.statusLine)) return false
    if (state?.original.present) s.statusLine = state.original.value
    // no record of what was there (Claudock's data folder was cleared): remove the step rather than leave it broken
    else delete s.statusLine
  }, 'Turn off live limits')
  watch(false)
  await Promise.all([removeOwn(SCRIPT), removeOwn(STATE), removeOwn(LIVE)])
  notifySoon()
  return { snapshotId: r.snapshotId }
}

export function register(ipcMain: IpcMain): void {
  const impl: LimitsApi = { get: currentLimits, preview, enable, disable }
  defineDomain(ipcMain, 'limits', impl)
  if (WIN) return
  void readSettings().then(async ({ data }) => {
    const on = isOurs(data.statusLine)
    if (on) await ensureScript()
    watch(on)
  }, () => undefined)
}
