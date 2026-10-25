import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { RESERVED_NAME_ERROR, isReservedName } from '@shared/names'
import { AGENT_NAME_RE, type AgentDoc, type AgentFields, type AgentInfo, type AgentList, type AgentsApi } from '@shared/api/agents'
import { parseFrontmatter } from '@shared/frontmatter'
import { exists } from '../fsx'
import { defineDomain } from '../ipcx'
import { assertWritable, configDir } from '../paths'
import { safeWriteText, trash } from '../safeWrite'
import {
  applyForm,
  asString,
  collectMd,
  freePath,
  installedPlugins,
  normList,
  readCapped,
  readHead,
  renameInText,
  resolveUnder,
  saveText,
  toPosix,
  type MdRef
} from './extendShared'

function fieldsFrom(data: Record<string, string | string[]>, fallbackName: string): AgentFields {
  return {
    name: asString(data.name).trim() || fallbackName,
    description: asString(data.description).trim(),
    model: asString(data.model).trim(),
    tools: normList(data.tools),
    color: asString(data.color).trim()
  }
}

async function toInfo(ref: MdRef, source: 'user' | 'plugin', label: string, plugin?: string): Promise<AgentInfo> {
  const fm = parseFrontmatter(await readHead(ref.abs).catch(() => ''))
  const base = path.basename(ref.abs).replace(/\.md$/i, '')
  return { ...fieldsFrom(fm.data, base), id: ref.rel, source, label, plugin, readOnly: source === 'plugin', path: ref.abs, size: ref.size, mtimeMs: ref.mtimeMs }
}

async function list(): Promise<AgentList> {
  const user = await collectMd(path.join(configDir(), 'agents'), { maxDepth: 3 })
  const plugins = (await installedPlugins()).filter((p) => p.exists)
  const pluginRefs = await Promise.all(
    plugins.map(async (p) => ({ p, refs: await collectMd(path.join(p.dir, 'agents'), { maxDepth: 2, max: 300 }) }))
  )
  const agents = await Promise.all([
    ...user.map((r) => toInfo(r, 'user', 'user')),
    ...pluginRefs.flatMap(({ p, refs }) => refs.map((r) => toInfo(r, 'plugin', p.name, p.name)))
  ])
  return { agents }
}

function resolveAgent(id: string, writable: boolean): { abs: string; rel: string } {
  const r = resolveUnder(id, writable ? ['agents'] : ['agents', 'plugins/cache'])
  if (!/\.md$/i.test(r.abs)) throw new Error('Agents are Markdown files')
  return r
}

const template = (name: string): string =>
  `---\nname: ${name}\ndescription: Describe when Claude should hand work to this agent.\ntools: Read, Grep, Glob\nmodel: inherit\n---\n\nYou are a specialist agent. Describe your role, how you work and what you report back.\n`

const impl: AgentsApi = {
  list,

  async read(id) {
    const { abs } = resolveAgent(id, false)
    const c = await readCapped(abs)
    const fm = parseFrontmatter(c.text)
    const fields = fieldsFrom(fm.data, path.basename(abs).replace(/\.md$/i, ''))
    const extra: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(fm.data)) if (!['name', 'description', 'model', 'tools', 'color'].includes(k)) extra[k] = v
    const doc: AgentDoc = { id, text: c.text, body: fm.body, fields, extra, hasFrontmatter: fm.raw !== null, size: c.size, mtimeMs: c.mtimeMs, truncated: c.truncated }
    return doc
  },

  async save(id, input) {
    const { abs, rel } = resolveAgent(id, true)
    const c = await readCapped(abs, 4_000_000)
    if (c.truncated) throw new Error('This file is too large to edit here')
    const fm = parseFrontmatter(c.text)
    const cur = fieldsFrom(fm.data, '')
    const f = input.fields
    const changes: Record<string, string | null> = {}
    const name = f.name.trim()
    if (!name) throw new Error('Enter a name.')
    if (name !== cur.name) {
      if (!AGENT_NAME_RE.test(name)) throw new Error('The name uses lowercase letters, numbers and hyphens (up to 64).')
      if (isReservedName(name)) throw new Error(RESERVED_NAME_ERROR)
      changes.name = name
    }
    if (f.description.trim() !== cur.description) changes.description = f.description.trim() || null
    if (f.model.trim() !== cur.model) changes.model = f.model.trim() || null
    if (f.color.trim() !== cur.color) changes.color = f.color.trim() || null
    if (f.tools.join(',') !== cur.tools.join(',')) changes.tools = f.tools.length ? f.tools.join(', ') : null
    const text = applyForm(c.text, changes, input.body)
    return saveText(rel, text, input.baseMtimeMs, `Edit agent ${path.basename(abs, '.md')}`)
  },

  async saveRaw(id, text, baseMtimeMs) {
    const { abs, rel } = resolveAgent(id, true)
    if (typeof text !== 'string') throw new Error('Nothing to save')
    return saveText(rel, text, baseMtimeMs, `Edit agent ${path.basename(abs, '.md')}`)
  },

  async create(name) {
    assertWritable()
    if (!AGENT_NAME_RE.test(name)) throw new Error('Use lowercase letters, numbers and hyphens (up to 64).')
    if (isReservedName(name)) throw new Error(RESERVED_NAME_ERROR)
    const rel = `agents/${name}.md`
    if (await exists(path.join(configDir(), 'agents', `${name}.md`))) throw new Error(`An agent named ${name} already exists`)
    await safeWriteText(rel, template(name), `Create agent ${name}`)
    return { id: rel }
  },

  async duplicate(id) {
    assertWritable()
    const { abs } = resolveAgent(id, false)
    const c = await readCapped(abs, 4_000_000)
    const base = path.basename(abs).replace(/\.md$/i, '')
    const { stem } = await freePath(path.join(configDir(), 'agents'), `${base}-copy`, '.md')
    const rel = `agents/${stem}.md`
    await safeWriteText(rel, renameInText(c.text, stem), `Duplicate agent ${base}`)
    return { id: toPosix(rel) }
  },

  async trash(id) {
    const { rel } = resolveAgent(id, true)
    await trash(rel)
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'agents', impl)
}

/** Sidebar badge: number of user agents. */
export async function count(): Promise<number> {
  const entries = await fsp.readdir(path.join(configDir(), 'agents')).catch(() => [] as string[])
  return entries.filter((n) => /\.md$/i.test(n) && !n.startsWith('.')).length
}
