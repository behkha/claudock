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

/**
 * What Claude Code's folder and Claudock's own data folder (userData) take on disk. Claudock's archive hard-links Claude
 * Code's transcripts, so a file manager adding up each folder counts those bytes twice; `real` counts each file once and
 * leaves out the files that are also in a Claude Code folder, like `du` does.
 */
export interface DiskCost {
  /** The open profile's config folder. */
  config: { path: string; bytes: number }
  data: {
    path: string
    /** Disk Claudock's folder really takes: each file once, none that a Claude Code folder also has. */
    real: number
    /** Claude Code's files the archive links to: no extra disk. */
    linked: number
    /** What Finder / Explorer shows for the folder: every file's size added up. */
    naive: number
    /** The prompts and replies kept for search. */
    searchText: number
    /** Transcripts only the archive has (Claude Code deleted them, or a disk without links). */
    keptSessions: number
    keptBytes: number
    /** The Claudock.app copy `npx claudock` keeps on macOS; null when there is none. */
    app: number | null
    snapshots: number
    /** Everything else: Electron's caches, settings, indexes. */
    other: number
  }
  at: number
}

export interface StorageApi {
  /** Both folders measured; cached for a minute unless `force`. */
  diskCost(force?: boolean): Promise<DiskCost>
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
