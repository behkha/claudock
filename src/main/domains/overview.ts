import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import type { Finding, OverviewApi, OverviewSummary } from '@shared/api/overview'
import { formatBytes, formatCount } from '@shared/format'
import { exists, readJson, stat } from '../fsx'
import { defineDomain, emit } from '../ipcx'
import { assertWritable, configDir, globalStateFile, isSecret, resolveInside } from '../paths'
import { safeWriteText, trash } from '../safeWrite'
import { scanLoose } from './backups'
import { scanUser } from './skills'
import { sizeOf } from './storage'

const MB = 1024 * 1024
const DAY = 86_400_000
/** Thresholds from the spec. */
const BIG_PROJECT = 500 * MB
const BIG_OFF_SKILL = 50 * MB
const BIG_FOLDER = 100 * MB
const BIG_LOG = 1 * MB
const OLD_BUILD_AGE = 30 * DAY

const rel = (...parts: string[]): string => path.join(...parts)
const abs = (...parts: string[]): string => path.join(configDir(), ...parts)

/* ------------------------------------------------------------------ findings */

/** Real working directory of a project folder: the `cwd` of the first transcript line that has one (head only). */
async function projectCwd(folderAbs: string): Promise<string | null> {
  try {
    const names = (await fsp.readdir(folderAbs)).filter((n) => n.endsWith('.jsonl'))
    for (const name of names.slice(0, 3)) {
      const fh = await fsp.open(path.join(folderAbs, name), 'r')
      try {
        const buf = Buffer.alloc(64 * 1024)
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
        const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, bytesRead))
        if (m) return JSON.parse(m[1]) as string
      } finally {
        await fh.close()
      }
    }
  } catch {
    /* unreadable: fall back to the folder name */
  }
  return null
}

const plural = (n: number, one: string, many = one + 's'): string => `${formatCount(n)} ${n === 1 ? one : many}`

type Push = (f: Finding) => void

async function bigProjects(push: Push, force?: boolean): Promise<void> {
  const projects = abs('projects')
  const names = await fsp.readdir(projects).catch(() => [] as string[])
  // one walk over projects/ fills the size cache; the per-folder lookups below are then cache hits
  await sizeOf(projects, { force })
  await Promise.all(
    names.map(async (name) => {
      const folder = path.join(projects, name)
      const st = await stat(folder)
      if (!st?.isDir) return
      const size = await sizeOf(folder)
      if (size.bytes < BIG_PROJECT) return
      const cwd = await projectCwd(folder)
      const label = cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) || cwd : name
      push({
        id: `bigProject:${name}`,
        kind: 'bigProject',
        title: `${label} has ${formatBytes(size.bytes)} of transcripts`,
        detail: rel('projects', name),
        bytes: size.bytes,
        paths: [rel('projects', name)],
        action: { type: 'open', label: 'Open in Projects', screen: 'projects', selectId: name }
      })
    })
  )
}

async function offSkills(push: Push): Promise<void> {
  const settings = await readJson<{ skillOverrides?: Record<string, unknown> }>(abs('settings.json'))
  const overrides = settings?.skillOverrides
  if (!overrides || typeof overrides !== 'object') return
  // skillOverrides keys are skill NAMES (frontmatter `name`, which may differ from the folder). Map them to the user
  // skill folders with the Skills scanner, which already leaves out skills/synced, plugin skills and folders without a SKILL.md.
  const off = (await scanUser(overrides)).filter((s) => s.override === 'off' && !s.symlink)
  await Promise.all(
    off.map(async (skill) => {
      const folder = path.basename(skill.dir)
      const dir = abs('skills', folder)
      const st = await stat(dir)
      if (!st?.isDir) return // links are not ours to remove
      const size = await sizeOf(dir)
      if (size.bytes < BIG_OFF_SKILL) return
      push({
        id: `bigSkillOff:${folder}`,
        kind: 'bigSkillOff',
        title: `Skill "${skill.name}" is off but takes ${formatBytes(size.bytes)}`,
        detail: rel('skills', folder),
        bytes: size.bytes,
        paths: [rel('skills', folder)],
        action: {
          type: 'trash',
          label: 'Move to Trash',
          rels: [rel('skills', folder)],
          confirmTitle: `Move "${skill.name}" to Trash?`,
          confirmBody: `skills/${folder} (${formatBytes(size.bytes)}) goes to the Trash. You can put it back from there.`
        }
      })
    })
  )
}

async function oldDownloads(push: Push): Promise<void> {
  const dir = abs('downloads')
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  const files = (
    await Promise.all(
      names.map(async (name) => {
        const st = await stat(path.join(dir, name))
        return st?.isFile && !isSecret(name) && (/^claude[-_]/i.test(name) || st.size > 20 * MB) ? { name, size: st.size, mtimeMs: st.mtimeMs } : null
      })
    )
  )
    .filter((f): f is { name: string; size: number; mtimeMs: number } => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  // the newest build may be the one in use; the rest, and anything over 30 days old, is a leftover installer
  const now = Date.now()
  const old = files.filter((f, i) => i > 0 || now - f.mtimeMs > OLD_BUILD_AGE)
  if (old.length === 0) return
  const bytes = old.reduce((n, f) => n + f.size, 0)
  push({
    id: 'oldDownload',
    kind: 'oldDownload',
    title: old.length === 1 ? 'Old CLI build in downloads/' : `${old.length} old CLI builds in downloads/`,
    detail: old.map((f) => f.name).join(', '),
    bytes,
    paths: old.map((f) => rel('downloads', f.name)),
    action: {
      type: 'trash',
      label: 'Move to Trash',
      rels: old.map((f) => rel('downloads', f.name)),
      confirmTitle: old.length === 1 ? 'Move this build to Trash?' : `Move ${old.length} builds to Trash?`,
      confirmBody: `${old.map((f) => f.name).join(', ')} (${formatBytes(bytes)}). Claude Code downloads a new one when it updates.`
    }
  })
}

async function looseBackups(push: Push): Promise<void> {
  const loose = (await scanLoose()).filter((l) => l.location === 'root' && !l.hidden)
  if (loose.length === 0) return
  const bytes = loose.reduce((n, l) => n + l.size, 0)
  const names = loose.map((l) => l.name)
  push({
    id: 'looseBackups',
    kind: 'looseBackups',
    title: `${plural(loose.length, 'loose backup file')} in the root`,
    detail: names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : ''),
    bytes,
    paths: loose.map((l) => l.rel),
    action: { type: 'tidy', label: 'Tidy into backups/', rels: loose.map((l) => l.rel) }
  })
}

async function bigLogs(push: Push): Promise<void> {
  const names = await fsp.readdir(configDir()).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((n) => /\.log$/i.test(n) && !isSecret(n))
      .map(async (name) => {
        const st = await stat(abs(name))
        if (!st?.isFile || st.size <= BIG_LOG) return
        push({
          id: `bigLog:${name}`,
          kind: 'bigLog',
          title: `${name} has grown to ${formatBytes(st.size)}`,
          detail: name,
          bytes: st.size,
          paths: [name],
          action: {
            type: 'clearLog',
            label: 'Clear log',
            rel: name,
            confirmTitle: `Clear ${name}?`,
            confirmBody: `A snapshot of the current ${formatBytes(st.size)} is kept in Backups, then the file is emptied.`
          }
        })
      })
  )
}

async function emptyClaudeMd(push: Push): Promise<void> {
  const st = await stat(abs('CLAUDE.md'))
  if (!st?.isFile) return
  let empty = st.size === 0
  if (!empty && st.size <= 4096) empty = (await fsp.readFile(abs('CLAUDE.md'), 'utf8')).trim() === ''
  if (!empty) return
  push({
    id: 'emptyClaudeMd',
    kind: 'emptyClaudeMd',
    title: 'CLAUDE.md is empty',
    detail: 'CLAUDE.md',
    paths: ['CLAUDE.md'],
    action: { type: 'open', label: 'Open CLAUDE.md', screen: 'rules', selectId: 'CLAUDE.md' }
  })
}

async function bigFolders(push: Push, force?: boolean): Promise<void> {
  await Promise.all(
    ['file-history', 'shell-snapshots', 'debug'].map(async (name) => {
      const st = await stat(abs(name))
      if (!st?.isDir) return
      const size = await sizeOf(abs(name), { force })
      if (size.bytes < BIG_FOLDER) return
      push({
        id: `bigFolder:${name}`,
        kind: 'bigFolder',
        title: `${name}/ holds ${formatBytes(size.bytes)}`,
        detail: `${name}/ · ${plural(size.files, 'file')}`,
        bytes: size.bytes,
        paths: [name],
        action: { type: 'open', label: 'Open in Storage', screen: 'storage', selectId: name }
      })
    })
  )
}

async function computeFindings(scanId: string, force?: boolean): Promise<Finding[]> {
  const found: Finding[] = []
  const push: Push = (f) => {
    found.push(f)
    emit('overview:finding', { scanId, finding: f })
  }
  const tasks = [bigFolders(push, force), looseBackups(push), bigLogs(push), emptyClaudeMd(push), oldDownloads(push), offSkills(push), bigProjects(push, force)]
  // one failing check must not hide the others
  await Promise.all(tasks.map((t) => t.catch(() => undefined)))
  return found.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.title.localeCompare(b.title))
}

/* ------------------------------------------------------------------ summary */

async function dirs(p: string): Promise<string[]> {
  const entries = await fsp.readdir(p, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).map((e) => e.name)
}

const isDir = (p: string): Promise<boolean> => fsp.stat(p).then((s) => s.isDirectory(), () => false)

/** Skills in `dir`: folders with a SKILL.md, also one level down (synced/ groups). */
async function countSkillsIn(dir: string): Promise<number> {
  let n = 0
  await Promise.all(
    (await dirs(dir)).map(async (name) => {
      const sub = path.join(dir, name)
      if (!(await isDir(sub))) return
      if (await exists(path.join(sub, 'SKILL.md'))) n++
      else
        for (const inner of await dirs(sub)) if (await exists(path.join(sub, inner, 'SKILL.md'))) n++
    })
  )
  return n
}

async function countPluginSkills(installed: unknown): Promise<number> {
  const plugins = (installed as { plugins?: Record<string, unknown> } | undefined)?.plugins
  if (!plugins || typeof plugins !== 'object') return 0
  const paths = new Set<string>()
  for (const v of Object.values(plugins)) {
    for (const item of Array.isArray(v) ? v : [v]) {
      const p = (item as { installPath?: unknown } | null)?.installPath
      if (typeof p !== 'string') continue
      const r = path.relative(configDir(), path.resolve(p))
      if (!r.startsWith('..') && !path.isAbsolute(r)) paths.add(path.resolve(p))
    }
  }
  const counts = await Promise.all([...paths].map((p) => countSkillsIn(path.join(p, 'skills'))))
  return counts.reduce((a, b) => a + b, 0)
}

async function countLines(file: string): Promise<number> {
  let n = 0
  let last = 0x0a
  try {
    for await (const chunk of fs.createReadStream(file) as AsyncIterable<Buffer>) {
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 0x0a) n++
      last = chunk[chunk.length - 1]
    }
  } catch {
    return 0
  }
  return last === 0x0a ? n : n + 1
}

async function countRules(): Promise<number> {
  let n = (await exists(abs('CLAUDE.md'))) ? 1 : 0
  async function walk(dir: string, depth: number): Promise<void> {
    const kids = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const k of kids) {
      if (k.isDirectory() && depth < 3) await walk(path.join(dir, k.name), depth + 1)
      else if (k.name.toLowerCase().endsWith('.md')) n++
    }
  }
  await walk(abs('rules'), 1)
  return n
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

async function summary(): Promise<OverviewSummary> {
  const settings = (await readJson<Record<string, unknown>>(abs('settings.json'))) ?? {}
  const installed = await readJson(abs('plugins', 'installed_plugins.json'))
  const installedPlugins = (installed as { plugins?: Record<string, unknown> } | undefined)?.plugins
  const pluginKeys = installedPlugins && typeof installedPlugins === 'object' ? Object.keys(installedPlugins) : []
  const enabled = (settings.enabledPlugins ?? {}) as Record<string, unknown>

  let hooks = 0
  let hookEvents = 0
  const hookMap = settings.hooks
  if (hookMap && typeof hookMap === 'object') {
    for (const groups of Object.values(hookMap as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue
      let inEvent = 0
      for (const g of groups) {
        const list = (g as { hooks?: unknown } | null)?.hooks
        inEvent += Array.isArray(list) ? list.length : 0
      }
      if (inEvent > 0) hookEvents++
      hooks += inEvent
    }
  }

  const [skills, pluginSkills, rules, projects, prompts, global] = await Promise.all([
    countSkillsIn(abs('skills')),
    countPluginSkills(installed),
    countRules(),
    dirs(abs('projects')).then((d) => d.length),
    countLines(abs('history.jsonl')),
    readJson<Record<string, unknown>>(globalStateFile())
  ])

  const statusLine = settings.statusLine as { command?: unknown } | undefined
  return {
    configDir: configDir(),
    counts: {
      skills,
      pluginSkills,
      hooks,
      hookEvents,
      plugins: pluginKeys.length,
      pluginsEnabled: pluginKeys.filter((k) => enabled[k] === true).length,
      rules,
      projects,
      prompts
    },
    glance: {
      model: str(settings.model),
      // CLAUDE_CODE_EFFORT_LEVEL wins over effortLevel and is the only place max is kept
      effort: str((settings.env as Record<string, unknown> | undefined)?.CLAUDE_CODE_EFFORT_LEVEL) ?? str(settings.effortLevel),
      theme: str(settings.theme) ?? str(global?.theme),
      statusLine: str(statusLine?.command)
    }
  }
}

/* ------------------------------------------------------------------ api */

const impl: OverviewApi = {
  summary,

  findings(scanId, force) {
    return computeFindings(scanId, force)
  },

  async trash(rels) {
    assertWritable()
    if (!Array.isArray(rels) || rels.length === 0) return { trashed: 0 }
    for (const r of rels) resolveInside(r) // validate everything before touching anything
    let trashed = 0
    let firstError: string | null = null
    for (const r of rels) {
      try {
        await trash(r)
        trashed++
      } catch (e) {
        firstError ??= (e as Error).message
      }
    }
    if (firstError) throw new Error(`Moved ${trashed} of ${rels.length} to Trash. ${firstError}`)
    return { trashed }
  },

  async clearLog(relPath) {
    assertWritable()
    const target = resolveInside(relPath)
    if (path.dirname(target) !== configDir() || !/\.log$/i.test(target) || isSecret(target)) throw new Error('Only .log files in the config folder can be cleared')
    const r = await safeWriteText(relPath, '', `Clear log ${path.basename(target)}`)
    return { snapshotId: r.snapshotId }
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'overview', impl)
}
