import { BrowserWindow, clipboard, dialog, shell, type IpcMain } from 'electron'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { estimateTokens, type ContextItem } from '@shared/api/context'
import {
  marketplaceNameProblem,
  pluginNameProblem,
  slugName,
  type Finding,
  type Fix,
  type FolderOffer,
  type Review,
  type ReviewFile,
  type StaysRow,
  type TeamApi,
  type TeamDiff,
  type TeamItem,
  type TeamItemState,
  type TeamJoined,
  type JoinedItem,
  type TeamMembers,
  type TeamKind,
  type TeamProject,
  type TeamRemote,
  type TeamSetup,
  type TeamState,
  type Written
} from '@shared/api/team'
import { parseFrontmatter } from '@shared/frontmatter'
import { folderKey, writeOwn } from '../connect/folder'
import { tryReadJson } from '../fsx'
import { defineDomain } from '../ipcx'
import { configDir, globalStateFile, installKind, isInside, isSecret, samePath, userDataDir } from '../paths'
import { safeWriteText, trash } from '../safeWrite'
import {
  MAX_SCRIPT_BYTES,
  MANIFEST_NAME,
  canonical,
  parseManifest,
  buildOut,
  buildPlan,
  fixProblem,
  findingsFor,
  hookScriptToken,
  isChange,
  isObj,
  isPointed,
  isOpen,
  joinCommands,
  maskSecrets,
  planToken,
  pluginDir,
  pointerText,
  unpointerText,
  repoHook,
  repoSha,
  sendCommand,
  sha256,
  stateOf,
  suggestKey,
  textOf,
  type ItemOut,
  type JsonObj,
  type ManifestItem,
  type Manifest,
  type Plan,
  type PlanItem,
  type RepoView,
  type SrcFile,
  type Source
} from '../team/model'
import { existingNames, gitDirOf, readPluginFolder, readRemote, readRepo, readRepoFile } from '../team/repo'
import { devAllowed, readText, writeFiles, writeOne, type WriteGuard } from '../team/write'
import { listContext } from './context'
import { collectMd, enabledMap, installedPlugins, readSettings, toPosix, type PluginRecord } from './extendShared'
import { ourHookCommands } from './sessions'
import { listProjectSummaries } from './projects'
import { scanUser } from './skills'

/**
 * The Team screen (Team mode, decisions in docs/SPEC.md): the open profile's own skills, agents, commands, hooks and MCP
 * servers, ticked and written as a Claude Code plugin plus marketplace into a git repo folder the user picked. The pure
 * parts are in src/main/team/model.ts, reading the folder in repo.ts, the guarded writer in write.ts. Claudock never
 * runs git or Claude Code here and never goes on the network.
 *
 * Per profile, Claudock's own data: `<userData>/team/<folder key>.json` (`team.dev` in a git clone), written directly
 * like prefs.json: the folder, the names, the ticks and fixes, connected projects and the last write.
 */

const SHOT = process.env.CLAUDOCK_SHOT === '1'
const DAY = 86_400_000
const DIFF_CAP = 200_000
const SKILL_READ_CAP = 64 * 1024 * 1024

/* ------------------------------------------------------------------ store */

interface Store {
  v: 1
  dir: string
  marketplace: string
  plugin: string
  owner: string
  ticked: string[]
  fixes: Record<string, Fix[]>
  projects: string[]
  sentAt?: number
  /** The send line of the last write, for Copy. */
  send?: string
  /** Connected projects whose settings.json Claudock made: Disconnect takes it away again when nothing else is in it. */
  created?: string[]
}

const storeDir = (): string => path.join(userDataDir(), installKind() === 'dev' ? 'team.dev' : 'team')
const storeFile = (dir: string): string => `${folderKey(dir)}.json`

function parseStore(v: unknown): Store | null {
  if (!isObj(v) || v.v !== 1 || typeof v.dir !== 'string' || typeof v.marketplace !== 'string' || typeof v.plugin !== 'string') return null
  const fixes: Record<string, Fix[]> = {}
  if (isObj(v.fixes)) for (const [k, list] of Object.entries(v.fixes)) if (Array.isArray(list)) fixes[k] = list.filter((f) => isObj(f) && typeof f.kind === 'string' && typeof f.where === 'string') as unknown as Fix[]
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])
  return {
    v: 1,
    dir: v.dir,
    marketplace: v.marketplace,
    plugin: v.plugin,
    owner: typeof v.owner === 'string' ? v.owner : '',
    ticked: strings(v.ticked),
    fixes,
    projects: strings(v.projects),
    ...(typeof v.sentAt === 'number' ? { sentAt: v.sentAt } : {}),
    ...(typeof v.send === 'string' ? { send: v.send } : {}),
    created: strings(v.created)
  }
}

async function loadStore(dir: string): Promise<Store | null> {
  const r = await tryReadJson<unknown>(path.join(storeDir(), storeFile(dir)))
  return r.ok ? parseStore(r.value) : null
}

const saveStore = (dir: string, s: Store): Promise<void> => writeOwn(storeFile(dir), JSON.stringify(s, null, 2) + '\n', 0o644, storeDir())

/** Every change to a profile's team runs one at a time. */
const chains = new Map<string, Promise<unknown>>()
function serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(dir) ?? Promise.resolve()).then(fn, fn)
  chains.set(
    dir,
    next.catch(() => undefined)
  )
  return next
}

/* ------------------------------------------------------------------ guard */

const guard: WriteGuard = {
  allowed: (dir) => devAllowed(dir, { readonly: process.env.CLAUDOCK_READONLY === '1', dev: installKind() === 'dev', allowReal: process.env.CLAUDOCK_ALLOW_REAL_WRITES === '1' }),
  // screenshots write into a temp copy: what they take away is not worth a place in this Mac's Trash
  trash: (abs) => (SHOT ? fsp.rm(abs) : shell.trashItem(abs))
}

/* ------------------------------------------------------------------ what can travel */

interface Row {
  src: Source
  detail: string
  /** The text Claude Code lists it by, for an estimate when no session measured it. */
  listing: string | null
  open?: TeamItem['open']
}

/** File contents read before, by path, while size and time are the same. */
const fileCache = new Map<string, { size: number; mtimeMs: number; data: Uint8Array }>()
async function readCached(abs: string): Promise<Uint8Array | null> {
  const st = await fsp.stat(abs).catch(() => null)
  if (!st?.isFile()) return null
  const hit = fileCache.get(abs)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.data
  const data = await fsp.readFile(abs).catch(() => null)
  if (!data) return null
  fileCache.set(abs, { size: st.size, mtimeMs: st.mtimeMs, data })
  return data
}

/** Every plain file of a skill folder (links inside it are not followed), and the total size. */
async function skillFiles(dir: string): Promise<{ files: SrcFile[]; bytes: number }> {
  const files: SrcFile[] = []
  let bytes = 0
  async function walk(abs: string, rel: string): Promise<void> {
    const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === '.DS_Store' || e.name === '.git' || e.name === 'node_modules') continue
      const full = path.join(abs, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(full, r)
      else if (e.isFile() && !isSecret(full)) {
        const st = await fsp.stat(full).catch(() => null)
        if (!st) continue
        bytes += st.size
        if (bytes > SKILL_READ_CAP) continue
        const data = await readCached(full)
        if (data) files.push({ rel: r, data })
      }
    }
  }
  await walk(dir, '')
  return { files, bytes }
}

/**
 * Where a hook's script is read from. `~/.claude/…` means the open folder when it is another one (as the Hooks screen
 * reads it). A development build reads only beside the open folder (the fixture), never from a real home folder.
 */
function scriptReadPath(abs: string, home: string): string | null {
  const dotClaude = path.join(home, '.claude')
  let at = abs
  if (!samePath(configDir(), dotClaude) && isInside(dotClaude, abs)) at = path.join(configDir(), path.relative(dotClaude, abs))
  if (isSecret(at)) return null
  if (installKind() === 'dev' && process.env.CLAUDOCK_ALLOW_REAL_WRITES !== '1' && !isInside(path.dirname(configDir()), at)) return null
  return at
}

const listingLine = (name: string, description: string): string => `- ${name}: ${description.slice(0, 1536)}`
const descriptionOf = (data: Uint8Array): string => {
  const d = parseFrontmatter(textOf(data.slice(0, 32 * 1024)) ?? '').data.description
  return (Array.isArray(d) ? d.join(' ') : (d ?? '')).toString().trim()
}

async function collect(home: string): Promise<{ rows: Row[]; settings: Record<string, unknown> }> {
  const dir = configDir()
  const { data: settings } = await readSettings()
  const rows: Row[] = []

  // skills: the folder's own (synced and plugin skills are someone else's)
  const overrides = isObj(settings.skillOverrides) ? (settings.skillOverrides as Record<string, unknown>) : {}
  for (const s of await scanUser(overrides)) {
    const folder = path.basename(s.dir)
    const { files, bytes } = s.symlink ? { files: [], bytes: 0 } : await skillFiles(s.dir)
    rows.push({
      src: { kind: 'skill', id: `skill:${folder}`, name: folder, files, link: s.symlink, bytes },
      detail: 'skill',
      listing: listingLine(s.key, s.description),
      open: { screen: 'skills', id: s.id }
    })
  }

  // agents and commands: Markdown files, a command's folder part of its name (review/pr.md is /review:pr)
  for (const kind of ['agent', 'command'] as const) {
    const root = path.join(dir, `${kind}s`)
    for (const ref of await collectMd(root, { maxDepth: kind === 'agent' ? 3 : 4 })) {
      const data = await readCached(ref.abs)
      if (!data || isSecret(ref.abs)) continue
      const rel = toPosix(path.relative(root, ref.abs))
      const name = ref.name.split('/').join(':')
      rows.push({
        src: { kind, id: `${kind}:${name}`, name, rel, data },
        detail: kind,
        listing: listingLine(kind === 'command' ? `/${name}` : name, descriptionOf(data)),
        open: { screen: `${kind}s` as 'agents' | 'commands', id: ref.rel }
      })
    }
  }

  // hooks of settings.json, Claudock's own left out
  const ours = ourHookCommands()
  const connectRoot = path.join(userDataDir(), 'connect')
  const hooks = isObj(settings.hooks) ? settings.hooks : {}
  const seen = new Set<string>()
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((g, gi) => {
      if (!isObj(g) || !Array.isArray(g.hooks)) return
      const matcher = typeof g.matcher === 'string' ? g.matcher : null
      g.hooks.forEach((h, hi) => {
        if (!isObj(h)) return
        const commandKey = typeof h.command === 'string' ? 'command' : typeof h.prompt === 'string' ? 'prompt' : null
        if (!commandKey) return
        const text = h[commandKey] as string
        if (commandKey === 'command' && (ours.has(text) || text.includes(connectRoot))) return
        const id = `hook:${event}:${matcher ?? ''}:${sha256(text).slice(0, 8)}`
        if (seen.has(id)) return
        seen.add(id)
        const tok = commandKey === 'command' ? hookScriptToken(text, home) : null
        rows.push({
          src: { kind: 'hook', id, name: tok ? path.basename(tok.abs) : text.replace(/\s+/g, ' ').trim().slice(0, 48), event, matcher, entry: h as JsonObj, commandKey, script: tok ? { ...tok, file: false, data: null } : null },
          detail: `hook · ${event}`,
          listing: null,
          open: { screen: 'hooks', id: `settings.json|${event}:${gi}:${hi}` }
        })
      })
    })
  }
  for (const r of rows) {
    if (r.src.kind !== 'hook' || !r.src.script) continue
    const at = scriptReadPath(r.src.script.abs, home)
    const st = at ? await fsp.stat(at).catch(() => null) : null
    if (at && st?.isFile() && st.size <= MAX_SCRIPT_BYTES) {
      const data = await readCached(at)
      if (data) r.src.script = { ...r.src.script, file: true, data }
    }
  }

  // MCP servers of the user scope (a project's are that project's)
  const state = await tryReadJson<unknown>(globalStateFile()).then((x) => (x.ok && isObj(x.value) ? x.value : {}))
  if (isObj(state.mcpServers)) {
    for (const [name, config] of Object.entries(state.mcpServers)) {
      if (!isObj(config)) continue
      rows.push({ src: { kind: 'mcp', id: `mcp:${name}`, name, config }, detail: 'MCP', listing: null, open: { screen: 'mcp', id: `user:${name}` } })
    }
  }
  return { rows, settings }
}

/* ------------------------------------------------------------------ the whole picture */

interface Built {
  store: Store | null
  setup: TeamSetup | null
  remote: TeamRemote | null
  view: RepoView
  rows: Row[]
  items: TeamItem[]
  /** Findings of ticked items, the review's "Fix first". */
  findings: Finding[]
  outs: Map<string, ItemOut>
  plan: Plan | null
  states: Map<string, TeamItemState | null>
  stays: StaysRow[]
  context: ContextItem[]
  home: string
  projects: TeamProject[]
  joined: Joined | null
}

const KIND_ORDER: TeamKind[] = ['mcp', 'skill', 'agent', 'command', 'hook']

/** Items used in the last 30 days, plus agents and commands (nothing counts their use): the first ticks. */
function firstTicks(items: TeamItem[], now: number): string[] {
  return items.filter((i) => i.kind === 'agent' || i.kind === 'command' || (i.kind !== 'hook' && !!i.uses && !!i.lastUsedAt && now - i.lastUsedAt <= 30 * DAY)).map((i) => i.id)
}

/** What each fix button fills in: a `userConfig` key, a variable's name, the script's name in `bin/`. */
function withValues(src: Source, f: Finding): Finding {
  const key = suggestKey(src.name, f.where)
  const script = src.kind === 'hook' && src.script ? path.basename(src.script.abs).replace(/[^A-Za-z0-9._-]/g, '-') : ''
  return {
    ...f,
    choices: f.choices.map((c) => (c.kind === 'ask' ? { ...c, value: key } : c.kind === 'env' ? { ...c, value: key.toUpperCase() } : c.kind === 'copy-script' ? { ...c, value: script || 'script' } : c))
  }
}

function bothFinding(src: Source, fixes: Fix[]): Finding {
  const theirs = src.kind === 'skill' || src.kind === 'agent' || src.kind === 'command'
  const fix = fixes.find((f) => f.kind === 'mine' && f.where === 'item')
  return {
    key: `${src.id}|both|item`,
    itemId: src.id,
    itemName: src.name,
    code: 'both',
    where: 'item',
    text: 'Changed here and in the repo',
    blocks: true,
    choices: [{ kind: 'mine', label: 'Use mine' }, ...(theirs ? [{ kind: 'theirs' as const, label: "Take the repo's" }] : [])],
    ...(fix ? { fix } : {})
  }
}

async function build(opts: { context: boolean }): Promise<Built> {
  const dir = configDir()
  const home = os.homedir()
  const store = await loadStore(dir)
  const [{ rows, settings }, ctx] = await Promise.all([collect(home), opts.context ? listContext().catch(() => null) : Promise.resolve(null)])
  const context = ctx?.items ?? []
  const ctxById = new Map(context.map((i) => [i.id, i]))

  let setup: TeamSetup | null = null
  let remote: TeamRemote | null = null
  let view: RepoView = { files: new Map(), manifest: null, readme: false }
  if (store) {
    const isRepo = (await gitDirOf(store.dir)) !== null
    remote = isRepo ? await readRemote(store.dir) : null
    if (isRepo) view = await readRepo(store.dir, store.plugin)
    setup = { dir: store.dir, marketplace: store.marketplace, plugin: store.plugin, owner: store.owner, remote, sentAt: store.sentAt ?? null, missing: !isRepo }
  }
  const ticked = new Set(store?.ticked ?? [])
  const recs = new Map((view.manifest?.items ?? []).map((r) => [r.id, r]))

  // skill keys in the Context screen are the skill's own name; the folder is the plugin's
  const skillKey = new Map<string, string>()
  for (const r of rows) if (r.src.kind === 'skill' && r.listing) skillKey.set(r.src.id, r.listing.slice(2, r.listing.indexOf(':')))

  const items: TeamItem[] = []
  const findings: Finding[] = []
  const outs = new Map<string, ItemOut>()
  const states = new Map<string, TeamItemState | null>()
  const planItems: PlanItem[] = []
  for (const r of rows) {
    const { src } = r
    const fixes = store?.fixes[src.id] ?? []
    const out = buildOut(src, fixes)
    outs.set(src.id, out)
    const rec = recs.get(src.id) ?? null
    const on = ticked.has(src.id)
    const state = store ? stateOf(on, out, rec, view) : null
    states.set(src.id, state)
    const f = findingsFor(src, fixes, home).map((x) => withValues(src, x))
    if (state === 'changed-both') f.push(bothFinding(src, fixes))
    if (on) {
      findings.push(...f)
      if (state === 'changed-repo') planItems.push({ out, mode: 'keep' })
      else if (f.some(isOpen)) {
        // nothing unsafe is ever put in a plan: what the repo has stays until it is fixed
        if (rec) planItems.push({ out, mode: 'keep' })
      } else planItems.push({ out, mode: 'write' })
    }
    const c = ctxById.get(src.kind === 'skill' ? `skill:${skillKey.get(src.id) ?? src.name}` : src.id)
    const tokens = c && c.on && c.tokens !== null ? c.tokens : r.listing ? estimateTokens(r.listing.length) : src.kind === 'hook' ? 0 : null
    const open = f.find((x) => !x.fix)
    const tools = src.kind === 'mcp' && c?.tools !== undefined ? ` · ${c.tools} tool${c.tools === 1 ? '' : 's'}` : ''
    items.push({
      id: src.id,
      kind: src.kind,
      name: src.name,
      detail: r.detail + tools,
      ticked: on,
      state,
      tokens,
      ...(c?.uses !== undefined ? { uses: c.uses } : {}),
      ...(c?.lastUsedAt !== undefined ? { lastUsedAt: c.lastUsedAt } : {}),
      ...(open ? { problem: { text: open.text, blocks: open.blocks } } : {}),
      ...(r.open ? { open: r.open } : {})
    })
  }
  // what Claudock wrote before for items this folder no longer has: they go at the next write
  for (const rec of recs.values()) {
    if (outs.has(rec.id)) continue
    const state = stateOf(ticked.has(rec.id), null, rec, view)
    states.set(rec.id, state)
    if (state) items.push({ id: rec.id, kind: rec.kind, name: rec.name, detail: rec.hook ? `hook · ${rec.hook.event}` : rec.kind === 'mcp' ? 'MCP' : rec.kind, ticked: false, state, tokens: null })
  }
  // skills, agents and commands someone else put in the plugin: only the repo has them (or only the repo has them ticked)
  for (const { kind, name } of repoOnlyOf(view)) {
    const id = `${kind}:${name}`
    if (recs.has(id) || (ticked.has(id) && outs.has(id))) continue
    states.set(id, 'repo-only')
    const mine = items.find((i) => i.id === id)
    if (mine) mine.state = 'repo-only'
    else items.push({ id, kind, name, detail: kind, ticked: false, state: 'repo-only', tokens: null })
  }
  items.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name))

  const plan = store && setup && !setup.missing ? buildPlan(store, planItems, view, remote) : null

  // what a plugin cannot carry
  const stays: StaysRow[] = []
  for (const c of context) if (c.kind === 'memory' && c.open?.screen === 'rules') stays.push({ name: c.name, reason: c.name === 'CLAUDE.md' ? 'Claude Code loads it only from your folder or a project' : 'Claude Code loads rules only from your folder or a project', tokens: c.tokens })
  if (!context.length && opts.context) {
    // no session to measure: the files themselves
    try {
      const text = await fsp.readFile(path.join(dir, 'CLAUDE.md'), 'utf8')
      stays.push({ name: 'CLAUDE.md', reason: 'Claude Code loads it only from your folder or a project', tokens: estimateTokens(text.length) })
    } catch {
      /* none */
    }
  }
  const has = (v: unknown): boolean => (isObj(v) ? Object.keys(v).length > 0 : v !== undefined && v !== null && v !== '')
  if (has(settings.permissions)) stays.push({ name: 'Permissions', reason: "A plugin's settings cannot set them", tokens: null })
  if (has(settings.model) || has(settings.effortLevel)) stays.push({ name: 'Model and effort', reason: "A plugin's settings cannot set them", tokens: null })
  if (has(settings.env)) stays.push({ name: 'Environment variables', reason: "A plugin's settings cannot set them", tokens: null })

  const projects = store && opts.context ? await projectsOf(store) : []
  const joined = await joinedOf(settings, ctxById, opts.context)
  return { store, setup, remote, view, rows, items, findings, outs, plan, states, stays, context, home, projects, joined }
}

/** The skills, agents and commands the plugin folder holds, by the names their files give them. */
function repoOnlyOf(view: RepoView): { kind: 'skill' | 'agent' | 'command'; name: string }[] {
  const out = new Map<string, { kind: 'skill' | 'agent' | 'command'; name: string }>()
  for (const rel of view.files.keys()) {
    const sk = /^skills\/([^/]+)\/.+/.exec(rel)
    if (sk) out.set(`skill:${sk[1]}`, { kind: 'skill', name: sk[1] })
    const md = /^(agents|commands)\/(.+)\.md$/i.exec(rel)
    if (md) {
      const kind = md[1] === 'agents' ? 'agent' : 'command'
      const name = md[2].split('/').join(':')
      out.set(`${kind}:${name}`, { kind, name })
    }
  }
  return [...out.values()]
}

/** The plugin-relative files the repo holds for an item. */
function repoRels(view: RepoView, kind: TeamKind, name: string, rec: ManifestItem | null): string[] {
  if (kind === 'skill') return [...view.files.keys()].filter((r) => r.startsWith(`skills/${name}/`))
  if (rec) return rec.files.filter((r) => view.files.has(r))
  if (kind !== 'agent' && kind !== 'command') return []
  const want = `${kind}s/${name.split(':').join('/')}.md`.toLowerCase()
  return [...view.files.keys()].filter((r) => r.toLowerCase() === want)
}

/* ------------------------------------------------------------------ review */

async function reviewOf(b: Built): Promise<{ review: Review; files: ReviewFile[] }> {
  if (!b.store || !b.plan) return { review: { findings: b.findings, files: [], canWrite: false, token: '' }, files: [] }
  const root = pluginDir(b.store.plugin)
  const files: ReviewFile[] = []
  for (const [rel, data] of b.plan.writes) {
    const inPlugin = rel.startsWith(`${root}/`) && rel !== `${root}/.claudock.json`
    const before = inPlugin ? (b.view.files.get(rel.slice(root.length + 1)) ?? null) : await readRepoFile(b.store.dir, rel).then((d) => (d ? sha256(d) : null))
    if (before === null) files.push({ rel, change: 'add' })
    else if (before !== sha256(data)) files.push({ rel, change: 'change' })
  }
  for (const rel of b.plan.removes) if (await readRepoFile(b.store.dir, rel)) files.push({ rel, change: 'remove' })
  files.sort((x, y) => (x.rel < y.rel ? -1 : 1))
  const open = b.findings.some(isOpen)
  const canWrite = !open && files.length > 0 && guard.allowed(b.store.dir)
  return { review: { findings: b.findings, files, canWrite, token: planToken(b.plan) }, files }
}

/* ------------------------------------------------------------------ state for the screen */

function toState(b: Built): TeamState {
  const tickedItems = b.items.filter((i) => i.ticked)
  const changes = b.items.filter((i) => (i.ticked || i.state === 'removed') && isChange(i.state)).length
  const asks = [...b.outs.values()].some((o) => o.userConfig && b.store?.ticked.includes(o.id))
  return {
    setup: b.setup,
    items: b.items,
    stays: b.stays,
    tokens: tickedItems.reduce((n, i) => n + (i.tokens ?? 0), 0),
    changes,
    join: b.store && b.remote ? joinCommands(b.store, b.remote, asks) : null,
    projects: b.projects,
    joined: b.joined?.view ?? null,
    writable: b.store ? guard.allowed(b.store.dir) : true
  }
}

const get = (): Promise<TeamState> => build({ context: true }).then(toState)

/* ------------------------------------------------------------------ a team someone else wrote */

interface Joined {
  view: TeamJoined
  plugin: PluginRecord
  now: RepoView
  /** The version before this one, while Claude Code keeps its folder. */
  before: RepoView | null
  beforeDir: string | null
}

/** The last two manifests seen of a profile's team plugin, so "What changed" outlives Claude Code's cleanup of old folders. */
interface Seen {
  key: string
  seen: Manifest
  before: Manifest | null
}
const seenFile = (dir: string): string => `${folderKey(dir)}.joined.json`

async function sourceOf(marketplace: string): Promise<string> {
  const r = await tryReadJson<unknown>(path.join(configDir(), 'plugins', 'known_marketplaces.json'))
  const m = r.ok && isObj(r.value) && isObj(r.value[marketplace]) ? r.value[marketplace] : null
  const src = m && isObj(m.source) ? m.source : null
  if (!src) return marketplace
  for (const k of ['repo', 'url', 'path']) if (typeof src[k] === 'string') return src[k] as string
  return marketplace
}

/** The listing line of a skill, agent or command in a plugin folder, for an estimate. */
async function listingIn(root: string, rec: ManifestItem, plugin: string): Promise<number | null> {
  if (rec.kind === 'hook') return 0
  if (rec.kind === 'mcp') return null
  const rel = rec.kind === 'skill' ? (rec.files.find((f) => /\/SKILL\.md$/i.test(f)) ?? rec.files[0]) : rec.files[0]
  if (!rel) return null
  const data = await readCached(path.join(root, ...rel.split('/')))
  if (!data) return null
  return estimateTokens(listingLine(`${plugin}:${rec.name}`, descriptionOf(data)).length)
}

/**
 * The installed plugin whose folder holds `.claudock.json`: a team this profile joined. What changed compares it with
 * the version folder before it in `plugins/cache/<marketplace>/<plugin>/`, else with the manifest seen before.
 */
async function joinedOf(settings: Record<string, unknown>, ctx: Map<string, ContextItem>, remember: boolean): Promise<Joined | null> {
  for (const p of await installedPlugins().catch(() => [] as PluginRecord[])) {
    if (!p.exists) continue
    const now = await readPluginFolder(p.dir)
    if (!now.manifest) continue
    // the version folder before this one: the newest other folder that holds a manifest too
    const parent = path.dirname(p.dir)
    let before: RepoView | null = null
    let beforeDir: string | null = null
    let newest = -1
    for (const e of await fsp.readdir(parent, { withFileTypes: true }).catch(() => [])) {
      const d = path.join(parent, e.name)
      if (!e.isDirectory() || samePath(d, p.dir)) continue
      const st = await fsp.stat(path.join(d, MANIFEST_NAME)).catch(() => null)
      if (st && st.mtimeMs > newest) {
        newest = st.mtimeMs
        beforeDir = d
      }
    }
    if (beforeDir) before = await readPluginFolder(beforeDir)
    // remember what was seen, for when the old folder is gone
    const cfg = configDir()
    const r = await tryReadJson<unknown>(path.join(storeDir(), seenFile(cfg)))
    const v = r.ok && isObj(r.value) ? r.value : null
    let seen: Seen | null = v && v.key === p.key ? { key: p.key, seen: parseManifest(v.seen) ?? now.manifest, before: parseManifest(v.before) } : null
    if (!seen || canonical(seen.seen) !== canonical(now.manifest)) {
      seen = { key: p.key, seen: now.manifest, before: seen ? seen.seen : null }
      if (remember) await writeOwn(seenFile(cfg), JSON.stringify(seen, null, 2) + '\n', 0o644, storeDir()).catch(() => undefined)
    }
    // every item each version holds: what Claudock wrote, and skills, agents and commands added by hand
    const prevManifest = before?.manifest ?? seen.before
    const all = (view: RepoView | null, m: Manifest | null): Map<string, ManifestItem> => {
      const out = new Map((m?.items ?? []).map((x) => [x.id, x]))
      if (view) {
        for (const { kind, name } of repoOnlyOf(view)) {
          const id = `${kind}:${name}`
          if (!out.has(id)) out.set(id, { id, kind, name, sha: '', files: repoRels(view, kind, name, null) })
        }
      }
      return out
    }
    const nowItems = all(now, now.manifest)
    const prevItems = all(before, prevManifest)
    // compared by their files as they are (a teammate's hand edit does not change the manifest)
    const shaIn = (view: RepoView | null, rec: ManifestItem): string => (view ? (repoSha(rec, view) ?? '') : rec.sha)
    const items: JoinedItem[] = []
    for (const rec of nowItems.values()) {
      const old = prevItems.get(rec.id)
      const c = rec.kind === 'skill' ? ctx.get(`skill:${p.name}:${rec.name}`) : undefined
      const tokens = c && c.on && c.tokens !== null ? c.tokens : await listingIn(p.dir, rec, p.name)
      const change = !prevManifest ? 'same' : !old ? 'new' : shaIn(before, old) !== shaIn(before ? now : null, rec) ? 'changed' : 'same'
      items.push({ id: rec.id, kind: rec.kind, name: rec.name, detail: rec.hook ? `hook · ${rec.hook.event}` : rec.kind === 'mcp' ? 'MCP' : rec.kind, change, tokens })
    }
    for (const old of prevItems.values()) {
      if (nowItems.has(old.id)) continue
      const t = beforeDir ? await listingIn(beforeDir, old, p.name) : null
      items.push({ id: old.id, kind: old.kind, name: old.name, detail: old.hook ? `hook · ${old.hook.event}` : old.kind === 'mcp' ? 'MCP' : old.kind, change: 'removed', tokens: t === null ? null : -t })
    }
    const order = { new: 0, changed: 1, removed: 2, same: 3 }
    items.sort((a, b) => order[a.change] - order[b.change] || (Math.abs(b.tokens ?? 0) - Math.abs(a.tokens ?? 0)) || a.name.localeCompare(b.name))
    const ms = p.lastUpdated ? Date.parse(p.lastUpdated) : NaN
    return {
      view: {
        marketplace: p.marketplace,
        plugin: p.name,
        source: await sourceOf(p.marketplace),
        updatedAt: Number.isNaN(ms) ? null : ms,
        enabled: enabledMap(settings)[p.key] === true,
        items,
        tokens: items.filter((i) => i.change !== 'removed').reduce((n, i) => n + (i.tokens ?? 0), 0)
      },
      plugin: p,
      now,
      before,
      beforeDir
    }
  }
  return null
}

/** A joined item now and before, for its row's diff. */
async function joinedDiff(j: Joined, id: string): Promise<TeamDiff> {
  const find = (v: RepoView | null): ManifestItem | null => {
    if (!v) return null
    const m = v.manifest?.items.find((r) => r.id === id)
    if (m) return m
    const only = repoOnlyOf(v).find((x) => `${x.kind}:${x.name}` === id)
    return only ? { id, kind: only.kind, name: only.name, sha: '', files: repoRels(v, only.kind, only.name, null) } : null
  }
  const rec = find(j.now)
  const old = find(j.before)
  const kind = rec?.kind ?? old?.kind
  if (!kind) throw new Error('This item is no longer listed')
  const json = (v: unknown): string => (v ? JSON.stringify(v, null, 2) + '\n' : '')
  if (kind === 'hook') {
    const h = rec?.hook ?? old?.hook
    return { before: j.before && h ? json(repoHook(j.before, h.event, h.key)) : '', after: h ? json(repoHook(j.now, h.event, h.key)) : '', binary: false }
  }
  if (kind === 'mcp') {
    const name = rec?.mcp ?? old?.mcp ?? ''
    const server = (v: RepoView | null): unknown => (v && isObj(v.mcp) && isObj(v.mcp.mcpServers) && isObj(v.mcp.mcpServers[name]) ? maskSecrets(v.mcp.mcpServers[name] as JsonObj) : null)
    return { before: json(server(j.before)), after: json(server(j.now)), binary: false }
  }
  const text = async (root: string | null, files: string[]): Promise<string> => {
    if (!root) return ''
    let out = ''
    for (const rel of files) {
      const d = await readCached(path.join(root, ...rel.split('/')))
      out += (files.length > 1 ? `── ${rel}\n` : '') + (d ? (textOf(d) ?? '(not text)\n') : '')
    }
    return out
  }
  return { before: await text(j.beforeDir, old?.files ?? []), after: await text(j.plugin.dir, rec?.files ?? []), binary: false }
}

/* ------------------------------------------------------------------ badges */

async function members(): Promise<TeamMembers> {
  const b = await build({ context: false })
  const out: TeamMembers = { skills: [], agents: [], commands: [], hooks: [], mcp: [], plugin: b.joined?.plugin.key ?? null }
  for (const i of b.items) {
    if (!i.ticked || !i.open || i.state === null || i.state === 'new') continue
    const id = i.open.screen === 'hooks' ? i.open.id.replace(/^settings\.json\|/, '') : i.open.screen === 'mcp' ? i.open.id.replace(/^user:/, '') : i.open.id
    out[i.open.screen].push(id)
  }
  if (b.joined) {
    // the plugin's own skills, agents and commands, by the ids those screens give them
    const base = toPosix(path.relative(configDir(), b.joined.plugin.dir))
    for (const rec of b.joined.now.manifest?.items ?? []) {
      if (rec.kind === 'skill') out.skills.push(`${base}/skills/${rec.name}`)
      else if (rec.kind === 'agent' || rec.kind === 'command') for (const f of rec.files) out[`${rec.kind}s`].push(`${base}/${f}`)
    }
  }
  return out
}

/* ------------------------------------------------------------------ connected projects */

const SETTINGS_REL = '.claude/settings.json'

/** The git projects Claude Code knows (its project folders, most recent first), each with whether it points at the team. */
async function projectsOf(store: Store): Promise<TeamProject[]> {
  const out: (TeamProject & { at: number })[] = []
  for (const p of await listProjectSummaries().catch(() => [])) {
    if (!p.path || p.missing || samePath(p.path, store.dir) || samePath(p.path, os.homedir())) continue
    if (!(await gitDirOf(p.path))) continue
    const text = await readText(p.path, SETTINGS_REL).catch(() => null)
    out.push({ id: p.id, name: p.name, path: p.path, connected: isPointed(text, store), at: p.lastActiveMs })
  }
  return out.sort((a, b) => b.at - a.at).map(({ at: _at, ...p }) => p)
}

/** A project offered in the list: the renderer names it by its id, never by a path. */
async function projectFor(projectId: string): Promise<{ store: Store; remote: TeamRemote; project: TeamProject }> {
  if (typeof projectId !== 'string') throw new Error('Unknown project')
  const store = await mustStore()
  const remote = await readRemote(store.dir)
  if (!remote) throw new Error('The team folder has no remote yet: add one with git first')
  const project = (await projectsOf(store)).find((p) => p.id === projectId)
  if (!project) throw new Error('That project is not one Claude Code knows as a git repo')
  return { store, remote, project }
}

async function connectPlan(projectId: string): Promise<TeamDiff> {
  const { store, remote, project } = await projectFor(projectId)
  const before = await readText(project.path, SETTINGS_REL)
  const next = project.connected ? unpointerText(before, store) : pointerText(before, store, remote)
  if (next.problem) throw new Error(next.problem)
  return { before: before ?? '', after: next.text, binary: false }
}

function connect(projectId: string): Promise<TeamState> {
  const cfg = configDir()
  return serial(cfg, async () => {
    const { store, remote, project } = await projectFor(projectId)
    const before = await readText(project.path, SETTINGS_REL)
    const next = pointerText(before, store, remote)
    if (next.problem) throw new Error(next.problem)
    await writeOne(project.path, SETTINGS_REL, next.text, guard)
    store.projects = [...new Set([...store.projects, project.path])]
    if (before === null) store.created = [...new Set([...(store.created ?? []), project.path])]
    await saveStore(cfg, store)
    return get()
  })
}

function disconnect(projectId: string): Promise<TeamState> {
  const cfg = configDir()
  return serial(cfg, async () => {
    const { store, project } = await projectFor(projectId)
    const before = await readText(project.path, SETTINGS_REL)
    const next = unpointerText(before, store)
    if (next.problem) throw new Error(next.problem)
    const made = (store.created ?? []).some((p) => samePath(p, project.path))
    if (made && next.text === '{}\n') {
      // the file Connect made, with nothing else in it: back to no file at all
      if (!guard.allowed(project.path)) throw new Error('Writes to this folder are turned off in development (it has no .claudock-fixture file).')
      await guard.trash(path.join(project.path, '.claude', 'settings.json'))
    } else await writeOne(project.path, SETTINGS_REL, next.text, guard)
    store.projects = store.projects.filter((p) => !samePath(p, project.path))
    store.created = (store.created ?? []).filter((p) => !samePath(p, project.path))
    await saveStore(cfg, store)
    return get()
  })
}

/* ------------------------------------------------------------------ the folder */

/** Folders this session offered in the dialog, by token: `create` takes only these. */
const offered = new Map<string, string>()

async function refuseFolder(dir: string): Promise<string | null> {
  const real = await fsp.realpath(dir).catch(() => dir)
  for (const d of [dir, real]) {
    if (path.dirname(d) === d) return 'Choose a folder, not the whole disk'
    if (samePath(d, os.homedir())) return 'Choose a git repo, not your home folder'
    if (isInside(configDir(), d) || isInside(d, configDir())) return 'Choose a folder outside the Claude Code folder'
    if (isInside(userDataDir(), d) || isInside(d, userDataDir())) return 'That folder holds Claudock’s own data'
  }
  return null
}

async function offer(dir: string): Promise<FolderOffer> {
  const why = await refuseFolder(dir)
  if (why) throw new Error(why)
  const isGit = (await gitDirOf(dir)) !== null
  const remote = isGit ? await readRemote(dir) : null
  const existing = await existingNames(dir)
  const base = remote ? (remote.kind === 'github' ? remote.text.split('/')[1] : (remote.text.split('/').pop() ?? '').replace(/\.git$/, '')) : path.basename(dir)
  const ownerFrom = remote?.kind === 'github' ? remote.text.split('/')[0] : os.userInfo().username
  const token = crypto.randomBytes(12).toString('hex')
  offered.set(token, dir)
  return {
    token,
    dir,
    isGit,
    remote,
    marketplace: existing?.marketplace || slugName(base, 'team-setup'),
    plugin: existing?.plugin || 'team',
    owner: existing?.owner || ownerFrom,
    existing: existing !== null
  }
}

async function pickFolder(): Promise<FolderOffer | null> {
  // screenshots have no dialog to click: the fixture's team folder beside the copied config folder
  if (SHOT) return offer(path.join(os.homedir(), 'team-repo'))
  const win = BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = { title: 'Team folder', buttonLabel: 'Choose', properties: ['openDirectory', 'createDirectory'] }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const picked = r.canceled ? undefined : r.filePaths[0]
  return picked ? offer(path.resolve(picked)) : null
}

async function create(input: { token: string; marketplace: string; plugin: string; owner: string }): Promise<TeamState> {
  const dir = typeof input?.token === 'string' ? offered.get(input.token) : undefined
  if (!dir) throw new Error('Choose the folder again')
  const marketplace = String(input.marketplace ?? '').trim()
  const plugin = String(input.plugin ?? '').trim()
  const owner = String(input.owner ?? '')
    .trim()
    .slice(0, 80)
  const problem = marketplaceNameProblem(marketplace) ?? pluginNameProblem(plugin) ?? (owner ? null : 'Give the owner a name.')
  if (problem) throw new Error(problem)
  const why = await refuseFolder(dir)
  if (why) throw new Error(why)
  if (!(await gitDirOf(dir))) throw new Error('Choose a git repo, so every write can be undone')
  const cfg = configDir()
  return serial(cfg, async () => {
    // the folder's own items stay ticked; else what was used in the last 30 days
    const view = await readRepo(dir, plugin)
    const store: Store = { v: 1, dir, marketplace, plugin, owner, ticked: [], fixes: {}, projects: [] }
    await saveStore(cfg, store)
    const b = await build({ context: true })
    const known = new Set(b.items.map((i) => i.id))
    store.ticked = view.manifest ? view.manifest.items.map((r) => r.id).filter((id) => known.has(id) && b.outs.has(id)) : firstTicks(b.items, Date.now())
    await saveStore(cfg, store)
    offered.delete(input.token)
    return get()
  })
}

/* ------------------------------------------------------------------ changes */

async function mustStore(): Promise<Store> {
  const s = await loadStore(configDir())
  if (!s) throw new Error('There is no team setup in this profile')
  return s
}

function setTicked(ids: string[], on: boolean): Promise<TeamState> {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string') || typeof on !== 'boolean') return Promise.reject(new Error('Invalid ticks'))
  const cfg = configDir()
  return serial(cfg, async () => {
    const s = await mustStore()
    const b = await build({ context: false })
    const known = new Set(b.rows.map((r) => r.src.id))
    const set = new Set(s.ticked)
    for (const id of ids) {
      if (on && !known.has(id)) continue
      if (on) set.add(id)
      else set.delete(id)
    }
    s.ticked = [...set].sort()
    await saveStore(cfg, s)
    return get()
  })
}

function setFix(itemId: string, fix: Fix | { kind: 'clear'; where: string }): Promise<Review> {
  if (typeof itemId !== 'string' || !isObj(fix) || typeof fix.where !== 'string') return Promise.reject(new Error('Invalid fix'))
  const kinds = ['ask', 'env', 'copy-script', 'keep', 'mine', 'clear']
  if (!kinds.includes(fix.kind)) return Promise.reject(new Error('Invalid fix'))
  if (fix.kind !== 'clear') {
    const p = fixProblem(fix)
    if (p) return Promise.reject(new Error(p))
  }
  const cfg = configDir()
  return serial(cfg, async () => {
    const s = await mustStore()
    const list = (s.fixes[itemId] ?? []).filter((f) => f.where !== fix.where)
    if (fix.kind !== 'clear') list.push(fix)
    if (list.length) s.fixes[itemId] = list
    else delete s.fixes[itemId]
    await saveStore(cfg, s)
    return review()
  })
}

async function review(): Promise<Review> {
  return (await reviewOf(await build({ context: false }))).review
}

async function fileDiff(rel: string): Promise<TeamDiff> {
  if (typeof rel !== 'string') throw new Error('Unknown file')
  const b = await build({ context: false })
  const { files } = await reviewOf(b)
  const f = files.find((x) => x.rel === rel)
  if (!f || !b.store || !b.plan) throw new Error('This file is no longer in the review')
  const before = f.change === 'add' ? new Uint8Array() : ((await readRepoFile(b.store.dir, rel)) ?? new Uint8Array())
  const after = f.change === 'remove' ? new Uint8Array() : (b.plan.writes.get(rel) ?? new Uint8Array())
  return diffOf(before, after)
}

function diffOf(before: Uint8Array, after: Uint8Array): TeamDiff {
  const a = textOf(before)
  const z = textOf(after)
  if (a === null || z === null || a.length > DIFF_CAP || z.length > DIFF_CAP) return { before: '', after: '', binary: true }
  return { before: a, after: z, binary: false }
}

/** The user's copy of an item as text, and the repo's, for its row's diff. */
async function itemDiff(id: string): Promise<TeamDiff> {
  if (typeof id !== 'string') throw new Error('Unknown item')
  const b = await build({ context: false })
  if (!b.store && b.joined) return joinedDiff(b.joined, id)
  if (!b.store) throw new Error('There is no team setup in this profile')
  const out = b.outs.get(id) ?? null
  const rec: ManifestItem | null = b.view.manifest?.items.find((r) => r.id === id) ?? null
  const only = b.states.get(id) === 'repo-only' ? repoOnlyOf(b.view).find((x) => `${x.kind}:${x.name}` === id) : undefined
  if (!out && !rec && !only) throw new Error('This item is no longer listed')
  const root = pluginDir(b.store.plugin)
  const kind = out?.kind ?? rec?.kind ?? only?.kind
  if (kind === 'hook') {
    const key = out?.hook?.key ?? rec?.hook?.key ?? ''
    const event = out?.hook?.event ?? rec?.hook?.event ?? ''
    const theirs = repoHook(b.view, event, key)
    return { before: theirs ? JSON.stringify(theirs, null, 2) + '\n' : '', after: out?.hook ? JSON.stringify(out.hook.group, null, 2) + '\n' : '', binary: false }
  }
  if (kind === 'mcp') {
    const name = out?.mcp?.name ?? rec?.mcp ?? ''
    const servers = isObj(b.view.mcp) && isObj(b.view.mcp.mcpServers) ? b.view.mcp.mcpServers : {}
    const theirs = isObj(servers[name]) ? maskSecrets(servers[name] as JsonObj) : null
    return { before: theirs ? JSON.stringify(theirs, null, 2) + '\n' : '', after: out?.mcp ? JSON.stringify(maskSecrets(out.mcp.config), null, 2) + '\n' : '', binary: false }
  }
  // files: the user's as they would be written, the repo's as they are
  const mine = new Map((out?.files ?? []).map((f) => [f.rel, f.data]))
  const theirsRels = repoRels(b.view, kind ?? 'skill', out?.name ?? rec?.name ?? only?.name ?? '', rec)
  const rels = [...new Set([...mine.keys(), ...theirsRels])].sort()
  const one = rels.length === 1
  let before = ''
  let after = ''
  for (const rel of rels) {
    const t = b.view.files.has(rel) ? await readRepoFile(b.store.dir, `${root}/${rel}`) : null
    const m = mine.get(rel) ?? null
    const show = (d: Uint8Array | null): string => (d === null ? '' : (textOf(d) ?? '(not text)\n'))
    const head = one ? '' : `── ${rel}\n`
    if (t) before += head + show(t)
    if (m) after += head + show(m)
  }
  if (before.length > DIFF_CAP || after.length > DIFF_CAP) return { before: '', after: '', binary: true }
  return { before, after, binary: false }
}

async function write(token: string): Promise<Written> {
  if (typeof token !== 'string') throw new Error('Review the changes first')
  const cfg = configDir()
  return serial(cfg, async () => {
    const b = await build({ context: false })
    if (!b.store || !b.plan || !b.setup) throw new Error('There is no team setup in this profile')
    const { review: r } = await reviewOf(b)
    if (r.token !== token) throw new Error('The setup changed since the review. Look at it again.')
    if (b.findings.some(isOpen)) throw new Error('Fix what the review lists first')
    const counts = { added: 0, changed: 0, removed: 0 }
    for (const i of b.items) {
      if (i.state === 'new' && i.ticked) counts.added++
      else if ((i.state === 'changed-here' || i.state === 'changed-both') && i.ticked) counts.changed++
      else if (i.state === 'removed') counts.removed++
    }
    const outcome = await writeFiles(b.store.dir, b.plan.writes, b.plan.removes, guard)
    const command = sendCommand(b.store, counts, b.plan.writes.has('README.md'))
    const s = b.store
    s.sentAt = Date.now()
    s.send = command
    // "Use mine" settled one disagreement; the next one is asked again
    for (const [id, list] of Object.entries(s.fixes)) {
      const left = list.filter((f) => f.kind !== 'mine')
      if (left.length) s.fixes[id] = left
      else delete s.fixes[id]
    }
    await saveStore(cfg, s)
    return { files: outcome.written.length, removed: outcome.removed.length, dir: s.dir, command }
  })
}

async function copy(what: 'send' | 'join-user' | 'join-project' | 'configure'): Promise<void> {
  const st = await get()
  const s = await loadStore(configDir())
  const text = what === 'send' ? s?.send : what === 'join-user' ? st.join?.user : what === 'join-project' ? st.join?.project : what === 'configure' ? st.join?.configure : undefined
  if (!text) throw new Error('Nothing to copy')
  if (!SHOT) clipboard.writeText(text)
}

async function reveal(): Promise<void> {
  const s = await mustStore()
  if (!SHOT) await shell.openPath(s.dir)
}

function forget(): Promise<void> {
  const cfg = configDir()
  return serial(cfg, async () => {
    await fsp.rm(path.join(storeDir(), storeFile(cfg)), { force: true })
  })
}

/**
 * The repo's copy of a skill, agent or command replaces the user's own (safeWrite: each file it replaces is snapshotted;
 * a file only the user's copy has goes to the Trash). A hook or server in the repo may hold placeholders for a secret
 * or a path, so those are not taken back.
 */
function takeRepoVersion(id: string): Promise<{ snapshotId: string | null }> {
  if (typeof id !== 'string') return Promise.reject(new Error('Unknown item'))
  const cfg = configDir()
  return serial(cfg, async () => {
    const b = await build({ context: false })
    if (!b.store || b.setup?.missing) throw new Error('There is no team folder to take it from')
    const kind = id.slice(0, id.indexOf(':'))
    const name = id.slice(id.indexOf(':') + 1)
    if (kind !== 'skill' && kind !== 'agent' && kind !== 'command') throw new Error('Only skills, agents and commands can be taken from the repo')
    if (!name || name.split(':').some((p) => !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(p))) throw new Error('That name cannot be a file name')
    const rec = b.view.manifest?.items.find((r) => r.id === id) ?? null
    const rels = repoRels(b.view, kind, name, rec)
    if (!rels.length) throw new Error('The repo has no copy of it')
    const root = pluginDir(b.store.plugin)
    const src = b.rows.find((r) => r.src.id === id)?.src
    // where each file goes in the config folder
    const destOf = (rel: string): string =>
      kind === 'skill' ? `skills/${src?.kind === 'skill' ? src.name : name}/${rel.slice(`skills/${name}/`.length)}` : src && src.kind !== 'skill' && src.kind !== 'hook' && src.kind !== 'mcp' ? `${kind}s/${src.rel}` : rel
    const texts: [string, string][] = []
    for (const rel of rels) {
      const data = await readRepoFile(b.store.dir, `${root}/${rel}`)
      const text = data ? textOf(data) : null
      if (text === null) throw new Error(`${rel} is not text; copy it by hand`)
      texts.push([destOf(rel), text])
    }
    const reason = `Take ${name} from the team repo`
    let snapshotId: string | null = null
    for (const [rel, text] of texts) {
      const r = await safeWriteText(rel, text, reason)
      snapshotId ??= r.snapshotId
    }
    // files the user's skill has and the repo's has not
    if (src?.kind === 'skill') {
      const keep = new Set(texts.map(([rel]) => rel))
      for (const f of src.files) {
        const rel = `skills/${src.name}/${f.rel}`
        if (!keep.has(rel)) await trash(rel)
      }
    }
    return { snapshotId }
  })
}


/** The domain's calls, for screenshot mode's checks (src/main/shot.ts). */
export const impl: TeamApi = {
  get,
  pickFolder,
  create,
  setTicked,
  setFix,
  review,
  fileDiff,
  itemDiff,
  write,
  takeRepoVersion,
  connectPlan,
  connect,
  disconnect,
  copy,
  reveal,
  forget,
  members
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'team', impl)
}

/** Sidebar badge: changes not written to the team folder yet. */
export async function count(): Promise<number | undefined> {
  if (!(await loadStore(configDir()))) return undefined
  const n = toState(await build({ context: false })).changes
  return n || undefined
}
