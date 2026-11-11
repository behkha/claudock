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
  type TeamKind,
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
import {
  MAX_SCRIPT_BYTES,
  buildOut,
  buildPlan,
  fixProblem,
  findingsFor,
  hookScriptToken,
  isChange,
  isObj,
  isOpen,
  joinCommands,
  maskSecrets,
  planToken,
  pluginDir,
  repoHook,
  sendCommand,
  sha256,
  stateOf,
  suggestKey,
  textOf,
  type ItemOut,
  type JsonObj,
  type ManifestItem,
  type Plan,
  type PlanItem,
  type RepoView,
  type SrcFile,
  type Source
} from '../team/model'
import { existingNames, gitDirOf, readRemote, readRepo, readRepoFile } from '../team/repo'
import { devAllowed, writeFiles, type WriteGuard } from '../team/write'
import { listContext } from './context'
import { collectMd, readSettings, toPosix } from './extendShared'
import { ourHookCommands } from './sessions'
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
    ...(typeof v.send === 'string' ? { send: v.send } : {})
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

  return { store, setup, remote, view, rows, items, findings, outs, plan, states, stays, context, home }
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
    projects: [],
    joined: null,
    writable: b.store ? guard.allowed(b.store.dir) : true
  }
}

const get = (): Promise<TeamState> => build({ context: true }).then(toState)

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
  if (!b.store) throw new Error('There is no team setup in this profile')
  const out = b.outs.get(id) ?? null
  const rec: ManifestItem | null = b.view.manifest?.items.find((r) => r.id === id) ?? null
  if (!out && !rec) throw new Error('This item is no longer listed')
  const root = pluginDir(b.store.plugin)
  const kind = out?.kind ?? rec?.kind
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
  const theirsRels = kind === 'skill' ? [...b.view.files.keys()].filter((r) => r.startsWith(`skills/${out?.name ?? rec?.name}/`)) : (rec?.files ?? out?.files.map((f) => f.rel) ?? [])
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

const notYet = (): Promise<never> => Promise.reject(new Error('Not available yet'))

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
  takeRepoVersion: notYet,
  connectPlan: notYet,
  connect: notYet,
  disconnect: notYet,
  copy,
  reveal,
  forget
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
