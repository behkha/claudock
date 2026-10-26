import type { ScreenId } from '../nav'

/**
 * Overview domain contract. Owned by the maintain worker.
 * `findings()` is the one implementation of the cleanup suggestions; Overview and Storage both use it.
 */

export type FindingKind =
  | 'bigProject'
  | 'bigSkillOff'
  | 'oldDownload'
  | 'looseBackups'
  | 'bigLog'
  | 'emptyClaudeMd'
  | 'bigFolder'

export type FindingAction =
  /** Jump to another screen. */
  | { type: 'open'; label: string; screen: ScreenId; selectId?: string }
  /** Move to Trash (the UI asks first). */
  | { type: 'trash'; label: string; rels: string[]; confirmTitle: string; confirmBody: string }
  /** Move loose backup files into backups/loose-<date>/ (no overwrite). */
  | { type: 'tidy'; label: string; rels: string[] }
  /** Snapshot, then empty the file. */
  | { type: 'clearLog'; label: string; rel: string; confirmTitle: string; confirmBody: string }

export interface Finding {
  id: string
  kind: FindingKind
  title: string
  /** Mono line under the title, usually a config-relative path. */
  detail: string
  /** Space this would free or that the item holds; undefined when size is not the point. */
  bytes?: number
  /** Config-relative paths the finding is about (Storage shows findings that fall inside the folder being viewed). */
  paths: string[]
  action: FindingAction
}

export interface OverviewSummary {
  configDir: string
  counts: {
    skills: number
    pluginSkills: number
    hooks: number
    hookEvents: number
    plugins: number
    pluginsEnabled: number
    rules: number
    projects: number
    prompts: number
  }
  glance: {
    model: string | null
    effort: string | null
    theme: string | null
    statusLine: string | null
  }
}

/** Numbers behind the share card. Every field may be missing; nothing here names a project, path, session or prompt. */
export interface WrappedStats {
  /** `YYYY-MM-DD` the numbers run up to (the cache's last computed day, else today). */
  asOf: string
  /** `YYYY-MM-DD` of the first session. */
  since: string | null
  /** Messages from Claude Code's stats cache; prompts (typed by you) when the cache is missing. */
  total: number | null
  unit: 'messages' | 'prompts'
  sessions: number | null
  longestSessionMs: number | null
  /** 0-23, local hour as recorded. */
  peakHour: number | null
  /** Friendly name such as "Opus 5". */
  topModel: string | null
  /** Messages per day (`YYYY-MM-DD`) for the 26-week heat map. */
  daily: Record<string, number>
}

export interface OverviewApi {
  summary(): Promise<OverviewSummary>
  /** Computes every cleanup finding. Streams each one as it is found (`overview:finding`) and resolves with the sorted list. */
  findings(scanId: string, force?: boolean): Promise<Finding[]>
  /** Move config-relative paths to the OS Trash. Returns how many were moved. */
  trash(rels: string[]): Promise<{ trashed: number }>
  /** Snapshot a log file, then truncate it. */
  clearLog(rel: string): Promise<{ snapshotId: string | null }>
  /** Read-only. Null when there is nothing to show (no stats cache and no history). */
  wrapped(): Promise<WrappedStats | null>
  /** Put a PNG on the clipboard. */
  copyImage(png: Uint8Array): Promise<void>
  /** Ask where to save a PNG (Downloads by default). `saved` is false when the dialog is cancelled. Writes outside the config folder. */
  saveImage(png: Uint8Array): Promise<{ saved: boolean }>
  /** Copy the PNG, then open the X compose page with a text built in main from the same numbers. */
  postOnX(png: Uint8Array): Promise<void>
}

export interface OverviewEvents {
  'overview:finding': { scanId: string; finding: Finding }
}
