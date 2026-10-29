import type { ScreenId } from '../nav'
import type { PlanChoice, Rates } from '../prices'

/**
 * Overview domain contract: the cleanup findings and the share cards' numbers (all time, and a week at API prices).
 * There is no Overview screen any more: Storage lists the findings, Today counts them in its chip, and Today and the
 * first-run reveal open Share stats.
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
  /** The most days in a row with any activity, over the whole history. A record, never a current count. */
  longestRunDays: number | null
}

/** One day of the week card, local. */
export interface WeekDay {
  /** `YYYY-MM-DD`. */
  date: string
  tokens: number
  /** At API prices, priced models only. */
  usd: number
  /** Still to come (the current week). */
  future: boolean
}

export interface WeekModel {
  /** Friendly name ("Opus 5.5"), or the id as recorded for a model that isn't Claude. */
  name: string
  tokens: number
  /** Null when the price table has no row for it: left out of the value. */
  usd: number | null
}

/** The week card's numbers, from the open profile's transcripts (and the session archive's copies). */
export interface WeekStats {
  /** Monday `YYYY-MM-DD` (local). */
  start: string
  /** Sunday. */
  end: string
  /** The week holding today. */
  current: boolean
  /** Monday of the oldest week the transcripts reach. */
  earliest: string
  /** Monday to Sunday. */
  days: WeekDay[]
  sessions: number
  /** What you typed, slash commands included. */
  prompts: number
  tokens: number
  /** First to last message of the week's longest session, within the week. */
  longestSessionMs: number | null
  topModel: string | null
  /** USD at API prices for every message whose model has a price; null when none had one. */
  usd: number | null
  /** Most tokens first. */
  models: WeekModel[]
  /** The rates this week's messages paid ("Opus 5.5", "Opus 5.5 fast"), and how many web searches they made. */
  prices: { asOf: string; source: string; rows: Array<Rates & { name: string }>; searches: number }
}

/** Per profile, in Claudock's own data. */
export interface ShareSettings {
  /** What goes beside the week's value. */
  plan: PlanChoice
  /** The Monday recap notification. */
  recap: boolean
}

/** Which card a Post or Save is for, and what the week's card shows beside its value: main builds the text and the file name from its own numbers. */
export type ShareCard = { kind: 'all' } | { kind: 'week'; start: string; plan: PlanChoice }

export interface OverviewApi {
  /** Computes every cleanup finding. Streams each one as it is found (`overview:finding`) and resolves with the sorted list. */
  findings(scanId: string, force?: boolean): Promise<Finding[]>
  /** Move config-relative paths to the OS Trash. Returns how many were moved. */
  trash(rels: string[]): Promise<{ trashed: number }>
  /** Snapshot a log file, then truncate it. */
  clearLog(rel: string): Promise<{ snapshotId: string | null }>
  /** Read-only. Null when there is nothing to show (no stats cache and no history). */
  wrapped(): Promise<WrappedStats | null>
  /** Read-only. The week starting on Monday `start` (`YYYY-MM-DD`); null for the week holding today. */
  week(start: string | null): Promise<WeekStats>
  shareSettings(): Promise<ShareSettings>
  setShareSettings(patch: Partial<ShareSettings>): Promise<ShareSettings>
  /** The week a recap notification asked to show for this profile, once; null when none is waiting. */
  takeShare(): Promise<string | null>
  /** Put a PNG on the clipboard. */
  copyImage(png: Uint8Array): Promise<void>
  /** Ask where to save a PNG (Downloads by default). `saved` is false when the dialog is cancelled. Writes outside the config folder. */
  saveImage(png: Uint8Array, card: ShareCard): Promise<{ saved: boolean }>
  /** Copy the PNG, then open the X compose page with a text built in main from the same numbers. */
  postOnX(png: Uint8Array, card: ShareCard): Promise<void>
}

export interface OverviewEvents {
  'overview:finding': { scanId: string; finding: Finding }
}
