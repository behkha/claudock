import type { IpcMain } from 'electron'
import path from 'node:path'
import type { MarketplaceInfo, PluginContents, PluginInfo, PluginList, PluginsApi } from '@shared/api/plugins'
import { readJson } from '../fsx'
import { defineDomain } from '../ipcx'
import { configDir, isInside } from '../paths'
import {
  childDirs,
  collectMd,
  enabledMap,
  installedPlugins,
  isFile,
  isObj,
  readSettings,
  splitPluginKey,
  toPosix,
  updateSettings,
  type PluginRecord
} from './extendShared'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function countHooks(v: unknown): { n: number; events: string[] } {
  const events: string[] = []
  let n = 0
  const hooks = isObj(v) && isObj(v.hooks) ? v.hooks : isObj(v) ? v : null
  if (hooks) {
    for (const [ev, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      let here = 0
      for (const g of groups) {
        if (isObj(g) && Array.isArray(g.hooks)) here += g.hooks.length
        else if (isObj(g)) here++
      }
      if (here > 0) {
        n += here
        events.push(ev)
      }
    }
  }
  return { n, events }
}

async function contentsOf(dir: string): Promise<PluginContents> {
  const [skillDirs, agentFiles, commandFiles, hooksJson, mcpJson, manifest] = await Promise.all([
    childDirs(path.join(dir, 'skills')),
    collectMd(path.join(dir, 'agents'), { maxDepth: 2, max: 500 }),
    collectMd(path.join(dir, 'commands'), { maxDepth: 3, max: 500 }),
    readJson<unknown>(path.join(dir, 'hooks', 'hooks.json')),
    readJson<unknown>(path.join(dir, '.mcp.json')),
    readJson<unknown>(path.join(dir, '.claude-plugin', 'plugin.json'))
  ])
  const skills: string[] = []
  for (const s of skillDirs) if (await isFile(path.join(dir, 'skills', s, 'SKILL.md'))) skills.push(s)
  let hooks = countHooks(hooksJson)
  if (hooks.n === 0 && isObj(manifest) && manifest.hooks) hooks = countHooks(manifest.hooks)
  const servers = isObj(mcpJson) ? (isObj(mcpJson.mcpServers) ? mcpJson.mcpServers : mcpJson) : {}
  const mcpServers = Object.keys(servers).filter((k) => isObj(servers[k]))
  return {
    skills,
    agents: agentFiles.map((f) => f.name),
    commands: commandFiles.map((f) => f.name.replace(/\//g, ':')),
    hooks: hooks.n,
    hookEvents: hooks.events,
    mcpServers,
    mod: isObj(hooksJson) && Array.isArray(hooksJson.modules)
  }
}

function authorOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (isObj(v)) return str(v.name)
  return ''
}

async function toInfo(rec: PluginRecord, enabledPlugins: Record<string, boolean>): Promise<PluginInfo> {
  const manifest = rec.exists ? await readJson<unknown>(path.join(rec.dir, '.claude-plugin', 'plugin.json')) : undefined
  const m = isObj(manifest) ? manifest : {}
  const state = rec.key in enabledPlugins ? (enabledPlugins[rec.key] ? 'on' : 'off') : 'unset'
  return {
    key: rec.key,
    name: rec.name,
    marketplace: rec.marketplace,
    version: rec.version,
    scope: rec.scope,
    state,
    enabled: state === 'on',
    installed: true,
    description: str(m.description),
    author: authorOf(m.author),
    homepage: str(m.homepage),
    license: str(m.license),
    installedAt: rec.installedAt,
    lastUpdated: rec.lastUpdated,
    gitCommitSha: rec.gitCommitSha,
    dir: rec.dir,
    rel: isInside(configDir(), rec.dir) ? toPosix(path.relative(configDir(), rec.dir)) : null,
    contents: rec.exists ? await contentsOf(rec.dir) : null
  }
}

function describeSource(src: unknown): { kind: string; text: string } {
  if (!isObj(src)) return { kind: 'unknown', text: typeof src === 'string' ? src : '' }
  const kind = str(src.source) || 'unknown'
  const text = str(src.repo) || str(src.url) || str(src.path) || str(src.package) || ''
  return { kind, text }
}

async function marketplaces(settings: Record<string, unknown>, plugins: PluginInfo[]): Promise<MarketplaceInfo[]> {
  const known = await readJson<unknown>(path.join(configDir(), 'plugins', 'known_marketplaces.json'))
  const knownMap = isObj(known) ? known : {}
  const extra = isObj(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {}
  const names = Array.from(new Set([...Object.keys(knownMap), ...Object.keys(extra)]))
  const out = await Promise.all(
    names.map(async (name): Promise<MarketplaceInfo> => {
      const k = isObj(knownMap[name]) ? knownMap[name] : null
      const e = isObj(extra[name]) ? extra[name] : null
      const src = describeSource(k?.source ?? e?.source)
      const installLocation = str(k?.installLocation) || str(isObj(e?.source) ? e.source.path : '')
      let pluginCount: number | null = null
      if (installLocation) {
        const mj = await readJson<unknown>(path.join(installLocation, '.claude-plugin', 'marketplace.json'))
        if (isObj(mj) && Array.isArray(mj.plugins)) pluginCount = mj.plugins.length
      }
      return {
        name,
        sourceKind: src.kind,
        sourceText: src.text,
        installLocation,
        lastUpdated: str(k?.lastUpdated) || undefined,
        pluginCount,
        installed: plugins.filter((p) => p.marketplace === name).map((p) => p.key),
        known: !!k,
        inSettings: !!e
      }
    })
  )
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function list(): Promise<PluginList> {
  const { data, error } = await readSettings()
  const ep = enabledMap(data)
  const records = await installedPlugins()
  const installed = await Promise.all(records.map((r) => toInfo(r, ep)))
  // enabled in settings.json but not in installed_plugins.json (built-in plugins, or removed ones)
  const extra: PluginInfo[] = Object.keys(ep)
    .filter((k) => !records.some((r) => r.key === k))
    .map((key) => {
      const { name, marketplace } = splitPluginKey(key)
      return {
        key,
        name,
        marketplace,
        version: '',
        scope: 'user',
        state: ep[key] ? ('on' as const) : ('off' as const),
        enabled: ep[key],
        installed: false,
        description: marketplace === 'builtin' ? 'Built into Claude Code.' : 'Listed in settings.json but not installed.',
        author: '',
        homepage: '',
        license: '',
        dir: '',
        rel: null,
        contents: null
      }
    })
  const plugins = [...installed, ...extra]
  return { plugins, marketplaces: await marketplaces(data, plugins), settingsError: error }
}

const impl: PluginsApi = {
  list,

  async setEnabled(key, enabled) {
    if (typeof key !== 'string' || !/^[^@\s]+(@[^@\s]+)?$/.test(key)) throw new Error('Invalid plugin key')
    const r = await updateSettings((s) => {
      const cur = isObj(s.enabledPlugins) ? { ...s.enabledPlugins } : {}
      if (cur[key] === enabled) return false
      cur[key] = enabled
      s.enabledPlugins = cur
      return true
    }, `${enabled ? 'Enable' : 'Disable'} plugin ${key}`)
    return { snapshotId: r.snapshotId }
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'plugins', impl)
}

/** Sidebar badge: number of installed plugins. */
export async function count(): Promise<number> {
  return (await installedPlugins()).length
}
