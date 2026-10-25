import type { IpcMain } from 'electron'
import type { PermissionsApi, PermissionsData, RuleList } from '@shared/api/permissions'
import type { SettingsFileName } from '@shared/api/settings'
import { defineDomain } from '../ipcx'
import { assertSettingsFile, isPlainObject, readSettingsObject, updateSettingsObject, type JsonObject } from './settings'

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

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'permissions', impl)
}
