import type { IpcMain } from 'electron'
import path from 'node:path'
import type { HistoryEntry, HistoryIndex, HistoryProject, HistoryRow } from '@shared/api/history'
import { stat, streamJsonl } from '../fsx'
import { configDir } from '../paths'
import { defineDomain } from '../ipcx'

/** history.jsonl, read-only. Parsed once and cached by mtime + size; the file only ever grows. */

interface RawEntry {
  display?: unknown
  pastedContents?: unknown
  timestamp?: unknown
  project?: unknown
  sessionId?: unknown
}

interface Entry {
  id: number
  display: string
  lower: string
  ts: number
  project: string | null
  sessionId: string | null
  pastedKinds: string[]
}

interface Cache {
  /** history.jsonl of the profile it was read from. */
  file: string
  mtimeMs: number
  size: number
  entries: Entry[]
  byId: Map<number, Entry>
  projects: HistoryProject[]
}

let cache: Cache | null = null
let loading: Promise<Cache> | null = null
let loadingFile = ''

const historyFile = (): string => path.join(configDir(), 'history.jsonl')

async function load(): Promise<Cache> {
  const st = await stat(historyFile())
  if (!st) {
    cache = { file: historyFile(), mtimeMs: 0, size: 0, entries: [], byId: new Map(), projects: [] }
    return cache
  }
  if (cache && cache.file === historyFile() && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache
  // a load of another profile's file still running doesn't answer for this one
  if (loading && loadingFile === historyFile()) return loading
  loadingFile = historyFile()
  const run: Promise<Cache> = (async () => {
    const entries: Entry[] = []
    const counts = new Map<string, number>()
    try {
      for await (const r of streamJsonl<RawEntry>(historyFile())) {
        const v = r.value
        if (!v || typeof v !== 'object' || typeof v.display !== 'string') continue
        const project = typeof v.project === 'string' && v.project ? v.project : null
        const pasted = v.pastedContents && typeof v.pastedContents === 'object' ? Object.values(v.pastedContents as Record<string, unknown>) : []
        const kinds = pasted.map((p) => (p && typeof p === 'object' && typeof (p as { type?: unknown }).type === 'string' ? String((p as { type: string }).type) : 'text'))
        entries.push({
          id: r.index,
          display: v.display,
          lower: v.display.toLowerCase(),
          ts: typeof v.timestamp === 'number' ? v.timestamp : Number(v.timestamp) || 0,
          project,
          sessionId: typeof v.sessionId === 'string' ? v.sessionId : null,
          pastedKinds: kinds
        })
        if (project) counts.set(project, (counts.get(project) ?? 0) + 1)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const projects = [...counts.entries()].map(([p, count]) => ({ path: p, count })).sort((a, b) => b.count - a.count || a.path.localeCompare(b.path))
    const next: Cache = { file: historyFile(), mtimeMs: st.mtimeMs, size: st.size, entries, byId: new Map(entries.map((e) => [e.id, e])), projects }
    cache = next
    return next
  })().finally(() => {
    if (loading === run) loading = null
  })
  loading = run
  return run
}

/** Project paths mentioned in history (used by Projects / Search to name folders). */
export async function historyProjectPaths(): Promise<string[]> {
  try {
    return (await load()).projects.map((p) => p.path)
  } catch {
    return []
  }
}

const snippet = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 160)

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'history', {
    async index(q?: string, project?: string): Promise<HistoryIndex> {
      const c = await load()
      const needle = (q ?? '').trim().toLowerCase()
      const projIndex = new Map(c.projects.map((p, i) => [p.path, i]))
      const rows: HistoryRow[] = []
      for (const e of c.entries) {
        if (project && e.project !== project) continue
        if (needle && !e.lower.includes(needle)) continue
        rows.push({ id: e.id, ts: e.ts, p: e.project ? (projIndex.get(e.project) ?? -1) : -1, s: snippet(e.display), pasted: e.pastedKinds.length })
      }
      rows.sort((a, b) => b.ts - a.ts || b.id - a.id)
      return { rows, projects: c.projects, totalAll: c.entries.length }
    },

    async get(id: number): Promise<HistoryEntry> {
      const c = await load()
      const e = c.byId.get(id)
      if (!e) throw new Error('This history entry is no longer in history.jsonl')
      return { id: e.id, display: e.display, ts: e.ts, project: e.project, sessionId: e.sessionId, pasted: e.pastedKinds.length, pastedKinds: e.pastedKinds }
    }
  })
}

export async function count(): Promise<number> {
  return (await load()).entries.length
}
