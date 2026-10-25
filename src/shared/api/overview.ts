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

export interface OverviewApi {
  summary(): Promise<OverviewSummary>
  /** Computes every cleanup finding. Streams each one as it is found (`overview:finding`) and resolves with the sorted list. */
  findings(scanId: string, force?: boolean): Promise<Finding[]>
  /** Move config-relative paths to the OS Trash. Returns how many were moved. */
  trash(rels: string[]): Promise<{ trashed: number }>
  /** Snapshot a log file, then truncate it. */
  clearLog(rel: string): Promise<{ snapshotId: string | null }>
}

export interface OverviewEvents {
  'overview:finding': { scanId: string; finding: Finding }
}
