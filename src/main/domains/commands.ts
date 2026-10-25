import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parseCommandName, type CommandDoc, type CommandFields, type CommandInfo, type CommandList, type CommandsApi } from '@shared/api/commands'
import { parseFrontmatter } from '@shared/frontmatter'
import { exists } from '../fsx'
import { defineDomain } from '../ipcx'
import { assertWritable, configDir, resolveInside } from '../paths'
import { safeWriteText, snapshot, trash } from '../safeWrite'
import {
  applyForm,
  asString,
  collectMd,
  installedPlugins,
  readCapped,
  readHead,
  resolveUnder,
  saveText,
  toPosix,
  type MdRef
} from './extendShared'

const KNOWN = ['description', 'argument-hint', 'allowed-tools', 'model']

function fieldsFrom(data: Record<string, string | string[]>): CommandFields {
  return {
    description: asString(data.description).trim(),
    argumentHint: asString(data['argument-hint']).trim(),
    allowedTools: asString(data['allowed-tools']).trim(),
    model: asString(data.model).trim()
  }
}

async function toInfo(ref: MdRef, source: 'user' | 'plugin', label: string, plugin?: string): Promise<CommandInfo> {
  const fm = parseFrontmatter(await readHead(ref.abs).catch(() => ''))
  const name = (plugin ? [plugin, ...ref.name.split('/')] : ref.name.split('/')).join(':')
  return { ...fieldsFrom(fm.data), id: ref.rel, name, source, label, plugin, readOnly: source === 'plugin', path: ref.abs, size: ref.size, mtimeMs: ref.mtimeMs }
}

async function list(): Promise<CommandList> {
  const user = await collectMd(path.join(configDir(), 'commands'), { maxDepth: 4 })
  const plugins = (await installedPlugins()).filter((p) => p.exists)
  const pluginRefs = await Promise.all(
    plugins.map(async (p) => ({ p, refs: await collectMd(path.join(p.dir, 'commands'), { maxDepth: 3, max: 400 }) }))
  )
  const commands = await Promise.all([
    ...user.map((r) => toInfo(r, 'user', 'user')),
    ...pluginRefs.flatMap(({ p, refs }) => refs.map((r) => toInfo(r, 'plugin', p.name, p.name)))
  ])
  return { commands }
}

function resolveCommand(id: string, writable: boolean): { abs: string; rel: string } {
  const r = resolveUnder(id, writable ? ['commands'] : ['commands', 'plugins/cache'])
  if (!/\.md$/i.test(r.abs)) throw new Error('Commands are Markdown files')
  return r
}

const template = (): string =>
  `---\ndescription: Describe what this command does\nargument-hint: "[arguments]"\n---\n\nWrite the prompt Claude should run. Use $ARGUMENTS for what you type after the command.\n`

function relFor(name: string): { parts: string[]; rel: string } {
  const p = parseCommandName(name)
  if ('error' in p) throw new Error(p.error)
  return { parts: p.parts, rel: `commands/${p.parts.join('/')}.md` }
}

const impl: CommandsApi = {
  list,

  async read(id) {
    const { abs } = resolveCommand(id, false)
    const c = await readCapped(abs)
    const fm = parseFrontmatter(c.text)
    const extra: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(fm.data)) if (!KNOWN.includes(k)) extra[k] = v
    const doc: CommandDoc = { id, text: c.text, body: fm.body, fields: fieldsFrom(fm.data), extra, hasFrontmatter: fm.raw !== null, size: c.size, mtimeMs: c.mtimeMs, truncated: c.truncated }
    return doc
  },

  async save(id, input) {
    const { abs, rel } = resolveCommand(id, true)
    const c = await readCapped(abs, 4_000_000)
    if (c.truncated) throw new Error('This file is too large to edit here')
    const cur = fieldsFrom(parseFrontmatter(c.text).data)
    const f = input.fields
    const changes: Record<string, string | null> = {}
    const map: Array<[keyof CommandFields, string]> = [
      ['description', 'description'],
      ['argumentHint', 'argument-hint'],
      ['allowedTools', 'allowed-tools'],
      ['model', 'model']
    ]
    for (const [field, key] of map) {
      const v = f[field].trim()
      if (v !== cur[field]) changes[key] = v || null
    }
    const text = applyForm(c.text, changes, input.body)
    return saveText(rel, text, input.baseMtimeMs, `Edit command ${path.basename(abs, '.md')}`)
  },

  async saveRaw(id, text, baseMtimeMs) {
    const { abs, rel } = resolveCommand(id, true)
    if (typeof text !== 'string') throw new Error('Nothing to save')
    return saveText(rel, text, baseMtimeMs, `Edit command ${path.basename(abs, '.md')}`)
  },

  async create(name) {
    assertWritable()
    const { rel, parts } = relFor(name)
    if (await exists(resolveInside(rel))) throw new Error(`/${parts.join(':')} already exists`)
    await safeWriteText(rel, template(), `Create command /${parts.join(':')}`)
    return { id: rel }
  },

  async rename(id, name) {
    assertWritable()
    const from = resolveCommand(id, true)
    const to = relFor(name)
    if (to.rel === from.rel) return { id }
    const toAbs = resolveInside(to.rel)
    if (await exists(toAbs)) throw new Error(`/${to.parts.join(':')} already exists`)
    const c = await readCapped(from.abs, 4_000_000)
    if (c.truncated) throw new Error('This file is too large to move here')
    // snapshot the old file, write the new one, then send the old one to the Trash (restorable)
    await snapshot([from.rel], `Rename command ${path.basename(from.abs, '.md')} to /${to.parts.join(':')}`)
    await safeWriteText(to.rel, c.text, `Rename command to /${to.parts.join(':')}`)
    await trash(from.rel)
    return { id: toPosix(to.rel) }
  },

  async trash(id) {
    const { rel } = resolveCommand(id, true)
    await trash(rel)
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'commands', impl)
}

/** Sidebar badge: number of user commands. */
export async function count(): Promise<number> {
  async function walk(dir: string, depth: number): Promise<number> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    let n = 0
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isDirectory() && depth < 4) n += await walk(path.join(dir, e.name), depth + 1)
      else if (!e.isDirectory() && /\.md$/i.test(e.name)) n++
    }
    return n
  }
  return walk(path.join(configDir(), 'commands'), 0)
}
