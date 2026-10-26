import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ModDraft, ModInfo, ModList, ModUses, ModsApi } from '@shared/api/mods'
import { exists, readJson } from '../fsx'
import { defineDomain } from '../ipcx'
import { assertWritable, configDir, isInside, isSecretReal, samePath } from '../paths'
import { trash } from '../safeWrite'
import {
  childDirs,
  enabledMap,
  freePath,
  installedPlugins,
  isDirectory,
  isObj,
  readCapped,
  readSettings,
  toPosix,
  updateSettings
} from './extendShared'
import { listProjectSummaries, sessionTitle } from './projects'

/**
 * Mods: plugins whose hooks/hooks.json has a `modules` key. Reads installed plugins, the folders in
 * CLAUDE_CODE_PLUGIN_DIRS (settings.json `env`), `mods/` (where Keep puts drafts) and `dev-mods/<session>/<name>`.
 * Writes settings.json through updateSettings, copies drafts like Skills' duplicate, and sends deletes to the Trash.
 */

const DIRS_VAR = 'CLAUDE_CODE_PLUGIN_DIRS'
const SEP = process.platform === 'win32' ? ';' : ':'
const DEFAULT_CLEANUP_DAYS = 30
const DAY = 86_400_000
const MAX_MODULE_BYTES = 1_000_000
const MAX_README_BYTES = 64 * 1024
const MAX_KEEP_BYTES = 50_000_000
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const UUID_RE = /^[0-9a-f-]{8,64}$/i

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/* ------------------------------------------------------------------ reading a mod folder */

/** Path of the hooks module relative to the mod folder, or null when the folder is not a mod. */
async function moduleOf(dir: string): Promise<string | null> {
  const hj = await readJson<unknown>(path.join(dir, 'hooks', 'hooks.json'))
  if (!isObj(hj) || !Array.isArray(hj.modules)) return null
  const first = hj.modules.find((m): m is string => typeof m === 'string' && m.length > 0)
  return first ? toPosix(path.join('hooks', first)) : ''
}

const RISKY = new Set([
  'fs.write',
  'process.run',
  'process.spawn',
  'http.fetch',
  'model.complete',
  'model.fork',
  'model.classify',
  'prompt.submit',
  'session.send',
  'session.authorize',
  'env.set',
  'config.set',
  'mcp.call',
  'mcp.connect',
  'agent.spawn',
  'tool.call'
])

const uniq = (xs: string[]): string[] => Array.from(new Set(xs))

/** What a hooks module does, from its text. The host reads `on(...)` and `$.ns.method(...)` literally, so a regex sees what it sees. */
export function usesOf(src: string): ModUses {
  const all = (re: RegExp, group = 1): string[] => uniq(Array.from(src.matchAll(re), (m) => m[group]))
  const hooks = all(/\bon\(\s*(['"`])([\w.:-]+)\1/g, 2)
  const draws = all(/\bcomponent\s*:\s*(['"`])(\w+)\1/g, 2)
  const commands = all(/\$\.command\.register\(\s*\{[^}]*?\bname\s*:\s*(['"`])([\w:.-]+)\1/g, 2)
  const calls = all(/\$\.(\w+\.\w+)\s*\(/g).filter((c) => !c.startsWith('state.'))
  return { hooks, draws, commands, calls, risky: calls.filter((c) => RISKY.has(c)) }
}

async function usesIn(dir: string, module: string): Promise<ModUses> {
  const empty: ModUses = { hooks: [], draws: [], commands: [], calls: [], risky: [] }
  if (!module) return empty
  const abs = path.resolve(dir, module)
  if (!isInside(dir, abs)) return empty
  try {
    return usesOf((await readCapped(abs, MAX_MODULE_BYTES)).text)
  } catch {
    return empty
  }
}

async function readme(dir: string): Promise<string | null> {
  try {
    const r = await readCapped(path.join(dir, 'README.md'), MAX_README_BYTES)
    return r.truncated ? r.text.replace(/\n[^\n]*$/, '\n') : r.text
  } catch {
    return null
  }
}

/** `$.store` files are `<name>_<marketplace or inline>-<hash>.json` under plugins/store. */
async function storeOf(name: string, scope: string, files: string[]): Promise<{ rels: string[]; bytes: number }> {
  const prefix = `${name}_${scope}-`
  const rels = files.filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => `plugins/store/${f}`)
  let bytes = 0
  for (const r of rels) bytes += (await fsp.stat(path.join(configDir(), r)).catch(() => null))?.size ?? 0
  return { rels, bytes }
}

const relOf = (abs: string): string | null => (isInside(configDir(), abs) && !samePath(abs, configDir()) ? toPosix(path.relative(configDir(), abs)) : null)

interface Base {
  id: string
  source: ModInfo['source']
  key: string
  marketplace: string
  enabled: boolean
  dir: string
  version?: string
  draft?: ModDraft
}

async function toInfo(b: Base, module: string, storeFiles: string[]): Promise<ModInfo> {
  const ok = await isDirectory(b.dir)
  const manifest = ok ? await readJson<unknown>(path.join(b.dir, '.claude-plugin', 'plugin.json')) : undefined
  const m = isObj(manifest) ? manifest : {}
  const name = str(m.name) || path.basename(b.dir)
  const store = await storeOf(name, b.source === 'installed' ? b.marketplace : 'inline', storeFiles)
  return {
    id: b.id,
    name,
    source: b.source,
    version: b.version || str(m.version),
    description: str(m.description),
    author: typeof m.author === 'string' ? m.author : isObj(m.author) ? str(m.author.name) : '',
    key: b.source === 'installed' ? b.key : b.source === 'folder' ? `${name}@inline` : '',
    marketplace: b.marketplace,
    enabled: b.enabled,
    dir: b.dir,
    rel: relOf(b.dir),
    module,
    uses: ok ? await usesIn(b.dir, module) : { hooks: [], draws: [], commands: [], calls: [], risky: [] },
    storeRel: store.rels[0] ?? null,
    storeBytes: store.bytes,
    readme: ok ? await readme(b.dir) : null,
    draft: b.draft
  }
}

/* ------------------------------------------------------------------ CLAUDE_CODE_PLUGIN_DIRS */

function pluginDirs(settings: Record<string, unknown>): string[] {
  const env = isObj(settings.env) ? settings.env : {}
  return str(env[DIRS_VAR])
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Add or remove one folder in settings.json env.CLAUDE_CODE_PLUGIN_DIRS, keeping every other entry as written. */
function setPluginDir(abs: string, on: boolean, reason: string): Promise<{ snapshotId: string | null; changed: boolean }> {
  return updateSettings((s) => {
    const cur = pluginDirs(s)
    const has = cur.some((d) => samePath(d, abs))
    if (has === on) return false
    const next = on ? [...cur, abs] : cur.filter((d) => !samePath(d, abs))
    const env = isObj(s.env) ? { ...s.env } : {}
    if (next.length) env[DIRS_VAR] = next.join(SEP)
    else delete env[DIRS_VAR]
    s.env = env
    return true
  }, reason)
}

/* ------------------------------------------------------------------ drafts */

/** Newest mtime of the files below `dir` (generated types skipped), at most a few hundred entries. */
async function newestMtime(dir: string): Promise<number> {
  let newest = 0
  let seen = 0
  async function walk(d: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++seen > 500 || e.name === 'node_modules' || e.name === 'types') continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (depth < 4) await walk(full, depth + 1)
      } else if (e.isFile()) {
        const st = await fsp.stat(full).catch(() => null)
        if (st && st.mtimeMs > newest) newest = st.mtimeMs
      }
    }
  }
  await walk(dir, 0)
  return newest || ((await fsp.stat(dir).catch(() => null))?.mtimeMs ?? Date.now())
}

async function drafts(cleanupDays: number): Promise<Base[]> {
  const root = path.join(configDir(), 'dev-mods')
  const sessions = (await childDirs(root)).filter((s) => UUID_RE.test(s))
  if (sessions.length === 0) return []
  const projects = await listProjectSummaries().catch(() => [])
  const out: Base[] = []
  for (const sid of sessions) {
    let project: { id: string; path: string | null } | null = null
    for (const p of projects) {
      if (await exists(path.join(configDir(), 'projects', p.id, `${sid}.jsonl`))) {
        project = p
        break
      }
    }
    const title = project ? await sessionTitle(path.join(configDir(), 'projects', project.id, `${sid}.jsonl`)) : ''
    for (const name of await childDirs(path.join(root, sid))) {
      const dir = path.join(root, sid, name)
      if ((await moduleOf(dir)) === null) continue
      const modifiedMs = await newestMtime(dir)
      out.push({
        id: `draft:${sid}/${name}`,
        source: 'draft',
        key: '',
        marketplace: '',
        enabled: false,
        dir,
        draft: { sessionId: sid, project: project?.path ?? null, projectId: project?.id ?? null, sessionTitle: title, modifiedMs, expiresMs: modifiedMs + cleanupDays * DAY }
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ list */

async function list(): Promise<ModList> {
  const { data, error } = await readSettings()
  const ep = enabledMap(data)
  const cleanup = typeof data.cleanupPeriodDays === 'number' && data.cleanupPeriodDays >= 1 ? data.cleanupPeriodDays : DEFAULT_CLEANUP_DAYS
  const storeFiles = await fsp.readdir(path.join(configDir(), 'plugins', 'store')).catch(() => [] as string[])
  const bases: Array<{ b: Base; module: string }> = []

  for (const r of await installedPlugins()) {
    const module = r.exists ? await moduleOf(r.dir) : null
    if (module === null) continue
    bases.push({ b: { id: r.key, source: 'installed', key: r.key, marketplace: r.marketplace, enabled: ep[r.key] === true, dir: r.dir, version: r.version }, module })
  }

  const listed = pluginDirs(data).filter((d) => path.isAbsolute(d))
  const keptRoot = path.join(configDir(), 'mods')
  const kept = (await childDirs(keptRoot)).map((n) => path.join(keptRoot, n))
  const folders = [...listed, ...kept.filter((k) => !listed.some((d) => samePath(d, k)))]
  for (const dir of folders) {
    const on = listed.some((d) => samePath(d, dir))
    // a listed folder that is a plain plugin (or gone) is not a mod
    const module = await moduleOf(dir)
    if (module === null) continue
    bases.push({ b: { id: `folder:${dir}`, source: 'folder', key: '', marketplace: '', enabled: on, dir }, module })
  }

  for (const b of await drafts(cleanup)) bases.push({ b, module: (await moduleOf(b.dir)) ?? '' })

  const mods = await Promise.all(bases.map(({ b, module }) => toInfo(b, module, storeFiles)))
  const order = { installed: 0, folder: 1, draft: 2 }
  mods.sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name))
  return { mods, hooksDisabled: data.disableAllHooks === true, cleanupPeriodDays: cleanup, settingsError: error }
}

/* ------------------------------------------------------------------ writes */

async function find(id: string): Promise<ModInfo> {
  if (typeof id !== 'string' || !id) throw new Error('Unknown mod')
  const m = (await list()).mods.find((x) => x.id === id)
  if (!m) throw new Error('This mod is no longer there. Reload the list.')
  return m
}

/** A dev-mods/<session> folder emptied by Keep or Trash goes too. */
async function trashEmptySession(m: ModInfo): Promise<void> {
  if (m.source !== 'draft' || !m.draft) return
  const sdir = path.join(configDir(), 'dev-mods', m.draft.sessionId)
  if ((await fsp.readdir(sdir).catch(() => ['x'])).length === 0) await trash(`dev-mods/${m.draft.sessionId}`).catch(() => undefined)
}

async function keepDraft(id: string): Promise<{ id: string; snapshotId: string | null }> {
  assertWritable()
  const m = await find(id)
  if (m.source !== 'draft' || !m.rel) throw new Error('Only drafts can be kept')
  const root = path.join(configDir(), 'mods')
  await fsp.mkdir(root, { recursive: true })
  const stem = NAME_RE.test(m.name) ? m.name : path.basename(m.dir)
  const { abs: dest } = await freePath(root, stem)
  const typesDir = path.join(m.dir, '.claude-plugin', 'types')
  let bytes = 0
  const destRel = toPosix(path.relative(configDir(), dest))
  try {
    // Symlinks are copied as links (never followed); Claude Code regenerates .claude-plugin/types for the new folder.
    await fsp.cp(m.dir, dest, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      filter: async (src) => {
        if (samePath(src, typesDir) || path.basename(src) === 'node_modules' || (await isSecretReal(src))) return false
        bytes += (await fsp.lstat(src).catch(() => null))?.size ?? 0
        if (bytes > MAX_KEEP_BYTES) throw new Error('This draft is too large to keep here. Copy it in your file manager.')
        return true
      }
    })
    const r = await setPluginDir(dest, true, `Keep mod ${m.name}`)
    await trash(m.rel)
    await trashEmptySession(m)
    return { id: `folder:${dest}`, snapshotId: r.snapshotId }
  } catch (e) {
    if (await exists(dest)) await trash(destRel).catch(() => undefined)
    throw e
  }
}

const impl: ModsApi = {
  list,

  async setEnabled(id, enabled) {
    const m = await find(id)
    if (m.source === 'installed') {
      const r = await updateSettings((s) => {
        const cur = isObj(s.enabledPlugins) ? { ...s.enabledPlugins } : {}
        if (cur[m.key] === enabled) return false
        cur[m.key] = enabled
        s.enabledPlugins = cur
        return true
      }, `${enabled ? 'Enable' : 'Disable'} mod ${m.key}`)
      return { snapshotId: r.snapshotId }
    }
    if (m.source === 'folder') {
      const r = await setPluginDir(m.dir, enabled, `${enabled ? 'Load' : 'Stop loading'} mod ${m.name}`)
      return { snapshotId: r.snapshotId }
    }
    throw new Error('A draft loads only in the session that wrote it. Keep it to load it everywhere.')
  },

  keepDraft,

  async trash(id) {
    const m = await find(id)
    if (m.source === 'installed') throw new Error('Remove installed mods with /plugin in Claude Code')
    let snapshotId: string | null = null
    if (m.source === 'folder') {
      snapshotId = (await setPluginDir(m.dir, false, `Remove mod ${m.name}`)).snapshotId
      if (!m.rel) return { snapshotId } // outside the config dir: only stop loading it
    }
    if (m.rel && (await exists(m.dir))) await trash(m.rel)
    await trashEmptySession(m)
    return { snapshotId }
  },

  async clearStore(id) {
    const m = await find(id)
    if (!m.storeRel) return
    const storeFiles = await fsp.readdir(path.join(configDir(), 'plugins', 'store')).catch(() => [] as string[])
    const { rels } = await storeOf(m.name, m.source === 'installed' ? m.marketplace : 'inline', storeFiles)
    for (const r of rels) await trash(r)
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'mods', impl)
}

/** Sidebar badge: installed and folder mods plus drafts (hooks.json reads only). */
export async function count(): Promise<number> {
  const { data } = await readSettings()
  const keptRoot = path.join(configDir(), 'mods')
  const listed = pluginDirs(data).filter((d) => path.isAbsolute(d))
  const kept = (await childDirs(keptRoot)).map((n) => path.join(keptRoot, n)).filter((k) => !listed.some((d) => samePath(d, k)))
  const devRoot = path.join(configDir(), 'dev-mods')
  const devDirs: string[] = []
  for (const sid of (await childDirs(devRoot)).filter((s) => UUID_RE.test(s))) {
    for (const n of await childDirs(path.join(devRoot, sid))) devDirs.push(path.join(devRoot, sid, n))
  }
  const dirs = [...(await installedPlugins()).filter((r) => r.exists).map((r) => r.dir), ...listed, ...kept, ...devDirs]
  const flags = await Promise.all(dirs.map(async (d) => (await moduleOf(d)) !== null))
  return flags.filter(Boolean).length
}
