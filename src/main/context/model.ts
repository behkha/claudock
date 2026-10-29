import type { ContextItem } from '@shared/api/context'
import { estimateTokens } from '../../shared/api/context.ts'
import { isObj, type Json } from '../transcripts/parse.ts'

/**
 * The pure parts of the Context screen (src/main/domains/context.ts): what a session's transcript says Claude Code put
 * in context at its start, and the rows built from it. No Electron here, so `npm test` loads it as is.
 *
 * Claude Code records the start of every session as attachment lines: `skill_listing` (one `- name: description` line
 * per skill; `isInitial: false` adds to it), `deferred_tools_delta` (the tool names Claude sees before it searches for a
 * tool's schema, plus the servers that failed, need a login or are still connecting), `mcp_instructions_delta` (each
 * server's instructions block) and `instructions` (every CLAUDE.md and rules file it loaded, imports included).
 */

export type Missing = NonNullable<ContextItem['missing']>

export interface Records {
  /** Skill name (the skillOverrides key) -> its listing line. Null when the session has no listing. */
  skills: Map<string, string> | null
  /** Server key -> its tool names. Null when the session has no deferred tool list. */
  tools: Map<string, Set<string>> | null
  /** Server key -> its instructions block. */
  instructions: Map<string, string>
  /** Server key -> why it had no tools, from the newest tool list. */
  status: Map<string, Missing>
  /** Server key -> the server's name as Claude Code wrote it, where a record names it. */
  names: Map<string, string>
  /** The newest `instructions` record. */
  memory: MemoryRecord[] | null
}

export interface MemoryRecord {
  path: string
  /** "User", "Project", "Local", "Managed". */
  type: string
  content: string
}

export const emptyRecords = (): Records => ({ skills: null, tools: null, instructions: new Map(), status: new Map(), names: new Map(), memory: null })
export const hasRecords = (r: Records): boolean => r.skills !== null || r.tools !== null || r.memory !== null

/** The part of an MCP tool name Claude Code makes from the server's name: everything else becomes "_". */
export const mcpKey = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_')

/** `mcp__<server>__<tool>` -> the server key; null for any other tool. */
export function serverOfTool(tool: string): string | null {
  const m = /^mcp__(.+?)__./.exec(tool)
  return m ? m[1] : null
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

/** Listing lines are `- <name>` or `- <name>: <description>`; a plugin skill's name is `<plugin>:<skill>`. */
function listingLines(content: string): [string, string][] {
  const out: [string, string][] = []
  for (const line of content.split('\n')) {
    if (line.startsWith('- ')) {
      const i = line.indexOf(': ')
      out.push([i < 0 ? line.slice(2).trim() : line.slice(2, i), line])
    } else if (out.length && line.trim()) {
      out[out.length - 1][1] += '\n' + line
    }
  }
  return out
}

/** Add one transcript line to what is known about the session's start. Lines that are no attachment are ignored. */
export function foldRecord(r: Records, o: Json): void {
  const a = o.attachment
  if (!isObj(a)) return
  if (a.type === 'skill_listing' && typeof a.content === 'string') {
    if (a.isInitial !== false || r.skills === null) r.skills = new Map()
    for (const [name, line] of listingLines(a.content)) r.skills.set(name, line)
  } else if (a.type === 'deferred_tools_delta') {
    r.tools ??= new Map()
    for (const tool of [...strings(a.addedNames), ...strings(a.readdedNames)]) {
      const key = serverOfTool(tool)
      if (!key) continue
      let set = r.tools.get(key)
      if (!set) r.tools.set(key, (set = new Set()))
      set.add(tool)
    }
    for (const tool of strings(a.removedNames)) {
      const key = serverOfTool(tool)
      if (!key) continue
      const set = r.tools.get(key)
      set?.delete(tool)
      if (set?.size === 0) r.tools.delete(key)
    }
    const lists: [unknown, Missing][] = [
      [a.failedMcpServers, 'failed'],
      [a.needsAuthMcpServers, 'needs-auth'],
      [a.pendingMcpServers, 'pending']
    ]
    if (lists.some(([v]) => Array.isArray(v))) {
      r.status = new Map()
      for (const [v, state] of lists) {
        for (const name of strings(v)) {
          r.status.set(mcpKey(name), state)
          r.names.set(mcpKey(name), name)
        }
      }
    }
  } else if (a.type === 'mcp_instructions_delta') {
    const names = strings(a.addedNames)
    const blocks = Array.isArray(a.addedBlocks) ? a.addedBlocks : []
    names.forEach((name, i) => {
      if (typeof blocks[i] !== 'string') return
      r.instructions.set(mcpKey(name), blocks[i])
      r.names.set(mcpKey(name), name)
    })
    for (const name of strings(a.removedNames)) r.instructions.delete(mcpKey(name))
  } else if (a.type === 'instructions' && Array.isArray(a.files)) {
    const files = a.files
      .filter(isObj)
      .filter((f) => typeof f.path === 'string' && typeof f.content === 'string')
      .map((f) => ({ path: f.path as string, type: typeof f.type === 'string' ? f.type : '', content: f.content as string }))
    // `changed: true` lists only the files that changed since the record before it
    if (a.changed === true && r.memory) {
      const byPath = new Map(r.memory.map((f) => [f.path, f]))
      for (const f of files) byPath.set(f.path, f)
      r.memory = [...byPath.values()]
    } else r.memory = files
  }
}

/** The MCP tool calls in an assistant line: the server's key and the call's id (a resumed session repeats calls). */
export function mcpCalls(o: Json): { key: string; id: string }[] {
  if (o.type !== 'assistant' || !isObj(o.message) || !Array.isArray(o.message.content)) return []
  const out: { key: string; id: string }[] = []
  for (const b of o.message.content) {
    if (!isObj(b) || b.type !== 'tool_use' || typeof b.name !== 'string') continue
    const key = serverOfTool(b.name)
    if (key) out.push({ key, id: typeof b.id === 'string' ? b.id : '' })
  }
  return out
}

/* ------------------------------------------------------------------ skills */

/** How much of a skill Claude sees: all of its listing line, its name only, or nothing. */
export type SkillMode = 'full' | 'name' | 'none'

export function modeOf(override: unknown, disableModelInvocation = false): SkillMode {
  if (disableModelInvocation || override === 'off' || override === 'user-invocable-only') return 'none'
  return override === 'name-only' ? 'name' : 'full'
}

/** Claude Code caps each description in the listing at this many characters (`skillListingMaxDescChars`). */
export const MAX_DESC_CHARS = 1536

/** The listing line Claude Code writes for a skill. */
export function skillLine(name: string, description: string, mode: Exclude<SkillMode, 'none'>, maxDesc = MAX_DESC_CHARS): string {
  const d = description.replace(/\s+/g, ' ').trim().slice(0, maxDesc)
  return mode === 'name' || !d ? `- ${name}` : `- ${name}: ${d}`
}

/**
 * What Context keeps per profile so that turning something off and on again puts settings.json back as it was: the
 * value a skill had before it was hidden here (`on`, `name-only`), and the containers a switch created.
 */
export interface SwitchMemo {
  skills: Record<string, string>
  created: { skillOverrides?: boolean; deniedMcpServers?: boolean }
}

export const emptyMemo = (): SwitchMemo => ({ skills: {}, created: {} })

export function memoOf(v: unknown): SwitchMemo {
  const m = emptyMemo()
  if (!isObj(v)) return m
  if (isObj(v.skills)) for (const [k, x] of Object.entries(v.skills)) if (typeof x === 'string') m.skills[k] = x
  if (isObj(v.created)) {
    if (v.created.skillOverrides === true) m.created.skillOverrides = true
    if (v.created.deniedMcpServers === true) m.created.deniedMcpServers = true
  }
  return m
}

const hidden = (v: unknown): boolean => v === 'off' || v === 'user-invocable-only'

/**
 * `skillOverrides` after switching `key` here (updates `memo`): off writes `user-invocable-only` (/name still works),
 * on puts back what it replaced, or removes the key. `next` undefined: drop the container, which a switch created.
 */
export function switchSkill(overrides: unknown, key: string, on: boolean, memo: SwitchMemo): { changed: boolean; next: Record<string, unknown> | undefined } {
  const had = isObj(overrides)
  const cur: Record<string, unknown> = had ? { ...overrides } : {}
  const prev = cur[key]
  if (on === !hidden(prev)) return { changed: false, next: had ? cur : undefined }
  if (!on) {
    if (typeof prev === 'string') memo.skills[key] = prev
    else delete memo.skills[key]
    if (!had) memo.created.skillOverrides = true
    cur[key] = 'user-invocable-only'
    return { changed: true, next: cur }
  }
  const back = prev === 'user-invocable-only' ? memo.skills[key] : undefined
  delete memo.skills[key]
  if (back === undefined) delete cur[key]
  else cur[key] = back
  if (Object.keys(cur).length === 0 && memo.created.skillOverrides) {
    delete memo.created.skillOverrides
    return { changed: true, next: undefined }
  }
  return { changed: true, next: cur }
}

/* ------------------------------------------------------------------ MCP servers */

/** Server names in settings.json `deniedMcpServers` (the `{ serverName }` entries; the others match by command or URL). */
export function deniedNames(v: unknown): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(v)) for (const e of v) if (isObj(e) && typeof e.serverName === 'string') out.add(e.serverName)
  return out
}

/** `deniedMcpServers` with `name` added or removed. */
export function withDenied(v: unknown, name: string, denied: boolean): unknown[] {
  const list = Array.isArray(v) ? v : []
  const has = (e: unknown): boolean => isObj(e) && e.serverName === name && Object.keys(e).length === 1
  return denied ? (list.some(has) ? list : [...list, { serverName: name }]) : list.filter((e) => !has(e))
}

/** `deniedMcpServers` after switching server `name` here (updates `memo`); `next` undefined: drop the list a switch created. */
export function switchServer(denied: unknown, name: string, on: boolean, memo: SwitchMemo): { changed: boolean; next: unknown[] | undefined } {
  const had = Array.isArray(denied)
  if (on === !deniedNames(denied).has(name)) return { changed: false, next: had ? (denied as unknown[]) : undefined }
  const next = withDenied(denied, name, !on)
  if (!on && !had) memo.created.deniedMcpServers = true
  if (on && next.length === 0 && memo.created.deniedMcpServers) {
    delete memo.created.deniedMcpServers
    return { changed: true, next: undefined }
  }
  return { changed: true, next }
}

/** Where a server Claudock did not find in .claude.json comes from, and its name without the prefix that says so. */
export function serverSource(key: string, raw: string | undefined, projectKeys: Set<string>): { name: string; source: string } {
  const name = raw ?? key
  const plugin = /^plugin:([^:]+):(.+)$/.exec(name)
  if (plugin) return { name: plugin[2], source: plugin[1] }
  if (name.startsWith('claude.ai ')) return { name: name.slice('claude.ai '.length), source: 'claude.ai' }
  if (key.startsWith('claude_ai_')) return { name: raw ?? key.slice('claude_ai_'.length), source: 'claude.ai' }
  if (key.startsWith('plugin_')) return { name, source: 'plugin' }
  return { name, source: projectKeys.has(key) ? 'project' : '' }
}

/* ------------------------------------------------------------------ rows */

export interface KnownSkill {
  /** Its id on the Skills screen. */
  id: string
  key: string
  name: string
  source: string
  description: string
  /** Claude Code lists it at all: its plugin is on and its SKILL.md doesn't say `disable-model-invocation`. */
  loads: boolean
}

export interface KnownServer {
  name: string
  source: string
}

export interface MemoryFile {
  /** As Claude Code names it. */
  path: string
  name: string
  text: string
  fromSession: boolean
  /** Its id on CLAUDE.md & rules, when it is one of the files listed there. */
  rulesId?: string
}

export interface BuildInput {
  /** User and plugin skills (synced ones load only in the Claude app's sessions, under `<prefix>:<name>`). */
  skills: KnownSkill[]
  /** Names of the synced skills: a listed `<prefix>:<name>` with one of them is that skill. */
  synced: Set<string>
  overrides: Record<string, unknown>
  /** .claude.json `skillUsage`: `{ <name>: { usageCount, lastUsedAt } }`. */
  skillUsage: unknown
  /** The user servers in .claude.json. */
  servers: KnownServer[]
  /** Keys of the project servers in .claude.json. */
  projectKeys: Set<string>
  denied: Set<string>
  records: Records | null
  /** Server key -> tool calls in the last 30 days. */
  mcpUse: Map<string, { count: number; last: number }>
  memory: MemoryFile[]
}

const lenOf = (line: string): number => line.length + 1
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** Claude Code keys `skillUsage` like `skillOverrides`: the name, or `<plugin>:<name>`. */
function usageOf(all: unknown, key: string): { uses?: number; lastUsedAt?: number } {
  const u = isObj(all) ? all[key] : undefined
  return isObj(u) ? { uses: num(u.usageCount), lastUsedAt: num(u.lastUsedAt) } : {}
}

function measured(chars: number | null, from: ContextItem['measured']): Pick<ContextItem, 'chars' | 'tokens' | 'measured'> {
  return { chars, tokens: chars === null ? null : estimateTokens(chars), measured: chars === null ? null : from }
}

function skillItems(input: BuildInput): ContextItem[] {
  const listed = input.records?.skills ?? null
  const out: ContextItem[] = []
  const seen = new Set<string>()
  const row = (key: string, name: string, source: string, mode: SkillMode, fallback: string | null, openId?: string, switchable = true): ContextItem => {
    const override = typeof input.overrides[key] === 'string' ? (input.overrides[key] as string) : undefined
    const line = listed?.get(key)
    let size: Pick<ContextItem, 'chars' | 'tokens' | 'measured'>
    if (mode === 'none') size = measured(0, null)
    else if (mode === 'full' && line !== undefined) size = measured(lenOf(line), 'session')
    else if (mode === 'name') size = measured(lenOf(skillLine(key, '', 'name')), listed?.has(key) ? 'session' : 'files')
    else size = measured(fallback === null ? null : lenOf(fallback), 'files')
    const open = openId ? { open: { screen: 'skills' as const, id: openId } } : {}
    return { id: `skill:${key}`, kind: 'skill', name, source, on: mode !== 'none', switchable, override, ...size, ...usageOf(input.skillUsage, key), ...open }
  }
  for (const s of input.skills) {
    if (seen.has(s.key)) continue
    seen.add(s.key)
    // a skill that won't load (its plugin is off, or Claude never sees it on its own) adds nothing and has nothing to switch
    if (!s.loads) continue
    const mode = modeOf(input.overrides[s.key])
    out.push(row(s.key, s.name, s.source, mode, mode === 'none' ? null : skillLine(s.key, s.description, mode), s.id))
  }
  // the session listed skills Claudock doesn't keep (Claude Code's own, a project's, a plugin's installed elsewhere): its line is all there is
  for (const key of listed?.keys() ?? []) {
    if (seen.has(key)) continue
    seen.add(key)
    const i = key.indexOf(':')
    const name = i < 0 ? key : key.slice(i + 1)
    // a synced skill: switched on the Skills screen, whose key for it is the bare name
    if (i >= 0 && input.synced.has(name)) {
      out.push(row(key, name, 'synced', modeOf(input.overrides[key] ?? input.overrides[name]), null, undefined, false))
      continue
    }
    out.push(row(key, name, i < 0 ? '' : key.slice(0, i), modeOf(input.overrides[key]), null))
  }
  return out
}

function serverItems(input: BuildInput): ContextItem[] {
  const r = input.records
  const out: ContextItem[] = []
  const seen = new Set<string>()
  const size = (key: string, on: boolean): Pick<ContextItem, 'chars' | 'tokens' | 'measured' | 'missing' | 'tools'> => {
    const tools = r?.tools?.get(key)
    const toolCount = tools ? { tools: tools.size } : {}
    if (!on) return { ...measured(0, null), ...toolCount }
    const status = r?.status.get(key)
    if (status && !tools) return { ...measured(null, null), missing: status }
    const block = r?.instructions.get(key)
    // without a tool list (tool search off, or a Claude Code that doesn't record it) the tools can't be measured
    if (!r || r.tools === null || (!tools && block === undefined)) return { ...measured(null, null), missing: 'not-seen', ...toolCount }
    let chars = block === undefined ? 0 : block.length + 2
    for (const t of tools ?? []) chars += lenOf(t)
    return { ...measured(chars, 'session'), ...toolCount }
  }
  const usage = (key: string): { uses: number; lastUsedAt?: number } => {
    const u = input.mcpUse.get(key)
    return u ? { uses: u.count, lastUsedAt: u.last } : { uses: 0 }
  }
  for (const s of input.servers) {
    const key = mcpKey(s.name)
    if (seen.has(key)) continue
    seen.add(key)
    const on = !input.denied.has(s.name)
    out.push({ id: `mcp:${s.name}`, kind: 'mcp', name: s.name, source: s.source, on, switchable: true, ...size(key, on), ...usage(key), open: { screen: 'mcp', id: `user:${s.name}` } })
  }
  // turned off here, but no longer in .claude.json: still listed, so it can be turned back on
  for (const name of input.denied) {
    const key = mcpKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: `mcp:${name}`, kind: 'mcp', name, source: '', on: false, switchable: true, ...size(key, false), ...usage(key) })
  }
  // what else the session loaded: plugins, claude.ai connectors, a project's servers, ones the app running Claude Code adds
  const others = new Set<string>([...(r?.tools?.keys() ?? []), ...(r?.instructions.keys() ?? []), ...(r?.status.keys() ?? [])])
  for (const key of others) {
    if (seen.has(key)) continue
    seen.add(key)
    const { name, source } = serverSource(key, r?.names.get(key), input.projectKeys)
    out.push({ id: `mcp:${r?.names.get(key) ?? key}`, kind: 'mcp', name, source, on: true, switchable: false, ...size(key, true), ...usage(key) })
  }
  return out
}

function memoryItems(input: BuildInput): ContextItem[] {
  return input.memory.map((m) => ({
    id: `memory:${m.path}`,
    kind: 'memory' as const,
    name: m.name,
    source: '',
    on: true,
    switchable: false,
    ...measured(m.text.length, m.fromSession ? 'session' : 'files'),
    ...(m.rulesId ? { open: { screen: 'rules' as const, id: m.rulesId } } : {})
  }))
}

/** Every row: the ones in context by estimate (most first, unmeasured after), then the ones turned off by name. */
export function buildItems(input: BuildInput): ContextItem[] {
  const all = [...serverItems(input), ...skillItems(input), ...memoryItems(input)]
  const rank = (i: ContextItem): number => (!i.on ? -2 : i.tokens === null ? -1 : i.tokens)
  return all.sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name))
}

export const totalTokens = (items: ContextItem[]): number => items.reduce((n, i) => n + (i.on && i.tokens !== null ? i.tokens : 0), 0)
