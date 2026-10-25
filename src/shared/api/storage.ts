/**
 * Storage domain contract. Owned by the maintain worker.
 *
 * Sizes are computed lazily: `children()` returns the entries at once (folders without a size), `scan()` fills in the
 * recursive sizes and streams them as `storage:sizes` batches so the UI can show them as they arrive.
 */
export interface StorageEntry {
  name: string
  /** Path relative to the config dir (OS separators). */
  rel: string
  isDir: boolean
  isSymlink: boolean
  mtimeMs: number
  /** Own size for files and links; null for folders until the scan reports it. */
  bytes: number | null
  /** Recursive file count for folders, 1 for files; null until known. */
  files: number | null
  /** Credentials / session key: shown as a locked row, never read, never trashed. */
  locked: boolean
}

export interface StorageSize {
  rel: string
  bytes: number
  files: number
}

export interface StorageApi {
  /** Direct children of `rel` ('' = the config dir). Fast: one readdir plus an lstat per child. */
  children(rel: string): Promise<StorageEntry[]>
  /** Recursive size of every child of `rel`. Streams `storage:sizes` (tagged with `scanId`); resolves when all are known. */
  scan(rel: string, scanId: string, force?: boolean): Promise<StorageSize[]>
  /** Abort a running scan. */
  cancel(scanId: string): Promise<void>
  /** Move one entry to the OS Trash. Refuses the config dir itself and locked entries. */
  trash(rel: string): Promise<void>
}

export interface StorageEvents {
  'storage:sizes': { scanId: string; rel: string; items: StorageSize[]; done: boolean }
}
