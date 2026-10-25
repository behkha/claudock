import type { IpcMain } from 'electron'
import path from 'node:path'
import type { StorageApi, StorageEntry, StorageSize } from '@shared/api/storage'
import { formatBytes } from '@shared/format'
import type { DirSize } from '@shared/types'
import { dirSize, listDir } from '../fsx'
import { defineDomain, emit } from '../ipcx'
import { configDir, resolveInside } from '../paths'
import { trash } from '../safeWrite'

/* ------------------------------------------------------------------ shared size helper */

const inflight = new Map<string, Promise<DirSize>>()

/**
 * Recursive size with in-flight sharing: two callers asking for the same folder at the same time (Overview's bar and
 * the findings scan, say) walk it once. `signal` only stops THIS caller waiting; the walk finishes and fills the cache.
 */
export function sizeOf(abs: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<DirSize> {
  let p = opts.force ? undefined : inflight.get(abs)
  if (!p) {
    // a symlinked config dir (~/.claude -> dotfiles) is measured as the folder it points at
    const mine = dirSize(abs, { force: opts.force, followRoot: abs === configDir() })
    p = mine
    inflight.set(abs, mine)
    const clear = (): void => {
      if (inflight.get(abs) === mine) inflight.delete(abs)
    }
    mine.then(clear, clear)
  }
  const signal = opts.signal
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<DirSize>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

function absOf(rel: string): string {
  return rel === '' ? configDir() : resolveInside(rel)
}

/* ------------------------------------------------------------------ api */

const scans = new Map<string, AbortController>()
const BATCH_MS = 120

const impl: StorageApi = {
  async children(rel) {
    const abs = absOf(rel)
    const entries = await listDir(abs)
    return entries.map(
      (e): StorageEntry => ({
        name: e.name,
        rel: e.rel,
        isDir: e.isDir,
        isSymlink: e.isSymlink,
        mtimeMs: e.mtimeMs,
        locked: e.secret,
        bytes: e.secret ? 0 : e.isDir ? null : e.size,
        files: e.secret ? 0 : e.isDir ? null : 1
      })
    )
  },

  async scan(rel, scanId, force) {
    const abs = absOf(rel)
    scans.get(scanId)?.abort()
    const ac = new AbortController()
    scans.set(scanId, ac)
    const all: StorageSize[] = []
    let batch: StorageSize[] = []
    let timer: NodeJS.Timeout | null = null
    const flush = (done: boolean): void => {
      if (timer) clearTimeout(timer)
      timer = null
      if (ac.signal.aborted) return
      emit('storage:sizes', { scanId, rel, items: batch, done })
      batch = []
    }
    const push = (s: StorageSize): void => {
      all.push(s)
      batch.push(s)
      timer ??= setTimeout(() => flush(false), BATCH_MS)
    }
    try {
      const entries = await listDir(abs)
      // files and links already have a size from the listing; only folders need a walk
      for (const e of entries) if (e.secret || !e.isDir) push({ rel: e.rel, bytes: e.secret ? 0 : e.size, files: e.secret ? 0 : 1 })
      await Promise.all(
        entries
          .filter((e) => e.isDir && !e.secret)
          .map(async (e) => {
            try {
              const s = await sizeOf(path.join(abs, e.name), { force, signal: ac.signal })
              push({ rel: e.rel, bytes: s.bytes, files: s.files })
            } catch (err) {
              if (!ac.signal.aborted) throw err
            }
          })
      )
      flush(true)
      return all
    } finally {
      if (timer) clearTimeout(timer)
      if (scans.get(scanId) === ac) scans.delete(scanId)
    }
  },

  async cancel(scanId) {
    scans.get(scanId)?.abort()
    scans.delete(scanId)
  },

  async trash(rel) {
    if (rel === '') throw new Error('Refusing to trash the config folder')
    await trash(rel)
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'storage', impl)
}

/** Sidebar badge: total size of the config dir, from the shared cache when it is warm. */
export async function count(): Promise<string | undefined> {
  const s = await sizeOf(configDir())
  return formatBytes(s.bytes)
}
