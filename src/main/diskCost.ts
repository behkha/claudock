import fsp from 'node:fs/promises'
import path from 'node:path'
import type { DiskCost } from '@shared/api/storage'
import { openConfigDir, snapshotsDir, userDataDir } from './paths'

/**
 * What Claudock's own data folder really takes (Storage's folder ledger). The session archive hard-links Claude Code's
 * transcripts (src/main/archive/hold.ts), so Finder, Explorer and cleaner apps, adding up each folder on its own, count
 * those bytes under Claudock too. Here each file (device + inode) counts once, and a file that a Claude Code folder also
 * has counts as linked, not as Claudock's, like `du` across both folders. Sizes are file lengths, like the rest of Storage.
 */

type Part = 'text' | 'kept' | 'app' | 'snapshots' | 'other'

interface Seen {
  size: number
  part: Part
  /** A transcript directly in an archive's `projects/<project>/`: one session. */
  session: boolean
  /** More than one name: maybe a Claude Code file too. */
  shared: boolean
}

const ARCHIVE_DIRS = new Set(['archive', 'archive.dev'])

/** Every file below `root` (not following links), with its lstat; `onFile` gets the path relative to `root`. */
async function walk(root: string, onFile: (rel: string[], st: import('node:fs').Stats) => void): Promise<void> {
  const visit = async (rel: string[]): Promise<void> => {
    const abs = path.join(root, ...rel)
    const ents = await fsp.readdir(abs, { withFileTypes: true }).catch(() => [])
    const subdirs: string[] = []
    await Promise.all(
      ents.map(async (e) => {
        if (e.isDirectory()) return void subdirs.push(e.name)
        const st = await fsp.lstat(path.join(abs, e.name)).catch(() => null)
        if (st && !st.isDirectory()) onFile([...rel, e.name], st)
      })
    )
    for (const d of subdirs) await visit([...rel, d])
  }
  await visit([])
}

const keyOf = (st: import('node:fs').Stats): string => `${st.dev}:${st.ino}`

/** Which part of Claudock's folder a file belongs to, from its path below userData. */
function partOf(rel: string[], snapRel: string[] | null): { part: Part; session: boolean } {
  const [top] = rel
  // archive/<folder key>/{projects,text}/…
  if (ARCHIVE_DIRS.has(top) && rel.length > 3) {
    if (rel[2] === 'text') return { part: 'text', session: false }
    // `<id>.jsonl`, not a version kept aside as `<id>.<ms>.jsonl` (src/main/archive/hold.ts)
    if (rel[2] === 'projects') return { part: 'kept', session: rel.length === 5 && /^[^.]+\.jsonl$/.test(rel[4]) }
  }
  if (top === 'Claudock.app') return { part: 'app', session: false }
  if (snapRel && snapRel.length > 0 && snapRel.every((s, i) => rel[i] === s)) return { part: 'snapshots', session: false }
  return { part: 'other', session: false }
}

/** The Claude Code folders the archives hold files of: each archive's index names its folder, plus the open one. */
async function configDirs(data: string): Promise<string[]> {
  const dirs = new Map<string, string>()
  const add = (d: string): void => void dirs.set(path.resolve(d).toLowerCase(), path.resolve(d))
  add(openConfigDir())
  for (const a of ARCHIVE_DIRS) {
    for (const k of await fsp.readdir(path.join(data, a)).catch(() => [] as string[])) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(data, a, k, 'index.json'), 'utf8')) as { dir?: unknown }
        if (typeof raw.dir === 'string' && path.isAbsolute(raw.dir)) add(raw.dir)
      } catch {
        /* no index yet */
      }
    }
  }
  return [...dirs.values()]
}

async function measure(configBytes: number): Promise<DiskCost> {
  const data = userDataDir()
  const snapRel = path.relative(data, snapshotsDir())
  const snapParts = snapRel && !snapRel.startsWith('..') && !path.isAbsolute(snapRel) ? snapRel.split(path.sep) : null
  const files = new Map<string, Seen>()
  let naive = 0
  await walk(data, (rel, st) => {
    naive += st.size
    const k = keyOf(st)
    if (files.has(k)) return
    files.set(k, { size: st.size, ...partOf(rel, snapParts), shared: st.nlink > 1 })
  })

  // the archive only links files below a Claude Code folder's projects/
  const linked = new Set<string>()
  if ([...files.values()].some((f) => f.shared)) {
    for (const dir of await configDirs(data)) {
      await walk(path.join(dir, 'projects'), (_rel, st) => {
        if (st.nlink < 2) return
        const k = keyOf(st)
        if (files.get(k)?.shared) linked.add(k)
      })
    }
  }

  const out: DiskCost['data'] = {
    path: data,
    real: 0,
    linked: 0,
    naive,
    searchText: 0,
    keptSessions: 0,
    keptBytes: 0,
    app: null,
    snapshots: 0,
    other: 0
  }
  for (const [k, f] of files) {
    if (linked.has(k)) {
      out.linked += f.size
      continue
    }
    out.real += f.size
    if (f.part === 'text') out.searchText += f.size
    else if (f.part === 'kept') {
      out.keptBytes += f.size
      if (f.session) out.keptSessions++
    } else if (f.part === 'app') out.app = (out.app ?? 0) + f.size
    else if (f.part === 'snapshots') out.snapshots += f.size
    else out.other += f.size
  }
  return { config: { path: openConfigDir(), bytes: configBytes }, data: out, at: Date.now() }
}

const FRESH_MS = 60_000
let cached: { dir: string; value: DiskCost } | null = null
let running: { dir: string; p: Promise<DiskCost> } | null = null
/** Bumped by `forgetDiskCost`: a measurement started before it is never kept or shared. */
let gen = 0

/** Measure both folders; `configBytes` is the config folder's size (Storage's shared cache). Kept a minute unless `force`. */
export function diskCost(configBytes: () => Promise<number>, force = false): Promise<DiskCost> {
  const dir = openConfigDir()
  if (!force && cached && cached.dir === dir && Date.now() - cached.value.at < FRESH_MS) return Promise.resolve(cached.value)
  if (!force && running && running.dir === dir) return running.p
  const mine = gen
  const p = configBytes()
    .then((bytes) => measure(bytes))
    .then((value) => {
      if (mine === gen) cached = { dir, value }
      return value
    })
    .finally(() => {
      if (running?.p === p) running = null
    })
  running = { dir, p }
  return p
}

/** Something was moved to the Trash: measure again next time. */
export function forgetDiskCost(): void {
  cached = null
  running = null
  gen++
}
