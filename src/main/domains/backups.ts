import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { BackupsApi, BackupsList, FileCompare, LooseBackup } from '@shared/api/backups'
import { exists, invalidateSizes, stat } from '../fsx'
import { defineDomain } from '../ipcx'
import { GLOBAL_STATE_REL, assertWritable, configDir, globalStateFile, isSecret, isSecretReal, resolveInside } from '../paths'
import {
  listSnapshots,
  readSnapshotText,
  restoreSnapshot,
  safeWriteText,
  snapshotFilePath,
  trash,
  trashSnapshot,
  writeGlobalStateKey
} from '../safeWrite'

/* ------------------------------------------------------------------ loose backup detection */

/** The glob from the spec: *.bak* in the config root. */
const LOOSE_RE = /\.bak/i
const MAX_COMPARE_BYTES = 2 * 1024 * 1024
const MAX_BACKUPS_FILES = 400

/** Credentials-like names (also `.credentials.json.bak`): listed as locked rows, never read, never moved. */
export function isHiddenName(name: string): boolean {
  const n = name.toLowerCase()
  return n.startsWith('.credentials') || n.endsWith('.key') || isSecret(name)
}

/** Which file does this backup name belong to? `settings.json.bak-2026` -> `settings.json`. */
export function liveNameFor(name: string): string | null {
  const patterns = [
    /^(.+?)\.bak(?:[^A-Za-z].*)?$/i,
    /^(.+?)\.(?:backup|old|orig|save|prev)(?:[^A-Za-z].*)?$/i,
    /^(.+?)[.-](?:19|20)\d{2}-?\d{2}-?\d{2}.*$/,
    /^(.+)~$/
  ]
  for (const re of patterns) {
    const m = re.exec(name)
    if (m && m[1]) return m[1]
  }
  return null
}

async function resolveLive(name: string): Promise<{ liveName: string | null; liveRel: string | null }> {
  const base = liveNameFor(name)
  if (!base) return { liveName: null, liveRel: null }
  if (base === GLOBAL_STATE_REL) return { liveName: base, liveRel: (await exists(globalStateFile())) ? GLOBAL_STATE_REL : null }
  if (isHiddenName(base)) return { liveName: base, liveRel: null }
  const candidates = path.extname(base) ? [base] : [base, `${base}.json`, `${base}.md`]
  for (const c of candidates) {
    const abs = path.join(configDir(), c)
    const st = await stat(abs)
    if (st?.isFile) return { liveName: base, liveRel: c }
  }
  return { liveName: base, liveRel: null }
}

async function looseEntry(abs: string, location: 'root' | 'backups'): Promise<LooseBackup | null> {
  const st = await stat(abs)
  if (!st || !st.isFile) return null
  const name = path.basename(abs)
  const hidden = isHiddenName(name)
  const live = hidden ? { liveName: null, liveRel: null } : await resolveLive(name)
  return {
    rel: path.relative(configDir(), abs),
    name,
    size: hidden ? 0 : st.size,
    mtimeMs: st.mtimeMs,
    location,
    liveRel: live.liveRel,
    liveName: live.liveName,
    hidden
  }
}

/** Loose `*.bak*` files in the config root, plus every file under backups/ (3 levels deep, capped). */
export async function scanLoose(): Promise<LooseBackup[]> {
  const root = configDir()
  const out: LooseBackup[] = []
  const names = await fsp.readdir(root).catch(() => [] as string[])
  const rootFiles = await Promise.all(names.filter((n) => LOOSE_RE.test(n)).map((n) => looseEntry(path.join(root, n), 'root')))
  for (const e of rootFiles) if (e) out.push(e)

  let seen = 0
  async function walk(dir: string, depth: number): Promise<void> {
    const kids = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const k of kids) {
      if (seen >= MAX_BACKUPS_FILES) return
      const full = path.join(dir, k.name)
      if (k.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1)
      } else if (k.isFile()) {
        seen++
        const e = await looseEntry(full, 'backups')
        if (e) out.push(e)
      }
    }
  }
  await walk(path.join(root, 'backups'), 1)
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/* ------------------------------------------------------------------ compare */

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0)
}

interface Loaded {
  text: string
  exists: boolean
  binary: boolean
  tooLarge: boolean
}

async function loadText(abs: string): Promise<Loaded> {
  if (await isSecretReal(abs)) return { text: '', exists: false, binary: false, tooLarge: false }
  const st = await stat(abs)
  if (!st || !st.isFile) return { text: '', exists: false, binary: false, tooLarge: false }
  if (st.size > MAX_COMPARE_BYTES) return { text: '', exists: true, binary: false, tooLarge: true }
  const buf = await fsp.readFile(abs)
  if (looksBinary(buf)) return { text: '', exists: true, binary: true, tooLarge: false }
  return { text: buf.toString('utf8'), exists: true, binary: false, tooLarge: false }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** .claude.json is compared per top-level key: only mcpServers can be restored. Values of other keys are never sent. */
function compareClaudeJson(backup: Loaded, live: Loaded, backupMtimeMs: number | null): FileCompare {
  const base: FileCompare = {
    liveRel: GLOBAL_STATE_REL,
    liveExists: live.exists,
    backup: '',
    live: '',
    backupMtimeMs,
    binary: false,
    tooLarge: backup.tooLarge || live.tooLarge,
    mode: 'claudeJson',
    differingKeys: [],
    canRestoreKey: false,
    restoreBlockedReason: null
  }
  const b = parseObject(backup.text)
  const l = parseObject(live.text)
  if (!b) return { ...base, restoreBlockedReason: 'This backup of .claude.json could not be read as JSON, so nothing can be restored from it.' }
  if (!l) return { ...base, restoreBlockedReason: 'The current .claude.json could not be read, so Claudock will not write to it.' }
  const keys = new Set([...Object.keys(b), ...Object.keys(l)])
  const differing = [...keys].filter((k) => !same(b[k], l[k])).sort()
  const mcpDiffers = differing.includes('mcpServers')
  const show = (o: Record<string, unknown>): string => (o.mcpServers === undefined ? '' : JSON.stringify(o.mcpServers, null, 2) + '\n')
  return {
    ...base,
    backup: show(b),
    live: show(l),
    differingKeys: differing,
    canRestoreKey: mcpDiffers,
    restoreBlockedReason: mcpDiffers
      ? null
      : 'Only the mcpServers key of .claude.json can be restored, because Claude Code rewrites the rest all the time. mcpServers is the same as now, so there is nothing to restore.'
  }
}

async function compareFiles(backupAbs: string, backupMtimeMs: number | null, liveRel: string | null): Promise<FileCompare> {
  const backup = await loadText(backupAbs)
  if (liveRel === GLOBAL_STATE_REL) return compareClaudeJson(backup, await loadText(globalStateFile()), backupMtimeMs)
  const live = liveRel ? await loadText(resolveInside(liveRel)) : { text: '', exists: false, binary: false, tooLarge: false }
  return {
    liveRel,
    liveExists: live.exists,
    backup: backup.text,
    live: live.text,
    backupMtimeMs,
    binary: backup.binary || live.binary,
    tooLarge: backup.tooLarge || live.tooLarge,
    mode: 'file',
    differingKeys: [],
    canRestoreKey: false,
    restoreBlockedReason: liveRel ? null : 'Claudock cannot tell which file this is a backup of, so it will not restore it.'
  }
}

/* ------------------------------------------------------------------ helpers */

/** A loose backup is a `*.bak*` file in the config root or any file under backups/. Anything else is refused. */
function looseAbs(rel: string): string {
  const abs = resolveInside(rel)
  const root = configDir()
  const name = path.basename(abs)
  if (isHiddenName(name)) throw new Error('This file is hidden for safety')
  const inRoot = path.dirname(abs) === root && LOOSE_RE.test(name)
  const inBackups = path.relative(path.join(root, 'backups'), abs).split(path.sep)[0] !== '..' && abs !== path.join(root, 'backups')
  if (!inRoot && !inBackups) throw new Error('That file is not a backup')
  return abs
}

function backupMtime(abs: string): Promise<number | null> {
  return stat(abs).then((s) => s?.mtimeMs ?? null)
}

const pad = (n: number): string => String(n).padStart(2, '0')
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function restoreMcpFrom(backupText: string, reason: string): Promise<{ snapshotId: string | null }> {
  const parsed = parseObject(backupText)
  if (!parsed) throw new Error('This backup could not be read as JSON')
  return writeGlobalStateKey('mcpServers', parsed.mcpServers, reason)
}

/* ------------------------------------------------------------------ api */

const impl: BackupsApi = {
  async list(): Promise<BackupsList> {
    const [snapshots, loose] = await Promise.all([listSnapshots(), scanLoose()])
    return { snapshots, loose }
  },

  async snapshotFile(id, rel) {
    const snaps = await listSnapshots()
    const snap = snaps.find((s) => s.id === id)
    if (!snap || !snap.files.includes(rel)) throw new Error('That file is not in this snapshot')
    const abs = await snapshotFilePath(id, rel) // validates the id format and that the file is in the manifest
    return compareFiles(abs, Date.parse(snap.at) || null, rel)
  },

  async restoreSnapshotFile(id, rel) {
    assertWritable()
    const snaps = await listSnapshots()
    const snap = snaps.find((s) => s.id === id)
    if (!snap || !snap.files.includes(rel)) throw new Error('That file is not in this snapshot')
    if (rel === GLOBAL_STATE_REL) {
      const text = await readSnapshotText(id, rel)
      return restoreMcpFrom(text, `Restore mcpServers in .claude.json from snapshot ${id}`)
    }
    await restoreSnapshot(id, rel)
    // restoreSnapshot snapshots the current file first: find the new one (the one that was not there before)
    const known = new Set(snaps.map((s) => s.id))
    const after = await listSnapshots()
    return { snapshotId: after.find((s) => !known.has(s.id) && s.files.includes(rel))?.id ?? null }
  },

  async deleteSnapshot(id) {
    assertWritable()
    await trashSnapshot(id)
  },

  async looseCompare(rel) {
    const abs = looseAbs(rel)
    const { liveRel } = await resolveLive(path.basename(abs))
    return compareFiles(abs, await backupMtime(abs), liveRel)
  },

  async restoreLoose(rel) {
    assertWritable()
    const abs = looseAbs(rel)
    const name = path.basename(abs)
    const { liveRel } = await resolveLive(name)
    if (!liveRel) throw new Error('Claudock cannot tell which file this is a backup of')
    const loaded = await loadText(abs)
    if (loaded.binary || loaded.tooLarge) throw new Error('This backup is binary or too large to restore here')
    if (liveRel === GLOBAL_STATE_REL) return restoreMcpFrom(loaded.text, `Restore mcpServers in .claude.json from ${name}`)
    const r = await safeWriteText(liveRel, loaded.text, `Restore of ${liveRel} from ${name}`)
    return { snapshotId: r.snapshotId }
  },

  async trashLoose(rel) {
    assertWritable()
    looseAbs(rel)
    await trash(rel)
  },

  async tidy(rels) {
    assertWritable()
    const root = configDir()
    const candidates = (await scanLoose()).filter((e) => e.location === 'root' && !e.hidden && (!rels || rels.includes(e.rel)))
    if (candidates.length === 0) return { moved: 0, folder: '' }
    const folderRel = path.join('backups', `loose-${today()}`)
    const folderAbs = path.join(root, folderRel)
    await fsp.mkdir(folderAbs, { recursive: true })
    let moved = 0
    for (const c of candidates) {
      const from = path.join(root, c.rel)
      // never overwrite: pick a free name
      let to = path.join(folderAbs, c.name)
      for (let n = 1; await exists(to); n++) to = path.join(folderAbs, `${c.name}.${n}`)
      await fsp.rename(from, to)
      moved++
    }
    invalidateSizes(root)
    return { moved, folder: folderRel }
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'backups', impl)
}

/** Sidebar badge: Claudock snapshots plus loose backup files. */
export async function count(): Promise<number> {
  const [snaps, loose] = await Promise.all([listSnapshots(), scanLoose()])
  return snaps.length + loose.filter((l) => !l.hidden).length
}
