import fsp from 'node:fs/promises'
import path from 'node:path'
import type { TeamRemote } from '../../shared/api/team.ts'
import { MANIFEST_NAME, parseManifest, parseRemote, pluginDir, sha256, type RepoView } from './model.ts'

/**
 * Reading the team folder (src/main/domains/team.ts) as plain files: the plugin folder's files and their hashes, the
 * JSON files a write merges into, and the `origin` remote from `.git/config`. Claudock never runs git. Plain Node, so
 * `npm test` runs it on temp folders.
 */

/** Files under the plugin folder looked at; a bigger repo is still read, the rest is just not compared. */
const MAX_FILES = 5000
const MAX_JSON = 2_000_000

async function json(abs: string): Promise<unknown> {
  try {
    const st = await fsp.lstat(abs)
    if (!st.isFile() || st.size > MAX_JSON) return undefined
    return JSON.parse(await fsp.readFile(abs, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Every plain file below `root` (links and dot-folders other than `.claude-plugin` skipped), relative with forward slashes. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (out.length >= MAX_FILES) return
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules' || (e.name.startsWith('.') && e.name !== '.claude-plugin')) continue
        await walk(path.join(dir, e.name), r)
      } else if (e.isFile() && !/\.tmp$/.test(e.name) && e.name !== '.DS_Store') out.push(r)
    }
  }
  await walk(root, '')
  return out
}

/** The repo as it is now: what `stateOf` and `buildPlan` compare against. */
export async function readRepo(dir: string, plugin: string): Promise<RepoView> {
  const root = path.join(dir, ...pluginDir(plugin).split('/'))
  const files = new Map<string, string>()
  for (const rel of await listFiles(root)) {
    if (rel === MANIFEST_NAME) continue
    const data = await fsp.readFile(path.join(root, ...rel.split('/'))).catch(() => null)
    if (data) files.set(rel, sha256(data))
  }
  const readme = await fsp
    .readdir(dir)
    .then((names) => names.some((n) => /^readme(\.[a-z]+)?$/i.test(n)))
    .catch(() => false)
  return {
    files,
    manifest: parseManifest(await json(path.join(root, MANIFEST_NAME))),
    hooks: await json(path.join(root, 'hooks', 'hooks.json')),
    mcp: await json(path.join(root, '.mcp.json')),
    pluginJson: await json(path.join(root, '.claude-plugin', 'plugin.json')),
    marketplace: await json(path.join(dir, '.claude-plugin', 'marketplace.json')),
    readme
  }
}

/** A file of the team folder (root-relative) as bytes; null when missing or not a plain file. */
export async function readRepoFile(dir: string, rel: string): Promise<Buffer | null> {
  const abs = path.join(dir, ...rel.split('/'))
  const st = await fsp.lstat(abs).catch(() => null)
  if (!st?.isFile() || st.size > 20_000_000) return null
  return fsp.readFile(abs).catch(() => null)
}

/** The folder git keeps its data in: `.git`, or where a `.git` file (a worktree, a submodule) points. Null when not a repo. */
export async function gitDirOf(dir: string): Promise<string | null> {
  const dot = path.join(dir, '.git')
  const st = await fsp.lstat(dot).catch(() => null)
  if (!st) return null
  if (st.isDirectory()) return dot
  if (!st.isFile()) return null
  const m = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(dot, 'utf8').catch(() => ''))
  if (!m) return null
  const gd = path.resolve(dir, m[1].trim())
  // a worktree keeps the remotes in the main repository's folder
  const common = (await fsp.readFile(path.join(gd, 'commondir'), 'utf8').catch(() => '')).trim()
  return common ? path.resolve(gd, common) : gd
}

/** The folder's `origin` remote, read from its git config as a file; null when it has none or is not a repo. */
export async function readRemote(dir: string): Promise<TeamRemote | null> {
  const gd = await gitDirOf(dir)
  if (!gd) return null
  const text = await fsp.readFile(path.join(gd, 'config'), 'utf8').catch(() => '')
  return parseRemote(text)
}

/** The marketplace and plugin names an existing marketplace in the folder already uses, when Claudock wrote one there. */
export async function existingNames(dir: string): Promise<{ marketplace: string; plugin: string; owner: string } | null> {
  const m = await json(path.join(dir, '.claude-plugin', 'marketplace.json'))
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null
  const market = m as Record<string, unknown>
  const name = typeof market.name === 'string' ? market.name : ''
  const owner = typeof market.owner === 'object' && market.owner !== null && typeof (market.owner as Record<string, unknown>).name === 'string' ? ((market.owner as Record<string, unknown>).name as string) : ''
  for (const p of Array.isArray(market.plugins) ? market.plugins : []) {
    if (typeof p !== 'object' || p === null) continue
    const plugin = (p as Record<string, unknown>).name
    if (typeof plugin !== 'string' || !/^[a-z0-9-]+$/.test(plugin)) continue
    const st = await fsp.lstat(path.join(dir, 'plugins', plugin, MANIFEST_NAME)).catch(() => null)
    if (st?.isFile()) return { marketplace: name, plugin, owner }
  }
  return null
}
