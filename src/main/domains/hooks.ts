import type { IpcMain } from 'electron'
import { KNOWN_HOOK_EVENTS, type HookEntry, type HookInput, type HookRef, type HooksApi, type HooksData } from '@shared/api/hooks'
import type { SettingsFileName } from '@shared/api/settings'
import { defineDomain } from '../ipcx'
import {
  assertSettingsFile,
  configScripts,
  hookCommandCount,
  isPlainObject,
  readSettingsObject,
  updateSettingsObject,
  type JsonObject
} from './settings'

const STALE = 'This hook changed on disk since the list was loaded. Reload and try again.'

function commandOf(h: JsonObject): { text: string; key: 'command' | 'prompt' } {
  if (typeof h.command === 'string') return { text: h.command, key: 'command' }
  if (typeof h.prompt === 'string') return { text: h.prompt, key: 'prompt' }
  return { text: '', key: 'command' }
}

async function list(fileIn: SettingsFileName): Promise<HooksData> {
  const file = assertSettingsFile(fileIn)
  const base: HooksData = { file, exists: false, mtimeMs: null, entries: [], events: [...KNOWN_HOOK_EVENTS], problem: null }
  let read: Awaited<ReturnType<typeof readSettingsObject>>
  try {
    read = await readSettingsObject(file)
  } catch (e) {
    return { ...base, problem: (e as Error).message }
  }
  base.exists = read.exists
  base.mtimeMs = read.mtimeMs
  const hooks = read.obj.hooks
  if (hooks === undefined) return base
  if (!isPlainObject(hooks)) return { ...base, problem: 'The hooks key in this file is not an object, so Claudock will not change it. Fix it in Settings > JSON.' }

  const problems: string[] = []
  for (const [event, groups] of Object.entries(hooks)) {
    if (!(KNOWN_HOOK_EVENTS as readonly string[]).includes(event)) base.events.push(event)
    if (!Array.isArray(groups)) {
      problems.push(event)
      continue
    }
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g]
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) {
        problems.push(event)
        continue
      }
      const matcher = typeof group.matcher === 'string' ? group.matcher : null
      for (let h = 0; h < group.hooks.length; h++) {
        const hook = group.hooks[h]
        if (!isPlainObject(hook)) continue
        const c = commandOf(hook)
        const entry: HookEntry = {
          id: `${event}:${g}:${h}`,
          event,
          groupIndex: g,
          hookIndex: h,
          matcher,
          type: typeof hook.type === 'string' ? hook.type : 'command',
          command: c.text,
          commandKey: c.key,
          timeout: typeof hook.timeout === 'number' ? hook.timeout : null,
          scripts: await configScripts(c.text)
        }
        base.entries.push(entry)
      }
    }
  }
  if (problems.length) {
    base.problem = `Some entries under ${[...new Set(problems)].join(', ')} are not in the usual shape and are not listed. Edit them in Settings > JSON.`
  }
  return base
}

function validate(input: HookInput): { event: string; matcher: string | null; type: string; command: string; timeout: number | null } {
  const event = String(input?.event ?? '').trim()
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(event)) throw new Error('Event names use letters, numbers and underscores only')
  const command = String(input?.command ?? '')
  if (!command.trim()) throw new Error('The command is empty')
  const type = String(input?.type ?? 'command').trim() || 'command'
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(type)) throw new Error('Unrecognised hook type')
  const matcher = String(input?.matcher ?? '').trim() || null
  let timeout: number | null = null
  if (input?.timeout !== null && input?.timeout !== undefined) {
    timeout = Number(input.timeout)
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 604_800) throw new Error('Timeout must be a positive number of seconds')
    timeout = Math.round(timeout)
  }
  return { event, matcher, type, command, timeout }
}

function hooksObject(obj: JsonObject, create: boolean): JsonObject | null {
  if (obj.hooks === undefined) {
    if (!create) return null
    const h: JsonObject = {}
    obj.hooks = h
    return h
  }
  if (!isPlainObject(obj.hooks)) throw new Error('The hooks key in this file is not an object. Fix it in Settings > JSON first.')
  return obj.hooks
}

/** Find the hook `ref` points at and check it is still the same one. */
function locate(hooks: JsonObject | null, ref: HookRef): { groups: unknown[]; group: JsonObject; hook: JsonObject } {
  const groups = hooks?.[ref.event]
  if (!Array.isArray(groups)) throw new Error(STALE)
  const group = groups[ref.groupIndex]
  if (!isPlainObject(group) || !Array.isArray(group.hooks)) throw new Error(STALE)
  const hook = group.hooks[ref.hookIndex]
  if (!isPlainObject(hook) || commandOf(hook).text !== ref.command) throw new Error(STALE)
  return { groups, group, hook }
}

function pruneEmpty(obj: JsonObject, hooks: JsonObject, event: string): void {
  const groups = hooks[event]
  if (Array.isArray(groups)) {
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i]
      if (isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0) groups.splice(i, 1)
    }
    if (groups.length === 0) delete hooks[event]
  }
  if (Object.keys(hooks).length === 0) delete obj.hooks
}

function applyFields(hook: JsonObject, v: ReturnType<typeof validate>): void {
  const key = v.type === 'command' || typeof hook.command === 'string' || typeof hook.prompt !== 'string' ? 'command' : 'prompt'
  const other = key === 'command' ? 'prompt' : 'command'
  hook.type = v.type
  hook[key] = v.command
  if (other in hook && typeof hook[other] === 'string' && v.type === 'command') delete hook[other]
  if (v.timeout !== null) hook.timeout = v.timeout
  else delete hook.timeout
}

const impl: HooksApi = {
  list,

  async save(fileIn, input, ref) {
    const file = assertSettingsFile(fileIn)
    const v = validate(input)
    let saved = { event: v.event, groupIndex: 0, hookIndex: 0 }
    await updateSettingsObject(
      file,
      (obj) => {
        const hooks = hooksObject(obj, true) as JsonObject
        let hook: JsonObject
        if (ref) {
          const at = locate(hooks, ref)
          hook = at.hook
          applyFields(hook, v)
          const sameEvent = ref.event === v.event
          const sameMatcher = (typeof at.group.matcher === 'string' ? at.group.matcher : null) === v.matcher
          if (sameEvent && sameMatcher) {
            saved = { event: v.event, groupIndex: ref.groupIndex, hookIndex: ref.hookIndex }
            return
          }
          if (sameEvent && at.group.hooks && (at.group.hooks as unknown[]).length === 1) {
            // the group holds only this hook: change its matcher in place and keep its position
            const rest: JsonObject = { ...at.group }
            delete rest.matcher
            at.groups[ref.groupIndex] = v.matcher === null ? rest : { matcher: v.matcher, ...rest }
            saved = { event: v.event, groupIndex: ref.groupIndex, hookIndex: 0 }
            return
          }
          // move: take it out of the old group, then fall through to insertion
          ;(at.group.hooks as unknown[]).splice(ref.hookIndex, 1)
          const oldGroups = at.groups
          if ((at.group.hooks as unknown[]).length === 0) oldGroups.splice(ref.groupIndex, 1)
          if (oldGroups.length === 0) delete hooks[ref.event]
        } else {
          hook = {}
          applyFields(hook, v)
        }
        let target = hooks[v.event]
        if (target === undefined) {
          target = []
          hooks[v.event] = target
        }
        if (!Array.isArray(target)) throw new Error(`The ${v.event} entry in this file is not a list. Fix it in Settings > JSON first.`)
        let gi = target.findIndex(
          (g) => isPlainObject(g) && Array.isArray(g.hooks) && (typeof g.matcher === 'string' ? g.matcher : null) === v.matcher
        )
        if (gi < 0) {
          target.push(v.matcher === null ? { hooks: [] } : { matcher: v.matcher, hooks: [] })
          gi = target.length - 1
        }
        const gh = (target[gi] as JsonObject).hooks as unknown[]
        gh.push(hook)
        saved = { event: v.event, groupIndex: gi, hookIndex: gh.length - 1 }
      },
      ref ? `Edit ${ref.event} hook in ${file}` : `Add ${v.event} hook to ${file}`
    )
    return { data: await list(file), savedId: `${saved.event}:${saved.groupIndex}:${saved.hookIndex}` }
  },

  async remove(fileIn, ref) {
    const file = assertSettingsFile(fileIn)
    await updateSettingsObject(
      file,
      (obj) => {
        const hooks = hooksObject(obj, false)
        const at = locate(hooks, ref)
        ;(at.group.hooks as unknown[]).splice(ref.hookIndex, 1)
        pruneEmpty(obj, hooks as JsonObject, ref.event)
      },
      `Remove ${ref.event} hook from ${file}`
    )
    return list(file)
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'hooks', impl)
}

/** Sidebar badge: hook commands across settings.json and settings.local.json. */
export async function count(): Promise<number> {
  return hookCommandCount()
}
