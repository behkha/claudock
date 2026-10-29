import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  SKILL_NAME_RE,
  type FileEntry,
  type SkillDoc,
  type SkillInfo,
  type SkillList,
  type SkillsApi
} from '@shared/api/skills'
import { parseFrontmatter } from '@shared/frontmatter'
import { RESERVED_NAME_ERROR, isReservedName } from '@shared/names'
import { dirSize, exists, listDir, readJson, stat } from '../fsx'
import { defineDomain } from '../ipcx'
import { assertWritable, configDir, isSecretReal, resolveInside } from '../paths'
import { safeWriteText, trash } from '../safeWrite'
import {
  childDirs,
  enabledMap,
  freePath,
  installedPlugins,
  isDirectory,
  isFile,
  isObj,
  readCapped,
  readHead,
  readSettings,
  renameInText,
  resolveUnder,
  saveText,
  toPosix,
  updateSettings
} from './extendShared'

const MAX_DUPLICATE_BYTES = 512 * 1024 * 1024

const SKILL_FILE_NAMES = ['SKILL.md', 'skill.md', 'Skill.md']

async function findSkillFile(dir: string): Promise<string | null> {
  for (const n of SKILL_FILE_NAMES) {
    const p = path.join(dir, n)
    if (await isFile(p)) return p
  }
  return null
}

const rel = (abs: string): string => toPosix(path.relative(configDir(), abs))

interface Found {
  dir: string
  file: string
  folder: string
}

async function skillsIn(root: string): Promise<Found[]> {
  const names = await childDirs(root)
  const found = await Promise.all(
    names.map(async (folder): Promise<Found | null> => {
      const dir = path.join(root, folder)
      const file = await findSkillFile(dir)
      return file ? { dir, file, folder } : null
    })
  )
  return found.filter((f): f is Found => f !== null)
}

async function describe(f: Found): Promise<{ name: string; description: string; modelHidden: boolean; mtimeMs: number; symlink: boolean }> {
  const [head, st, lst] = await Promise.all([readHead(f.file).catch(() => ''), fsp.stat(f.file).catch(() => null), stat(f.dir)])
  const fm = parseFrontmatter(head)
  const name = typeof fm.data.name === 'string' && fm.data.name.trim() ? fm.data.name.trim() : f.folder
  const d = fm.data.description
  const description = (Array.isArray(d) ? d.join(' ') : (d ?? '')).toString().trim()
  const modelHidden = fm.data['disable-model-invocation'] === 'true'
  return { name, description, modelHidden, mtimeMs: st?.mtimeMs ?? 0, symlink: !!lst?.isSymlink }
}

/* ------------------------------------------------------------------ listing */

export async function scanUser(overrides: Record<string, unknown>): Promise<SkillInfo[]> {
  const root = path.join(configDir(), 'skills')
  const names = (await childDirs(root)).filter((n) => n !== 'synced')
  const out = await Promise.all(
    names.map(async (folder): Promise<SkillInfo | null> => {
      const dir = path.join(root, folder)
      const file = await findSkillFile(dir)
      if (!file) return null
      const d = await describe({ dir, file, folder })
      const ov = typeof overrides[d.name] === 'string' ? (overrides[d.name] as string) : undefined
      return {
        id: rel(dir),
        key: d.name,
        name: d.name,
        source: 'user',
        label: 'user',
        description: d.description,
        modelHidden: d.modelHidden,
        enabled: ov !== 'off',
        override: ov,
        rel: rel(dir),
        dir,
        skillFile: rel(file),
        mtimeMs: d.mtimeMs,
        symlink: d.symlink,
        readOnly: false
      }
    })
  )
  return out.filter((s): s is SkillInfo => s !== null)
}

async function scanSynced(overrides: Record<string, unknown>): Promise<SkillInfo[]> {
  const root = path.join(configDir(), 'skills', 'synced')
  const buckets = await childDirs(root)
  const byName = new Map<string, { f: Found; mtimeMs: number; count: number; bucket: string }>()
  for (const bucket of buckets) {
    for (const f of await skillsIn(path.join(root, bucket))) {
      const st = await fsp.stat(f.file).catch(() => null)
      const mtimeMs = st?.mtimeMs ?? 0
      const prev = byName.get(f.folder)
      if (!prev) byName.set(f.folder, { f, mtimeMs, count: 1, bucket })
      else {
        prev.count++
        if (mtimeMs > prev.mtimeMs) Object.assign(prev, { f, mtimeMs, bucket })
      }
    }
  }
  const manifests = new Map<string, Record<string, string>>()
  async function sourceOf(bucket: string, folder: string): Promise<string | undefined> {
    if (!manifests.has(bucket)) {
      const m = await readJson<unknown>(path.join(root, bucket, 'manifest.json'))
      const map: Record<string, string> = {}
      if (isObj(m) && Array.isArray(m.skills)) {
        for (const s of m.skills) {
          if (isObj(s) && typeof s.skillId === 'string' && typeof s.source === 'string') map[s.skillId] = s.source
        }
      }
      manifests.set(bucket, map)
    }
    return manifests.get(bucket)?.[folder]
  }
  const out: SkillInfo[] = []
  for (const [, v] of byName) {
    const d = await describe(v.f)
    const ov = typeof overrides[d.name] === 'string' ? (overrides[d.name] as string) : undefined
    out.push({
      id: rel(v.f.dir),
      key: d.name,
      name: d.name,
      source: 'synced',
      label: 'synced',
      description: d.description,
      modelHidden: d.modelHidden,
      enabled: ov !== 'off',
      override: ov,
      rel: rel(v.f.dir),
      dir: v.f.dir,
      skillFile: rel(v.f.file),
      mtimeMs: d.mtimeMs,
      symlink: d.symlink,
      copies: v.count,
      syncSource: await sourceOf(v.bucket, v.f.folder),
      readOnly: true
    })
  }
  return out
}

async function scanPlugins(overrides: Record<string, unknown>, enabledPlugins: Record<string, boolean>): Promise<SkillInfo[]> {
  const plugins = await installedPlugins()
  const perPlugin = await Promise.all(
    plugins
      .filter((p) => p.exists)
      .map(async (p) => {
        const found = await skillsIn(path.join(p.dir, 'skills'))
        const pluginEnabled = enabledPlugins[p.key] === true
        return Promise.all(
          found.map(async (f): Promise<SkillInfo> => {
            const d = await describe(f)
            const key = `${p.name}:${d.name}`
            const ov = typeof overrides[key] === 'string' ? (overrides[key] as string) : undefined
            return {
              id: rel(f.dir),
              key,
              name: d.name,
              source: 'plugin',
              label: p.name,
              plugin: p.name,
              pluginEnabled,
              description: d.description,
              modelHidden: d.modelHidden,
              enabled: ov !== 'off' && pluginEnabled,
              override: ov,
              rel: rel(f.dir),
              dir: f.dir,
              skillFile: rel(f.file),
              mtimeMs: d.mtimeMs,
              symlink: d.symlink,
              readOnly: true
            }
          })
        )
      })
  )
  return perPlugin.flat()
}

/** Every skill of the open profile, as the Skills screen lists it (also what the Context screen measures). */
export async function listSkills(): Promise<SkillList> {
  const { data, error } = await readSettings()
  const overrides = isObj(data.skillOverrides) ? data.skillOverrides : {}
  const ep = enabledMap(data)
  const [user, synced, plugin] = await Promise.all([scanUser(overrides), scanSynced(overrides), scanPlugins(overrides, ep)])
  const all = [...user, ...synced, ...plugin]
  const known = new Set(all.map((s) => s.key))
  const stale: SkillInfo[] = Object.entries(overrides)
    .filter(([k]) => !known.has(k))
    .map(([k, v]) => ({
      id: `override:${k}`,
      key: k,
      name: k,
      source: 'override' as const,
      label: 'override only',
      description: '',
      enabled: v !== 'off',
      override: typeof v === 'string' ? v : String(v),
      rel: '',
      dir: '',
      skillFile: '',
      mtimeMs: 0,
      symlink: false,
      readOnly: true
    }))
  const byName = (a: SkillInfo, b: SkillInfo): number => a.name.localeCompare(b.name)
  return { skills: [...user.sort(byName), ...synced.sort(byName), ...plugin.sort(byName), ...stale.sort(byName)], settingsError: error }
}

/* ------------------------------------------------------------------ helpers for one skill */

async function skillDir(id: string): Promise<{ abs: string; rel: string; user: boolean }> {
  const r = resolveUnder(id, ['skills', 'plugins/cache'])
  const parts = r.rel.split('/')
  // Our own skill: exactly skills/<folder>, not the synced container (compared case-insensitively), and it has a SKILL.md.
  const shape = parts.length === 2 && parts[0] === 'skills' && parts[1].toLowerCase() !== 'synced'
  if (!(await isDirectory(r.abs))) throw new Error('This skill no longer exists')
  const user = shape && (await findSkillFile(r.abs)) !== null
  return { ...r, user }
}

function inside(root: string, abs: string): boolean {
  const r = path.relative(root, abs)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

async function realDir(abs: string): Promise<string> {
  try {
    return await fsp.realpath(abs)
  } catch {
    return abs
  }
}

const template = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nWrite the instructions Claude should follow when this skill is used.\n`

const impl: SkillsApi = {
  list: listSkills,

  async read(id) {
    const d = await skillDir(id)
    const file = await findSkillFile(d.abs)
    if (!file) throw new Error('SKILL.md not found')
    const c = await readCapped(file)
    const doc: SkillDoc = { id, text: c.text, size: c.size, mtimeMs: c.mtimeMs, truncated: c.truncated }
    return doc
  },

  async save(id, text, baseMtimeMs) {
    const d = await skillDir(id)
    if (!d.user) throw new Error('Only your own skills can be edited here')
    const file = await findSkillFile(d.abs)
    if (!file) throw new Error('SKILL.md not found')
    if (typeof text !== 'string') throw new Error('Nothing to save')
    return saveText(toPosix(path.relative(configDir(), file)), text, baseMtimeMs, `Edit skill ${path.basename(d.abs)}`)
  },

  async setEnabled(keys, enabled) {
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !k)) throw new Error('Invalid skill names')
    const unique = Array.from(new Set(keys))
    let changed = 0
    const r = await updateSettings((s) => {
      const cur = isObj(s.skillOverrides) ? { ...s.skillOverrides } : {}
      for (const k of unique) {
        if (enabled) {
          // turning on = removing the override, unless it is already something other than "off"
          if (cur[k] === 'off') {
            delete cur[k]
            changed++
          }
        } else if (cur[k] !== 'off') {
          cur[k] = 'off'
          changed++
        }
      }
      if (changed === 0) return false
      s.skillOverrides = cur
      return true
    }, `${enabled ? 'Turn on' : 'Turn off'} ${unique.length === 1 ? `skill ${unique[0]}` : `${unique.length} skills`}`)
    return { snapshotId: r.snapshotId, changed }
  },

  async size(id) {
    const d = await skillDir(id)
    const s = await dirSize(await realDir(d.abs))
    return { bytes: s.bytes, files: s.files }
  },

  async files(id, sub) {
    const d = await skillDir(id)
    const target = sub ? path.resolve(d.abs, sub) : d.abs
    if (!inside(d.abs, target)) throw new Error('Path is outside the skill')
    const entries = await listDir(target)
    const out: FileEntry[] = entries
      .filter((e) => !e.secret)
      .map((e) => ({
        name: e.name,
        rel: toPosix(path.relative(configDir(), path.join(target, e.name))),
        isDir: e.isDir,
        size: e.isDir ? null : e.size,
        symlink: e.isSymlink
      }))
    // a symlink to a folder shows as a folder
    await Promise.all(
      out.map(async (e) => {
        if (e.symlink && !e.isDir && (await isDirectory(resolveInside(e.rel)))) {
          e.isDir = true
          e.size = null
        }
      })
    )
    return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  },

  async dirSize(id, sub) {
    const d = await skillDir(id)
    const target = path.resolve(d.abs, sub || '.')
    if (!inside(d.abs, target)) throw new Error('Path is outside the skill')
    const s = await dirSize(await realDir(target))
    return s.bytes
  },

  async duplicate(id) {
    assertWritable()
    const d = await skillDir(id)
    const file = await findSkillFile(d.abs)
    if (!file) throw new Error('SKILL.md not found')
    const baseName = path.basename(d.abs)
    const root = path.join(configDir(), 'skills')
    const { abs: dest, stem } = await freePath(root, `${baseName}-copy`)
    const srcRoot = await realDir(d.abs)
    const skipFile = path.join(srcRoot, path.basename(file))
    const total = await dirSize(srcRoot, { force: true })
    if (total.bytes > MAX_DUPLICATE_BYTES) throw new Error(`This skill is ${Math.round(total.bytes / 1_000_000)} MB, too large to duplicate here. Copy it in your file manager.`)
    const destRel = toPosix(path.relative(configDir(), dest))
    try {
      // Symlinks inside the skill are copied AS symlinks (never followed): a link to a credentials file or to a parent
      // folder can neither leak a secret into the copy nor make the copy recurse forever.
      await fsp.cp(srcRoot, dest, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
        filter: async (src) => path.resolve(src) !== skipFile && !(await isSecretReal(src))
      })
      const text = (await readCapped(file, 4_000_000)).text
      await safeWriteText(`${destRel}/SKILL.md`, renameInText(text, stem), `Duplicate skill ${baseName}`)
    } catch (e) {
      // do not leave a half-copied folder behind (to the Trash, like every delete)
      if (await exists(dest)) await trash(destRel).catch(() => undefined)
      throw e
    }
    return { id: destRel, name: stem }
  },

  async create(name, description) {
    assertWritable()
    if (!SKILL_NAME_RE.test(name)) throw new Error('Use lowercase letters, numbers and hyphens (up to 64).')
    if (isReservedName(name)) throw new Error(RESERVED_NAME_ERROR)
    const dir = path.join(configDir(), 'skills', name)
    if (await exists(dir)) throw new Error(`A skill named ${name} already exists`)
    const desc = (description ?? '').replace(/\s+/g, ' ').trim() || 'Describe what this skill does and when Claude should use it.'
    const file = `skills/${name}/SKILL.md`
    const text = template(name, /[:#]\s|^[\s[\]{}&*!|>'"%@`-]/.test(desc) ? JSON.stringify(desc) : desc)
    await safeWriteText(file, text, `Create skill ${name}`)
    return { id: `skills/${name}` }
  },

  async trash(id) {
    const d = await skillDir(id)
    if (!d.user) throw new Error('Only your own skills can be moved to the Trash here')
    await trash(d.rel)
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'skills', impl)
}

/** Sidebar badge: number of user skills. */
export async function count(): Promise<number> {
  const names = (await childDirs(path.join(configDir(), 'skills'))).filter((n) => n !== 'synced')
  const flags = await Promise.all(names.map(async (n) => (await findSkillFile(path.join(configDir(), 'skills', n))) !== null))
  return flags.filter(Boolean).length
}
