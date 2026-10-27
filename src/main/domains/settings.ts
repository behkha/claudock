import type { IpcMain } from 'electron'
import path from 'node:path'
import type { SettingsApi, SettingsFileName, SettingsHistoryItem, SettingsSummary } from '@shared/api/settings'
import { SETTINGS_FILES } from '@shared/api/settings'
import { listDir, readText, stat } from '../fsx'
import { defineDomain } from '../ipcx'
import { assertWritable, configDir, resolveInside } from '../paths'
import { getSettingsDocs } from '../settingsDocs'
import { ourHookCommands } from './sessions'
import { listSnapshots, readSnapshotText, restoreSnapshot, safeWriteJson, safeWriteText, withFileLock as sharedFileLock } from '../safeWrite'

/* ------------------------------------------------------------------ shared helpers (also used by hooks + permissions) */

export type JsonObject = Record<string, unknown>

export function isPlainObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Only the two known file names are accepted from the renderer. */
export function assertSettingsFile(file: unknown): SettingsFileName {
  if (typeof file !== 'string' || !(SETTINGS_FILES as string[]).includes(file)) throw new Error('Unknown settings file')
  return file as SettingsFileName
}

export function settingsPath(file: SettingsFileName): string {
  return resolveInside(file)
}

/** One read-modify-write at a time per file, so Hooks / Permissions / Settings never interleave inside this app. */
export function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  return sharedFileLock(file, fn)
}

interface Loaded {
  exists: boolean
  text: string
  mtimeMs: number | null
  size: number
}

async function load(file: SettingsFileName): Promise<Loaded> {
  const abs = settingsPath(file)
  const st = await stat(abs)
  if (!st) return { exists: false, text: '', mtimeMs: null, size: 0 }
  if (!st.isFile) throw new Error(`${file} is not a regular file`)
  const text = await readText(abs)
  return { exists: true, text, mtimeMs: st.mtimeMs, size: st.size }
}

/** Parse a settings file into an object. A missing file is `{}`; an unparseable one throws (never overwrite it). */
export async function readSettingsObject(file: SettingsFileName): Promise<{ obj: JsonObject; mtimeMs: number | null; exists: boolean }> {
  const l = await load(file)
  if (!l.exists || l.text.trim() === '') return { obj: {}, mtimeMs: l.mtimeMs, exists: l.exists }
  let parsed: unknown
  try {
    parsed = JSON.parse(l.text.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}). Fix it in Settings > JSON first.`, { cause: e })
  }
  if (!isPlainObject(parsed)) throw new Error(`${file} is not a JSON object. Fix it in Settings > JSON first.`)
  return { obj: parsed, mtimeMs: l.mtimeMs, exists: true }
}

/**
 * Re-read `file` immediately, let `mutate` change the parsed object in place (return false for "nothing to do"), and
 * write it back through safeWrite. Retries if the file changed between the read and the write. Only the keys the caller
 * touches change; unknown keys keep their order and content.
 */
export async function updateSettingsObject(
  file: SettingsFileName,
  mutate: (obj: JsonObject) => boolean | void,
  reason: string
): Promise<{ mtimeMs: number | null; snapshotId: string | null; changed: boolean }> {
  assertWritable()
  return withFileLock(file, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { obj, mtimeMs } = await readSettingsObject(file)
      if (mutate(obj) === false) return { mtimeMs, snapshotId: null, changed: false }
      const now = await stat(settingsPath(file))
      if ((now?.mtimeMs ?? null) !== mtimeMs) continue // changed under us: redo from a fresh read
      const res = await safeWriteJson(file, obj, reason)
      const after = await stat(settingsPath(file))
      return { mtimeMs: after?.mtimeMs ?? null, snapshotId: res.snapshotId, changed: true }
    }
    throw new Error(`${file} kept changing while writing; try again`)
  })
}

/** Set (or with `undefined`, remove) one top-level key. */
export function writeSettingsKey(file: SettingsFileName, key: string, value: unknown, reason: string): ReturnType<typeof updateSettingsObject> {
  return updateSettingsObject(
    file,
    (obj) => {
      if (value === undefined) {
        if (!(key in obj)) return false
        delete obj[key]
      } else obj[key] = value
    },
    reason
  )
}

/* ------------------------------------------------------------------ scripts mentioned in a command */

/** Prefixes that mean "the config dir", written with '/' (tokens are normalised to '/' first) and lower-cased. */
const HOME_PREFIXES = [
  '~/.claude/',
  '$home/.claude/',
  '${home}/.claude/',
  '%userprofile%/.claude/',
  '$env:userprofile/.claude/',
  '$claude_config_dir/',
  '${claude_config_dir}/',
  '%claude_config_dir%/',
  '$env:claude_config_dir/'
]

/** macOS and Windows disks are case-insensitive by default (and Windows env var names always are). */
const foldCase = (s: string): string => (process.platform === 'linux' ? s : s.toLowerCase())

export async function configScripts(command: string): Promise<string[]> {
  if (typeof command !== 'string' || command.length > 20_000) return []
  const root = configDir()
  const rootKey = foldCase(root.replace(/\\/g, '/').replace(/\/+$/, ''))
  const tokens = command.match(/[^\s"'`;|&<>()]+/g) ?? []
  const found: string[] = []
  for (const raw of tokens) {
    // `C:\Users\me\.claude\x`, `C:/Users/me/.claude/x`, `~\.claude\x` and `%USERPROFILE%\.claude\x` all mean the same file
    const tok = raw.replace(/\\/g, '/')
    const lower = tok.toLowerCase()
    let candidate: string | null = null
    const prefix = HOME_PREFIXES.find((p) => lower.startsWith(p))
    if (prefix) candidate = path.join(root, tok.slice(prefix.length))
    else {
      const key = foldCase(tok)
      if (key === rootKey || key.startsWith(rootKey + '/')) candidate = path.join(root, tok.slice(rootKey.length))
    }
    if (!candidate) continue
    try {
      const abs = path.resolve(candidate)
      const rel = path.relative(root, abs)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue
      const st = await stat(abs)
      if (st?.isFile && !found.includes(rel)) found.push(rel)
    } catch {
      /* ignore odd tokens */
    }
  }
  return found
}

/* ------------------------------------------------------------------ summary */

/** Hook commands, and events with at least one, leaving out Claudock's own (Connect to Claude Code adds them). */
export function countHooks(hooks: unknown): { commands: number; events: number } {
  if (!isPlainObject(hooks)) return { commands: 0, events: 0 }
  const ours = ourHookCommands()
  let commands = 0
  let events = 0
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue
    let inEvent = 0
    for (const g of groups) {
      if (isPlainObject(g) && Array.isArray(g.hooks)) inEvent += g.hooks.filter((h) => isPlainObject(h) && !(typeof h.command === 'string' && ours.has(h.command))).length
    }
    if (inEvent > 0) events++
    commands += inEvent
  }
  return { commands, events }
}

export async function hookCommandCount(): Promise<number> {
  let n = 0
  for (const f of SETTINGS_FILES) {
    try {
      const { obj } = await readSettingsObject(f)
      n += countHooks(obj.hooks).commands
    } catch {
      /* unparseable file: skip */
    }
  }
  return n
}

async function summarize(file: SettingsFileName): Promise<SettingsSummary> {
  const empty: SettingsSummary = {
    hookCommands: 0,
    hookEvents: 0,
    allow: 0,
    ask: 0,
    deny: 0,
    defaultMode: null,
    skillOverridesTotal: 0,
    skillOverridesOff: 0,
    pluginsTotal: 0,
    pluginsEnabled: 0
  }
  let obj: JsonObject
  try {
    obj = (await readSettingsObject(file)).obj
  } catch {
    return empty
  }
  const h = countHooks(obj.hooks)
  const perms = isPlainObject(obj.permissions) ? obj.permissions : {}
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
  const so = isPlainObject(obj.skillOverrides) ? Object.values(obj.skillOverrides) : []
  const ep = isPlainObject(obj.enabledPlugins) ? Object.values(obj.enabledPlugins) : []
  return {
    hookCommands: h.commands,
    hookEvents: h.events,
    allow: len(perms.allow),
    ask: len(perms.ask),
    deny: len(perms.deny),
    defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : null,
    skillOverridesTotal: so.length,
    skillOverridesOff: so.filter((v) => v === 'off').length,
    pluginsTotal: ep.length,
    pluginsEnabled: ep.filter((v) => v === true).length
  }
}

/* ------------------------------------------------------------------ history */

/** Loose copies in the config root that belong to `file` (`settings.json.bak`, `settings.json.bak-2026…`, `settings.bak`). */
async function looseCopies(file: SettingsFileName): Promise<Array<{ name: string; size: number; mtimeMs: number }>> {
  const stem = file.replace(/\.json$/, '')
  const entries = await listDir(configDir())
  return entries
    .filter((e) => {
      if (!e.isFile || e.secret || e.name === file) return false
      const n = e.name.toLowerCase()
      const mine = n.startsWith(file + '.') || n.startsWith(file + '-') || n.startsWith(stem + '.bak')
      return mine && /bak|backup|orig|old/.test(n)
    })
    .map((e) => ({ name: e.name, size: e.size, mtimeMs: e.mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function parseObjectText(text: string, what: string, verb = 'restored'): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error(`${what} is not valid JSON, nothing was ${verb}: ${(e as Error).message}`, { cause: e })
  }
  if (!isPlainObject(parsed)) throw new Error(`${what} is not a JSON object, nothing was ${verb}`)
}

async function readHistoryText(file: SettingsFileName, id: string): Promise<string> {
  if (id.startsWith('snap:')) return readSnapshotText(id.slice(5), file)
  if (id.startsWith('bak:')) {
    const name = id.slice(4)
    const ok = (await looseCopies(file)).some((c) => c.name === name)
    if (!ok) throw new Error('That copy is no longer there')
    return readText(resolveInside(name))
  }
  throw new Error('Unknown history item')
}

/* ------------------------------------------------------------------ IPC */

const impl: SettingsApi = {
  async read(file) {
    const f = assertSettingsFile(file)
    const l = await load(f)
    return { file: f, path: settingsPath(f), ...l }
  },

  async stat(file) {
    const f = assertSettingsFile(file)
    const st = await stat(settingsPath(f))
    return { exists: !!st, mtimeMs: st?.mtimeMs ?? null, size: st?.size ?? 0 }
  },

  async save(file, text, expectedMtimeMs) {
    const f = assertSettingsFile(file)
    if (typeof text !== 'string') throw new Error('Nothing to save')
    parseObjectText(text, f, 'written')
    assertWritable()
    return withFileLock(f, async () => {
      const st = await stat(settingsPath(f))
      const current = st?.mtimeMs ?? null
      const same = current === expectedMtimeMs || (current !== null && expectedMtimeMs !== null && Math.abs(current - expectedMtimeMs) < 1)
      if (!same) {
        throw new Error(`CHANGED_ON_DISK: ${f} changed on disk since you opened it.`)
      }
      const res = await safeWriteText(f, text, `Edit ${f} in Claudock`)
      const after = await stat(settingsPath(f))
      return { mtimeMs: after?.mtimeMs ?? 0, snapshotId: res.snapshotId }
    })
  },

  summary(file) {
    return summarize(assertSettingsFile(file))
  },

  async history(file) {
    const f = assertSettingsFile(file)
    const out: SettingsHistoryItem[] = []
    for (const s of await listSnapshots()) {
      if (s.files.some((x) => x.split(path.sep).join('/') === f)) out.push({ id: `snap:${s.id}`, kind: 'snapshot', at: s.at, label: s.reason, size: null })
    }
    for (const c of await looseCopies(f)) {
      out.push({ id: `bak:${c.name}`, kind: 'backup', at: new Date(c.mtimeMs).toISOString(), label: c.name, size: c.size })
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200)
  },

  async readHistory(file, id) {
    return readHistoryText(assertSettingsFile(file), String(id))
  },

  async restore(file, id) {
    const f = assertSettingsFile(file)
    assertWritable()
    return withFileLock(f, async () => {
      if (id.startsWith('snap:')) {
        parseObjectText(await readSnapshotText(id.slice(5), f), 'That snapshot')
        await restoreSnapshot(id.slice(5), f)
      } else {
        const text = await readHistoryText(f, id)
        parseObjectText(text, 'That copy')
        await safeWriteText(f, text, `Restore of ${f} from ${id.slice(4)}`)
      }
      const after = await stat(settingsPath(f))
      return { mtimeMs: after?.mtimeMs ?? 0, snapshotId: null }
    })
  },

  scripts(command) {
    return configScripts(command)
  },

  docs() {
    return getSettingsDocs()
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'settings', impl)
}
