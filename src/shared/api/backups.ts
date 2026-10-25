import type { SnapshotInfo } from '../types'

/**
 * Backups domain contract. Owned by the maintain worker.
 * Restores always go through safeWrite, so the version being replaced is snapshotted first.
 */

export interface LooseBackup {
  /** Config-relative path. */
  rel: string
  name: string
  size: number
  mtimeMs: number
  location: 'root' | 'backups'
  /** Config-relative path of the live file this is a backup of, when it can be worked out and the file exists. */
  liveRel: string | null
  /** The name it looks like a backup of, even if that file is gone. */
  liveName: string | null
  /** Credentials-like file: listed as locked, never read. */
  hidden: boolean
}

export interface BackupsList {
  snapshots: SnapshotInfo[]
  loose: LooseBackup[]
}

/** What the diff pane needs for one backup file against its live file. */
export interface FileCompare {
  /** Live file (config-relative); null when the backup has no known live file. */
  liveRel: string | null
  liveExists: boolean
  /** Text of the backup and of the live file. Empty string when missing, binary or too large. */
  backup: string
  live: string
  backupMtimeMs: number | null
  binary: boolean
  tooLarge: boolean
  /** 'claudeJson': .claude.json is compared and restored per key; `backup`/`live` then hold only that key. */
  mode: 'file' | 'claudeJson'
  /** claudeJson mode: top-level keys that differ (names only). */
  differingKeys: string[]
  /** claudeJson mode: true when the mcpServers key differs, which is the only key that can be restored. */
  canRestoreKey: boolean
  /** Why restore is not possible (shown next to the disabled button). */
  restoreBlockedReason: string | null
}

export interface RestoreResult {
  /** Snapshot that now holds the version that was replaced. */
  snapshotId: string | null
}

export interface BackupsApi {
  list(): Promise<BackupsList>
  /** Compare one file of a Claudock snapshot with the live file. */
  snapshotFile(id: string, rel: string): Promise<FileCompare>
  /** Restore one file from a snapshot (claudeJson mode: only the mcpServers key). */
  restoreSnapshotFile(id: string, rel: string): Promise<RestoreResult>
  /** Move a snapshot folder to the OS Trash. */
  deleteSnapshot(id: string): Promise<void>
  looseCompare(rel: string): Promise<FileCompare>
  restoreLoose(rel: string): Promise<RestoreResult>
  trashLoose(rel: string): Promise<void>
  /** Move loose *.bak* files from the config root into backups/loose-<date>/. Never overwrites. */
  tidy(rels?: string[]): Promise<{ moved: number; folder: string }>
}

export interface BackupsEvents {}
