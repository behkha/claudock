/**
 * Hooks domain contract. Owned by the hooks worker.
 * Hooks live under the `hooks` key of settings.json / settings.local.json, in the shape Claude Code uses:
 *   { "<Event>": [ { "matcher"?: "Bash", "hooks": [ { "type": "command", "command": "...", "timeout"?: 10 } ] } ] }
 */
import type { SettingsFileName } from './settings'

/** Events Claudock always offers, in display order. Unknown events found in the file are kept and listed after these. */
export const KNOWN_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PermissionRequest'
] as const

export interface HookEntry {
  /** `<event>:<group index>:<hook index>`. Only valid for the `HooksData` it came from. */
  id: string
  event: string
  groupIndex: number
  hookIndex: number
  /** Null when the group has no matcher (matches everything). */
  matcher: string | null
  type: string
  /** The command (or, for non-command hook types, the prompt text). */
  command: string
  /** Which key holds `command` in the file: 'command' or 'prompt'. */
  commandKey: 'command' | 'prompt'
  timeout: number | null
  /** Config-dir-relative scripts the command mentions. */
  scripts: string[]
  /** One of Claudock's own hooks (Connect to Claude Code): listed together and never edited here. */
  claudock: boolean
}

export interface HooksData {
  file: SettingsFileName
  exists: boolean
  mtimeMs: number | null
  entries: HookEntry[]
  /** Known events first, then unknown events present in the file. */
  events: string[]
  /** Set when the file or its `hooks` key cannot be read as hooks; nothing can be edited then. */
  problem: string | null
}

/** What the editor sends. `ref` locates the hook being edited; it is checked against the file before anything changes. */
export interface HookInput {
  event: string
  matcher: string
  type: string
  command: string
  timeout: number | null
}

export interface HookRef {
  event: string
  groupIndex: number
  hookIndex: number
  /** Command the hook had when it was loaded, to detect that the file changed underneath. */
  command: string
}

export interface HooksApi {
  list(file: SettingsFileName): Promise<HooksData>
  /** Add a hook (no `ref`) or replace one (`ref`). Returns the refreshed list and the id of the saved hook. */
  save(file: SettingsFileName, input: HookInput, ref: HookRef | null): Promise<{ data: HooksData; savedId: string }>
  remove(file: SettingsFileName, ref: HookRef): Promise<HooksData>
}

export interface HooksEvents {}
