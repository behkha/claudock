import type { IpcMain } from 'electron'
import os from 'node:os'
import path from 'node:path'
import type { ContextApi, ContextList, ContextSession } from '@shared/api/context'
import { formatEstimate } from '@shared/api/context'
import { tildify } from '@shared/format'
import { parseFrontmatter } from '@shared/frontmatter'
import { folderKey, writeOwn } from '../connect/folder'
import {
  buildItems,
  deniedNames,
  hasRecords,
  mcpKey,
  memoOf,
  modeOf,
  skillLine,
  switchServer,
  switchSkill,
  totalTokens,
  type KnownSkill,
  type MemoryFile,
  type Records,
  type SwitchMemo
} from '../context/model'
import { readCalls, readRecords, transcripts, type CallsRead, type RecordsRead } from '../context/scan'
import { tryReadJson } from '../fsx'
import { defineDomain, emit } from '../ipcx'
import { configDir, globalStateFile, installKind, isInside, isSecret, openConfigDir, userDataDir } from '../paths'
import { parseLine, userText } from '../transcripts/parse'
import { isObj, readCapped, readHead, readSettings, toPosix, updateSettings } from './extendShared'
import { ownSessionName } from './projects'
import { ruleRels } from './rules'
import { listSkills } from './skills'

/**
 * The Context screen: what each skill, MCP server and CLAUDE.md file adds to every session of the open profile,
 * measured from the newest transcript that has Claude Code's records of a session's start (src/main/context/model.ts),
 * with switches that write settings.json through safeWrite (`skillOverrides`, `deniedMcpServers`). Everything is read
 * from the folder the call started on; what is cached is kept per folder, so profiles never mix.
 */

const DAY = 86_400_000
const USE_DAYS = 30
/** Newest transcripts looked at for the records; older Claude Code versions write none. */
const CANDIDATES = 12
const TEXT_CAP = 200_000
/** The sidebar badge asks again after every write anywhere: a scan that just finished is reused this long. */
const SCAN_REUSE_MS = 5000

/* ------------------------------------------------------------------ transcripts */

type Usage = Map<string, { count: number; last: number }>
type Newest = { session: ContextSession; records: Records } | null

/**
 * One profile folder's reading state: how far each transcript was read, the newest-session read (running or just
 * done, one at a time) and the usage count (in the background: the first one reads every transcript of 30 days).
 */
interface Folder {
  records: Map<string, RecordsRead>
  calls: Map<string, CallsRead>
  newest: { at: number; p: Promise<Newest>; done: boolean } | null
  use: { at: number; value: Usage } | null
  counting: Promise<void> | null
}
const folders = new Map<string, Folder>()
const folderOf = (dir: string): Folder => {
  let f = folders.get(dir)
  if (!f) folders.set(dir, (f = { records: new Map(), calls: new Map(), newest: null, use: null, counting: null }))
  return f
}

/** The first prompt, from the head of the file, for a session Claude Code didn't name. */
async function firstPrompt(abs: string): Promise<string | null> {
  const head = await readHead(abs, 64 * 1024).catch(() => '')
  for (const line of head.split('\n').slice(0, -1)) {
    if (!line.includes('"type":"user"')) continue
    const o = parseLine(Buffer.from(line))
    if (!o || o.type !== 'user' || !isObj(o.message) || typeof o.message.content !== 'string') continue
    const t = userText(o.message.content)
    if (t && !t.command) return t.text.replace(/\s+/g, ' ').trim().slice(0, 120)
  }
  return null
}

/** The newest session of the folder that recorded its start, if any of the last few did. */
async function readNewest(dir: string, f: Folder): Promise<Newest> {
  const files = (await transcripts(dir, 0, false)).slice(0, CANDIDATES)
  const keep = new Set(files.map((x) => x.abs))
  for (const k of f.records.keys()) if (!keep.has(k)) f.records.delete(k)
  for (const file of files) {
    const r = await readRecords(file, f.records.get(file.abs)).catch(() => null)
    if (!r) {
      f.records.delete(file.abs)
      continue
    }
    f.records.set(file.abs, r)
    if (!hasRecords(r.records)) continue
    const id = path.basename(file.abs, '.jsonl')
    const name = (await ownSessionName(file.abs)) ?? (await firstPrompt(file.abs)) ?? id.slice(0, 8)
    return { session: { id, name, cwd: r.cwd, at: file.mtimeMs }, records: r.records }
  }
  return null
}

/** The newest session, read once at a time per folder (the reads share its state) and reused for a few seconds. */
function newestOf(dir: string): Promise<Newest> {
  const f = folderOf(dir)
  const prev = f.newest
  if (prev && (!prev.done || Date.now() - prev.at < SCAN_REUSE_MS)) return prev.p
  const run = (prev?.p ?? Promise.resolve()).catch(() => undefined).then(() => readNewest(dir, f))
  const entry = { at: Date.now(), p: run, done: false }
  f.newest = entry
  run.then(
    () => Object.assign(entry, { at: Date.now(), done: true }),
    () => void (f.newest === entry && (f.newest = null))
  )
  return run
}

/** MCP tool calls per server key over the last 30 days of transcripts (sub-agents too), each call once by its id. */
async function countCalls(dir: string, f: Folder, now: number): Promise<Usage> {
  const cutoff = now - USE_DAYS * DAY
  const files = await transcripts(dir, cutoff, true)
  const keep = new Set(files.map((x) => x.abs))
  for (const k of f.calls.keys()) if (!keep.has(k)) f.calls.delete(k)
  for (const file of files) {
    const r = await readCalls(file, f.calls.get(file.abs)).catch(() => null)
    if (r) f.calls.set(file.abs, r)
    else f.calls.delete(file.abs)
  }
  const out: Usage = new Map()
  const seen = new Set<string>()
  for (const r of f.calls.values()) {
    for (const call of r.calls) {
      if (call.t < cutoff || (call.id && seen.has(call.id))) continue
      if (call.id) seen.add(call.id)
      const u = out.get(call.key) ?? { count: 0, last: 0 }
      u.count++
      u.last = Math.max(u.last, call.t)
      out.set(call.key, u)
    }
  }
  return out
}

const sameUsage = (a: Usage | undefined, b: Usage): boolean =>
  !!a && a.size === b.size && [...b].every(([k, v]) => a.get(k)?.count === v.count && a.get(k)?.last === v.last)

/**
 * The last count of MCP tool calls (null before the first one finishes), counting again in the background when it is
 * older than a few seconds; a count that comes out different tells the screen with `context:usage`.
 */
function usageOf(dir: string): { use: Usage | null; counting: Promise<void> | null } {
  const f = folderOf(dir)
  if (!f.counting && (!f.use || Date.now() - f.use.at >= SCAN_REUSE_MS)) {
    const run = countCalls(dir, f, Date.now()).then(
      (value) => {
        const changed = !sameUsage(f.use?.value, value)
        f.use = { at: Date.now(), value }
        if (changed && dir === openConfigDir()) emit('context:usage', null)
      },
      () => undefined
    )
    f.counting = run.finally(() => {
      f.counting = null
    })
  }
  return { use: f.use?.value ?? null, counting: f.counting }
}

/* ------------------------------------------------------------------ CLAUDE.md and rules */

/** A rule with `paths:` loads only once Claude reads a matching file, so it is no part of a session's start. */
const conditional = (text: string): boolean => {
  const p = parseFrontmatter(text).data.paths
  return Array.isArray(p) ? p.length > 0 : typeof p === 'string' && p.trim() !== ''
}

async function readInside(dir: string, abs: string): Promise<string | null> {
  if (!isInside(dir, abs) || isSecret(abs)) return null
  try {
    return (await readCapped(abs, 4_000_000)).text
  } catch {
    return null
  }
}

/**
 * The instruction files every session starts with: this folder's CLAUDE.md and rules as they are now (a rule with
 * `paths:` left out), plus what the session loaded from elsewhere (imports), as it loaded it.
 */
async function memoryFiles(dir: string, records: Records | null): Promise<MemoryFile[]> {
  const home = os.homedir()
  const rulesIdOf = (rel: string): string | undefined => (rel === 'CLAUDE.md' || (rel.startsWith('rules/') && rel.endsWith('.md')) ? rel : undefined)
  const out: MemoryFile[] = []
  const have = new Set<string>()
  const addHere = async (rel: string, sessionPath: string): Promise<void> => {
    const abs = path.join(dir, rel)
    if (have.has(abs)) return
    have.add(abs)
    const text = await readInside(dir, abs)
    // gone since, empty, or a rule that now waits for its paths
    if (text === null || !text.trim() || (rel !== 'CLAUDE.md' && conditional(text))) return
    out.push({ path: sessionPath, name: rel, text, fromSession: false, rulesId: rulesIdOf(rel) })
  }
  for (const f of records?.memory ?? []) {
    if (f.type !== 'User') continue
    const abs = path.resolve(f.path)
    if (isInside(dir, abs)) {
      await addHere(toPosix(path.relative(dir, abs)), f.path)
      continue
    }
    // this folder under another name (a copy, a symlink): its CLAUDE.md or rule of the same place
    const tail = f.path.replace(/\\/g, '/').match(/(?:^|\/)(rules\/.+\.md|CLAUDE\.md)$/)?.[1]
    if (tail && (await readInside(dir, path.join(dir, tail))) !== null) {
      await addHere(tail, path.join(dir, tail))
      continue
    }
    if (have.has(abs)) continue
    have.add(abs)
    out.push({ path: f.path, name: tildify(f.path, home), text: f.content, fromSession: true })
  }
  // files added since, or no session to go by
  for (const rel of ['CLAUDE.md', ...(await ruleRels().catch(() => [] as string[])).map(toPosix)]) await addHere(rel, path.join(dir, rel))
  return out
}

/* ------------------------------------------------------------------ list */

const texts = new Map<string, Map<string, string>>()

/** `usage`: 'skip' for the sidebar badge, 'last' for the screen (counting on in the background), 'wait' for checks. */
async function build(dir: string, usage: 'skip' | 'last' | 'wait'): Promise<ContextList> {
  const [{ data: settings, error: settingsError }, state, skills, newest] = await Promise.all([
    readSettings(),
    tryReadJson<unknown>(globalStateFile()).then((r) => (r.ok && isObj(r.value) ? r.value : {})),
    listSkills(),
    newestOf(dir)
  ])
  let use: Usage | null = null
  if (usage !== 'skip') {
    const u = usageOf(dir)
    if (usage === 'wait' && u.counting) await u.counting
    use = usage === 'wait' ? (folderOf(dir).use?.value ?? null) : u.use
  }
  const overrides = isObj(settings.skillOverrides) ? settings.skillOverrides : {}
  const records = newest?.records ?? null
  const known: KnownSkill[] = skills.skills
    .filter((s) => s.source === 'user' || s.source === 'plugin')
    .map((s) => ({ id: s.id, key: s.key, name: s.name, source: s.label, description: s.description, loads: s.pluginEnabled !== false && s.modelHidden !== true }))
  const projectKeys = new Set<string>()
  if (isObj(state.projects)) for (const p of Object.values(state.projects)) if (isObj(p) && isObj(p.mcpServers)) for (const n of Object.keys(p.mcpServers)) projectKeys.add(mcpKey(n))
  const memory = await memoryFiles(dir, records)
  const items = buildItems({
    skills: known,
    synced: new Set(skills.skills.filter((s) => s.source === 'synced').map((s) => s.name)),
    overrides,
    skillUsage: state.skillUsage,
    servers: isObj(state.mcpServers) ? Object.keys(state.mcpServers).map((name) => ({ name, source: 'user' })) : [],
    projectKeys,
    denied: deniedNames(settings.deniedMcpServers),
    records,
    mcpUse: use ?? new Map(),
    memory
  })

  // the text behind each number, for text(): what Claude Code was given, or would be given next time
  const t = new Map<string, string>()
  for (const i of items) {
    if (i.kind === 'skill') {
      const key = i.id.slice('skill:'.length)
      // what is counted; for a skill turned off, what it would add once on
      const description = known.find((s) => s.key === key)?.description ?? ''
      t.set(i.id, modeOf(overrides[key]) === 'name' ? skillLine(key, '', 'name') : (records?.skills?.get(key) ?? skillLine(key, description, 'full')))
    } else if (i.kind === 'mcp') {
      const key = mcpKey(i.id.slice('mcp:'.length))
      const block = records?.instructions.get(key)
      t.set(i.id, [[...(records?.tools?.get(key) ?? [])].join('\n'), block ?? ''].filter(Boolean).join('\n\n'))
    } else {
      t.set(i.id, memory.find((m) => `memory:${m.path}` === i.id)?.text ?? '')
    }
  }
  texts.set(dir, t)
  // until the first count lands, a server's Used would read "0 in 30 d" without being known
  if (usage !== 'skip' && use === null) for (const i of items) if (i.kind === 'mcp') delete i.uses
  return { items, tokens: totalTokens(items), session: newest?.session ?? null, usesPending: usage !== 'skip' && use === null ? true : undefined, settingsError }
}

/** The Context screen's rows; screenshot mode waits for the MCP tool calls to be counted. */
export const listContext = (waitForUsage = false): Promise<ContextList> => build(configDir(), waitForUsage ? 'wait' : 'last')

/* ------------------------------------------------------------------ switches */

/**
 * What a switch needs to put back (src/main/context/model.ts), per profile: `<userData>/context/<folder key>.json`
 * (`context.dev` in a git clone, like the archive), Claudock's own data, written directly.
 */
const memoDir = (): string => path.join(userDataDir(), installKind() === 'dev' ? 'context.dev' : 'context')
const switching = new Map<string, Promise<unknown>>()

async function setOn(dir: string, id: string, on: boolean): Promise<{ snapshotId: string | null; changed: boolean }> {
  // only the rows this screen offers a switch for
  const item = (await build(dir, 'skip')).items.find((i) => i.id === id)
  if (!item?.switchable) throw new Error('This item has no switch')
  const memoFile = `${folderKey(dir)}.json`
  const memo: SwitchMemo = memoOf(await tryReadJson<unknown>(path.join(memoDir(), memoFile)).then((r) => (r.ok ? r.value : null)))
  const skill = item.kind === 'skill'
  const key = id.slice(skill ? 'skill:'.length : 'mcp:'.length)
  const r = await updateSettings(
    (s) => {
      const field = skill ? 'skillOverrides' : 'deniedMcpServers'
      const { changed, next } = skill ? switchSkill(s.skillOverrides, key, on, memo) : switchServer(s.deniedMcpServers, key, on, memo)
      if (!changed) return false
      if (next === undefined) delete s[field]
      else s[field] = next
    },
    skill ? `${on ? 'Show' : 'Hide'} skill ${key} ${on ? 'to' : 'from'} Claude` : `Turn ${on ? 'on' : 'off'} MCP server ${key}`
  )
  if (r.changed) await writeOwn(memoFile, JSON.stringify(memo, null, 2) + '\n', 0o644, memoDir())
  return r
}

const impl: ContextApi = {
  list: () => listContext(),

  async text(id) {
    if (typeof id !== 'string') throw new Error('Unknown item')
    const dir = configDir()
    if (!texts.has(dir)) await build(dir, 'skip')
    const text = texts.get(dir)?.get(id)
    if (text === undefined) throw new Error('This item is no longer listed')
    return { id, text: text.slice(0, TEXT_CAP), truncated: text.length > TEXT_CAP }
  },

  setOn(id, on) {
    if (typeof id !== 'string' || typeof on !== 'boolean') return Promise.reject(new Error('Invalid switch'))
    // one switch at a time per folder: each reads and writes what the one before it remembered
    const dir = configDir()
    const p = (switching.get(dir) ?? Promise.resolve()).then(() => setOn(dir, id, on))
    switching.set(
      dir,
      p.catch(() => undefined)
    )
    return p
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'context', impl)
}

/** Sidebar badge: the estimate of what the setup adds to every session (no usage scan needed for it). */
export async function count(): Promise<string | undefined> {
  const l = await build(configDir(), 'skip')
  return l.items.some((i) => i.tokens !== null) ? formatEstimate(l.tokens) : undefined
}
