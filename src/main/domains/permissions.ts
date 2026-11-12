import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { GitState, PermissionsApi, PermissionsData, ProjectRules, RuleFile, RuleList } from '@shared/api/permissions'
import type { SettingsFileName } from '@shared/api/settings'
import { folderKey } from '../connect/folder'
import { defineDomain } from '../ipcx'
import { configDir, globalStateFile } from '../paths'
import { gitState } from '../permissions/git'
import { RULE_FILES, buildRows, ruleId, rulesIn, type RuleFileRead, type SavedRule } from '../permissions/rows'
import { assertSettingsFile, isPlainObject, readSettingsObject, updateSettingsObject, type JsonObject } from './settings'

/**
 * Permissions: the open profile's own rules ("This profile": the `permissions` key of its settings.json and
 * settings.local.json), and the rules saved in projects ("Projects"): every `<project>/.claude/settings.json` and
 * `settings.local.json` of the projects Claude Code knows, read only, each rule classified in the main process
 * (src/main/permissions/) so a secret in one never reaches the window in full.
 */

const LISTS: RuleList[] = ['allow', 'ask', 'deny', 'additionalDirectories']
const LIST_LABEL: Record<RuleList, string> = { allow: 'allow', ask: 'ask', deny: 'deny', additionalDirectories: 'additional directories' }

function assertList(l: unknown): RuleList {
  if (typeof l !== 'string' || !(LISTS as string[]).includes(l)) throw new Error('Unknown permission list')
  return l as RuleList
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

async function get(fileIn: SettingsFileName): Promise<PermissionsData> {
  const file = assertSettingsFile(fileIn)
  const base: PermissionsData = {
    file,
    exists: false,
    mtimeMs: null,
    defaultMode: null,
    allow: [],
    ask: [],
    deny: [],
    additionalDirectories: [],
    otherKeys: [],
    problem: null
  }
  let read: Awaited<ReturnType<typeof readSettingsObject>>
  try {
    read = await readSettingsObject(file)
  } catch (e) {
    return { ...base, problem: (e as Error).message }
  }
  base.exists = read.exists
  base.mtimeMs = read.mtimeMs
  const p = read.obj.permissions
  if (p === undefined) return base
  if (!isPlainObject(p)) return { ...base, problem: 'The permissions key in this file is not an object, so Claudock will not change it. Fix it in Settings > JSON.' }
  base.defaultMode = typeof p.defaultMode === 'string' ? p.defaultMode : null
  for (const l of LISTS) {
    if (p[l] !== undefined && !Array.isArray(p[l])) {
      return { ...base, problem: `permissions.${l} is not a list, so Claudock will not change it. Fix it in Settings > JSON.` }
    }
    base[l] = strings(p[l])
  }
  base.otherKeys = Object.keys(p).filter((k) => k !== 'defaultMode' && !(LISTS as string[]).includes(k))
  return base
}

function permsObject(obj: JsonObject, create: boolean): JsonObject | null {
  if (obj.permissions === undefined) {
    if (!create) return null
    const p: JsonObject = {}
    obj.permissions = p
    return p
  }
  if (!isPlainObject(obj.permissions)) throw new Error('The permissions key in this file is not an object. Fix it in Settings > JSON first.')
  return obj.permissions
}

function listOf(p: JsonObject, l: RuleList, create: boolean): unknown[] | null {
  const cur = p[l]
  if (cur === undefined) {
    if (!create) return null
    const a: unknown[] = []
    p[l] = a
    return a
  }
  if (!Array.isArray(cur)) throw new Error(`permissions.${l} is not a list. Fix it in Settings > JSON first.`)
  return cur
}

function cleanRule(rule: unknown, list: RuleList): string {
  const r = String(rule ?? '').trim()
  if (!r) throw new Error('The rule is empty')
  if (/[\r\n\0]/.test(r)) throw new Error('A rule is a single line')
  if (list !== 'additionalDirectories') {
    const open = r.indexOf('(')
    if (open >= 0 && !r.endsWith(')')) throw new Error('A rule with a specifier ends with ")", for example Bash(npm run test:*)')
    if (open === 0) throw new Error('A rule starts with a tool name, for example Bash(npm run test:*)')
  }
  return r
}

const impl: PermissionsApi = {
  get,
  projectRules: () => projectRules(),

  async setDefaultMode(fileIn, mode) {
    const file = assertSettingsFile(fileIn)
    if (mode !== null && (typeof mode !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(mode))) throw new Error('Unrecognised mode')
    await updateSettingsObject(
      file,
      (obj) => {
        const p = permsObject(obj, mode !== null)
        if (!p) return false
        if (mode === null) {
          if (!('defaultMode' in p)) return false
          delete p.defaultMode
        } else p.defaultMode = mode
      },
      mode === null ? `Clear default permission mode in ${file}` : `Set default permission mode to ${mode} in ${file}`
    )
    return get(file)
  },

  async addRule(fileIn, listIn, ruleIn) {
    const file = assertSettingsFile(fileIn)
    const list = assertList(listIn)
    const rule = cleanRule(ruleIn, list)
    await updateSettingsObject(
      file,
      (obj) => {
        const arr = listOf(permsObject(obj, true) as JsonObject, list, true) as unknown[]
        if (arr.includes(rule)) throw new Error(`That rule is already in ${LIST_LABEL[list]}`)
        arr.push(rule)
      },
      `Add ${LIST_LABEL[list]} rule to ${file}`
    )
    return get(file)
  },

  async removeRule(fileIn, listIn, rule) {
    const file = assertSettingsFile(fileIn)
    const list = assertList(listIn)
    await updateSettingsObject(
      file,
      (obj) => {
        const p = permsObject(obj, false)
        const arr = p ? listOf(p, list, false) : null
        const i = arr ? arr.indexOf(rule) : -1
        if (!arr || i < 0) return false
        arr.splice(i, 1)
      },
      `Remove ${LIST_LABEL[list]} rule from ${file}`
    )
    return get(file)
  },

  async moveRule(fileIn, fromIn, toIn, rule) {
    const file = assertSettingsFile(fileIn)
    const from = assertList(fromIn)
    const to = assertList(toIn)
    if (from === to) return get(file)
    if ((from === 'additionalDirectories') !== (to === 'additionalDirectories')) throw new Error('Directories and tool rules cannot swap lists')
    await updateSettingsObject(
      file,
      (obj) => {
        const p = permsObject(obj, false)
        const src = p ? listOf(p, from, false) : null
        const i = src ? src.indexOf(rule) : -1
        if (!p || !src || i < 0) throw new Error('That rule is no longer in the file. Reload and try again.')
        const dst = listOf(p, to, true) as unknown[]
        src.splice(i, 1)
        if (!dst.includes(rule)) dst.push(rule)
      },
      `Move a rule from ${LIST_LABEL[from]} to ${LIST_LABEL[to]} in ${file}`
    )
    return get(file)
  }
}

/* ------------------------------------------------------------------ rules saved in projects */

/** A rule file is not read past this size: no settings file is this large. */
const MAX_RULE_FILE = 2_000_000

/** One rule file as last read, kept while its size and time stay the same. */
interface CachedFile {
  size: number
  mtimeMs: number
  /** Null: not readable as JSON. */
  rules: SavedRule[] | null
  git: GitState
  /** The repo's index time the git state was read at: `git add` changes what git says without touching the file. */
  indexMtimeMs: number
}

/** Per profile folder: its projects' rule files, and each listed rule as saved (which never leaves this process). */
interface Scan {
  files: Map<string, CachedFile>
  saved: Map<string, { projectPath: string; file: RuleFile; rule: SavedRule }>
}
const scans = new Map<string, Scan>()
const scanOf = (dir: string): Scan => {
  const k = folderKey(dir)
  let s = scans.get(k)
  if (!s) scans.set(k, (s = { files: new Map(), saved: new Map() }))
  return s
}

/** The projects Claude Code knows: the keys of `projects` in the profile's global state file (absolute folder paths). */
async function knownProjects(): Promise<string[]> {
  try {
    const o = JSON.parse(await fsp.readFile(globalStateFile(), 'utf8')) as unknown
    if (!isPlainObject(o) || !isPlainObject(o.projects)) return []
    return Object.keys(o.projects).filter((p) => path.isAbsolute(p))
  } catch {
    return []
  }
}

/** `<project>/.claude/<file>` when it is a regular file in a real `.claude` folder (neither reached through a link). */
async function plainRuleFile(project: string, file: RuleFile): Promise<{ abs: string; size: number; mtimeMs: number } | null> {
  const folder = await fsp.lstat(path.join(project, '.claude')).catch(() => null)
  if (!folder?.isDirectory()) return null
  const abs = path.join(project, '.claude', file)
  const st = await fsp.lstat(abs).catch(() => null)
  return st?.isFile() ? { abs, size: st.size, mtimeMs: st.mtimeMs } : null
}

/**
 * Every rule file of every known project, re-reading only the files that changed, and git asked only about files that
 * hold rules. `dismissed`: the ids marked "Not a secret".
 */
async function scanProjectRules(dismissed: ReadonlySet<string> = new Set()): Promise<ProjectRules> {
  const scan = scanOf(configDir())
  const reads: RuleFileRead[] = []
  const seen = new Set<string>()
  let unreadable = 0
  for (const project of await knownProjects()) {
    for (const file of RULE_FILES) {
      const at = await plainRuleFile(project, file)
      if (!at || seen.has(at.abs)) continue
      seen.add(at.abs)
      const indexMtimeMs = await fsp.stat(path.join(project, '.git', 'index')).then((s) => s.mtimeMs, () => 0)
      let c = scan.files.get(at.abs)
      if (!c || c.size !== at.size || c.mtimeMs !== at.mtimeMs) {
        const text = at.size <= MAX_RULE_FILE ? await fsp.readFile(at.abs, 'utf8').catch(() => null) : null
        c = { size: at.size, mtimeMs: at.mtimeMs, rules: text === null ? null : rulesIn(text), git: null, indexMtimeMs: -1 }
        scan.files.set(at.abs, c)
      }
      if (!c.rules) {
        unreadable++
        continue
      }
      if (c.rules.length === 0) continue
      if (c.indexMtimeMs !== indexMtimeMs) {
        c.git = await gitState(project, `.claude/${file}`)
        c.indexMtimeMs = indexMtimeMs
      }
      reads.push({ projectPath: project, file, mtimeMs: c.mtimeMs, git: c.git, rules: c.rules })
    }
  }
  for (const abs of scan.files.keys()) if (!seen.has(abs)) scan.files.delete(abs)
  scan.saved = new Map(reads.flatMap((f) => f.rules.map((rule) => [ruleId(f.projectPath, f.file, rule.list, rule.rule), { projectPath: f.projectPath, file: f.file, rule }] as const)))
  return buildRows(reads, dismissed, unreadable)
}

/** Every permission rule saved in the projects Claude Code knows, for Permissions › Projects. */
export const projectRules = (): Promise<ProjectRules> => scanProjectRules()

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'permissions', impl)
}
