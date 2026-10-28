import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ScreenId } from '@shared/nav'
import type { SearchResult } from '@shared/types'
import { parseFrontmatter } from '@shared/frontmatter'
import { readJson } from '../fsx'
import { defineDomain } from '../ipcx'
import { configDir, onConfigDirChanged } from '../paths'
import { listMemoryFiles } from './memory'
import { listPlans } from './plans'
import { listProjectSummaries, readHead, sessionTitle } from './projects'

/**
 * Global search (command palette). A small in-memory index of names / titles, built from file heads only and
 * refreshed when older than 60 s (stale results are served while it rebuilds).
 *
 * selectId formats handed to the screens:
 * Path-like ids are config-relative with forward slashes (the format the Skills / Agents / Commands / Rules screens use).
 *   skills      skill id = `skills/<folder>`
 *   agents      `agents/reviewer.md`
 *   commands    `commands/review.md`
 *   rules       `CLAUDE.md` or `rules/style.md`
 *   hooks       `<file>|<event>:<groupIndex>:<hookIndex>`, e.g. `settings.local.json|PreToolUse:0:1`
 *   settings    `<file>:<key path with dots>`, e.g. `settings.json:model` or `settings.local.json:permissions.defaultMode`
 *   projects    encoded folder name, or `<folder>/<sessionId>` for a session
 *   memory      config-relative path as the Memory screen lists it (`projects/<folder>/memory/<file>.md`)
 *   plans       config-relative path as the Plans screen lists it (`plans/<file>.md`)
 */

interface Item extends SearchResult {
  lower: string
  alt: string
  weight: number
}

const WEIGHT: Record<string, number> = { skill: 0, agent: 1, command: 2, rule: 3, hook: 4, setting: 5, memory: 6, plan: 7, project: 8, session: 9 }

const mk = (screen: ScreenId, kind: string, id: string, title: string, subtitle?: string, alt = ''): Item => ({
  screen,
  kind,
  id,
  title,
  subtitle,
  lower: title.toLowerCase(),
  alt: alt.toLowerCase(),
  weight: WEIGHT[kind] ?? 9
})

/* ------------------------------------------------------------------ sources */

async function mdFiles(dir: string, maxDepth: number): Promise<string[]> {
  const out: string[] = []
  async function walk(d: string, depth: number): Promise<void> {
    let ents
    try {
      ents = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const full = path.join(d, e.name)
      if (e.isDirectory() || (e.isSymbolicLink() && (await fsp.stat(full).catch(() => null))?.isDirectory())) {
        if (depth < maxDepth && !e.name.startsWith('.')) await walk(full, depth + 1)
      } else if (e.name.toLowerCase().endsWith('.md')) out.push(full)
    }
  }
  await walk(dir, 0)
  return out
}

const posix = (p: string): string => p.split(path.sep).join('/')
const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))
const oneLine = (s: string, n = 100): string => s.replace(/\s+/g, ' ').trim().slice(0, n)

async function skillItems(): Promise<Item[]> {
  const root = path.join(configDir(), 'skills')
  let ents
  try {
    ents = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = await Promise.all(
    ents
      .filter((e) => !e.name.startsWith('.'))
      .map(async (e): Promise<Item | null> => {
        const file = path.join(root, e.name, 'SKILL.md')
        const head = await readHead(file, 4096)
        if (!head) return null
        const fm = parseFrontmatter(head)
        const name = first(fm.data.name) || e.name
        return mk('skills', 'skill', `skills/${e.name}`, name, oneLine(first(fm.data.description)), e.name)
      })
  )
  return out.filter((x): x is Item => x !== null)
}

async function fileItems(dirName: string, screen: ScreenId, kind: string, titleOf: (rel: string, name: string) => string, depth: number): Promise<Item[]> {
  const files = await mdFiles(path.join(configDir(), dirName), depth)
  return Promise.all(
    files.map(async (f) => {
      const rel = posix(path.relative(configDir(), f))
      const fm = parseFrontmatter(await readHead(f, 2048))
      const inner = posix(path.relative(path.join(configDir(), dirName), f)).replace(/\.md$/i, '')
      return mk(screen, kind, rel, titleOf(rel, first(fm.data.name) || inner.split('/').join(':')), oneLine(first(fm.data.description)), rel)
    })
  )
}

async function ruleItems(): Promise<Item[]> {
  const out = await fileItems('rules', 'rules', 'rule', (rel) => rel.split('/').slice(1).join('/'), 2)
  const claude = path.join(configDir(), 'CLAUDE.md')
  if (await fsp.stat(claude).catch(() => null)) out.unshift(mk('rules', 'rule', 'CLAUDE.md', 'CLAUDE.md', 'Global instructions'))
  return out
}

interface HookGroup {
  matcher?: unknown
  hooks?: Array<{ command?: unknown; prompt?: unknown; type?: unknown }>
}

function hookItems(file: SettingsFile, settings: Record<string, unknown> | undefined): Item[] {
  const hooks = settings?.hooks
  if (!hooks || typeof hooks !== 'object') return []
  const out: Item[] = []
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((g: HookGroup, gi) => {
      const list = Array.isArray(g?.hooks) ? g.hooks : []
      const matcher = typeof g?.matcher === 'string' && g.matcher ? ` · ${g.matcher}` : ''
      list.forEach((h, hi) => {
        const cmd = typeof h?.command === 'string' ? h.command : typeof h?.prompt === 'string' ? h.prompt : ''
        out.push(mk('hooks', 'hook', `${file}|${event}:${gi}:${hi}`, oneLine(cmd || `${event} hook`, 90), `${event}${matcher} · ${file}`, event))
      })
    })
  }
  return out
}

type SettingsFile = 'settings.json' | 'settings.local.json'
const SETTINGS_FILES: SettingsFile[] = ['settings.json', 'settings.local.json']

const BIG_OBJECT_KEYS = new Set(['hooks', 'skillOverrides', 'enabledPlugins', 'mcpServers', 'extraKnownMarketplaces'])

function settingItems(file: SettingsFile, settings: Record<string, unknown> | undefined): Item[] {
  if (!settings) return []
  const out: Item[] = []
  for (const [k, v] of Object.entries(settings)) {
    out.push(mk('settings', 'setting', `${file}:${k}`, k, file))
    if (v && typeof v === 'object' && !Array.isArray(v) && !BIG_OBJECT_KEYS.has(k)) {
      for (const k2 of Object.keys(v as object).slice(0, 60)) out.push(mk('settings', 'setting', `${file}:${k}.${k2}`, `${k}.${k2}`, file))
    }
  }
  return out
}

async function memoryItems(): Promise<Item[]> {
  const groups = await listMemoryFiles()
  return groups.flatMap((g) =>
    g.files.map((f) => mk('memory', 'memory', f.rel, f.title, oneLine(`${g.projectName}${f.description ? ' · ' + f.description : ''}`), f.file))
  )
}

async function planItems(): Promise<Item[]> {
  return (await listPlans()).map((p) => mk('plans', 'plan', p.rel, p.title, oneLine(p.excerpt), p.file))
}

async function projectItems(): Promise<Item[]> {
  return (await listProjectSummaries()).map((p) => mk('projects', 'project', p.id, p.name, p.path ?? undefined, p.id))
}

/** Titles of the newest sessions (heads only; title cache makes refreshes cheap). */
async function sessionItems(): Promise<Item[]> {
  const projects = (await listProjectSummaries()).sort((a, b) => b.lastActiveMs - a.lastActiveMs).slice(0, 40)
  const files: Array<{ project: (typeof projects)[number]; sid: string; mtimeMs: number }> = []
  await Promise.all(
    projects.map(async (p) => {
      const dir = path.join(configDir(), 'projects', p.id)
      let names: string[]
      try {
        names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl'))
      } catch {
        return
      }
      await Promise.all(
        names.map(async (n) => {
          const st = await fsp.stat(path.join(dir, n)).catch(() => null)
          if (st) files.push({ project: p, sid: n.slice(0, -6), mtimeMs: st.mtimeMs })
        })
      )
    })
  )
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const top = files.slice(0, 300)
  const out: Item[] = []
  const queue = [...top]
  const worker = async (): Promise<void> => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const title = await sessionTitle(path.join(configDir(), 'projects', f.project.id, `${f.sid}.jsonl`))
      if (title) out.push(mk('projects', 'session', `${f.project.id}/${f.sid}`, title, f.project.name))
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  return out
}

/* ------------------------------------------------------------------ index */

const STALE_MS = 60_000

interface Built<T> {
  at: number
  items: T
}

let base: Built<Item[]> | null = null
let baseBuilding: Promise<Built<Item[]>> | null = null
let sessions: Built<Item[]> | null = null
let sessionsBuilding: Promise<void> | null = null
/** Bumped when another profile opens, so a build of the old folder that finishes late isn't kept. */
let gen = 0

async function safe(p: Promise<Item[]>): Promise<Item[]> {
  try {
    return await p
  } catch {
    return []
  }
}

function buildBase(): Promise<Built<Item[]>> {
  const g = gen
  baseBuilding ??= (async () => {
    const settingsByFile = await Promise.all(
      SETTINGS_FILES.map(async (f) => {
        const j = await readJson<unknown>(path.join(configDir(), f)).catch(() => undefined)
        return { file: f, settings: j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined }
      })
    )
    const parts = await Promise.all([
      safe(skillItems()),
      safe(fileItems('agents', 'agents', 'agent', (_rel, name) => name, 2)),
      safe(fileItems('commands', 'commands', 'command', (_rel, name) => '/' + name, 3)),
      safe(ruleItems()),
      Promise.resolve(settingsByFile.flatMap((x) => hookItems(x.file, x.settings))),
      Promise.resolve(settingsByFile.flatMap((x) => settingItems(x.file, x.settings))),
      safe(memoryItems()),
      safe(planItems()),
      safe(projectItems())
    ])
    const built = { at: Date.now(), items: parts.flat() }
    if (g === gen) base = built
    return built
  })().finally(() => {
    baseBuilding = null
  })
  return baseBuilding
}

function refreshSessions(): void {
  const g = gen
  sessionsBuilding ??= sessionItems()
    .then((items) => {
      if (g === gen) sessions = { at: Date.now(), items }
    })
    .catch(() => undefined)
    .finally(() => {
      sessionsBuilding = null
    })
}

async function getIndex(): Promise<Item[]> {
  let b = base
  if (!b) b = await buildBase()
  else if (Date.now() - b.at > STALE_MS) void buildBase()
  if (!sessions || Date.now() - sessions.at > STALE_MS) refreshSessions()
  // the first query does not wait for session titles beyond a short grace period
  if (!sessions && sessionsBuilding) await Promise.race([sessionsBuilding, new Promise((r) => setTimeout(r, 200))])
  return sessions ? b.items.concat(sessions.items) : b.items
}

/* ------------------------------------------------------------------ ranking */

/** 0 exact, 1 prefix, 2 word start, 3 substring, 4 only in the secondary text; -1 no match. */
function score(item: Item, tokens: string[], whole: string): number {
  if (item.lower === whole) return 0
  let worst = 0
  for (const t of tokens) {
    const i = item.lower.indexOf(t)
    let s: number
    if (i === 0) s = 1
    else if (i > 0) {
      let at = i
      s = 3
      while (at >= 0) {
        if (!/[a-z0-9]/.test(item.lower[at - 1] ?? ' ')) {
          s = 2
          break
        }
        at = item.lower.indexOf(t, at + 1)
      }
    } else if (item.alt.includes(t)) s = 4
    else return -1
    worst = Math.max(worst, s)
  }
  return worst
}

export function register(ipcMain: IpcMain): void {
  onConfigDirChanged(() => {
    gen++
    base = sessions = null
    baseBuilding = null
    sessionsBuilding = null
  })
  defineDomain(ipcMain, 'search', {
    async query(q: string): Promise<SearchResult[]> {
      const whole = (q ?? '').trim().toLowerCase()
      if (whole.length < 2) return []
      const tokens = whole.split(/\s+/).filter(Boolean)
      const items = await getIndex()
      const scored: Array<{ item: Item; s: number }> = []
      for (const item of items) {
        const s = score(item, tokens, whole)
        if (s >= 0) scored.push({ item, s })
      }
      scored.sort((a, b) => a.s - b.s || a.item.weight - b.item.weight || a.item.title.length - b.item.title.length || a.item.title.localeCompare(b.item.title))
      return scored.slice(0, 30).map(({ item }) => ({ screen: item.screen, id: item.id, title: item.title, subtitle: item.subtitle, kind: item.kind }))
    }
  })
}
