/**
 * Adding and removing Claudock's session hooks in a parsed settings.json object. Pure (no Electron or Node imports),
 * so `npm test` loads it as is. Claudock's hooks are recognised by their exact command, so the user's own hooks for
 * the same events stay where they are, untouched.
 */

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface HookGroup {
  event: string
  matcher: string | null
  entry: Json
}

/** What adding the hooks created, so removing them can drop exactly those containers again. */
export interface HooksAdded {
  /** The `hooks` key did not exist. */
  hooksKey: boolean
  /** Events that had no array before. */
  events: string[]
}

/** `hooks` must be missing or an object whose events (where present) are arrays; anything else is left alone. */
export function hooksProblem(settings: Json): string | null {
  const h = settings.hooks
  if (h === undefined) return null
  if (!isObj(h)) return "The hooks key in settings.json isn't an object"
  for (const [event, groups] of Object.entries(h)) if (!Array.isArray(groups)) return `hooks.${event} in settings.json isn't a list`
  return null
}

/** Every command string of a hook entry in `settings.hooks`, with the event it sits under. */
function* commands(settings: Json): Generator<{ event: string; command: string }> {
  if (!isObj(settings.hooks)) return
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) continue
      for (const e of g.hooks) if (isObj(e) && typeof e.command === 'string') yield { event, command: e.command }
    }
  }
}

/** True when any of `ours` (exact commands) is in settings.json. */
export function hasHooks(settings: Json, ours: ReadonlySet<string>): boolean {
  for (const c of commands(settings)) if (ours.has(c.command)) return true
  return false
}

/** Groups from `groups` whose command is not already under its event. */
export function missingGroups(settings: Json, groups: readonly HookGroup[]): HookGroup[] {
  const have = new Set<string>()
  for (const c of commands(settings)) have.add(`${c.event}\0${c.command}`)
  return groups.filter((g) => !have.has(`${g.event}\0${String(g.entry.command)}`))
}

/**
 * Append one group per hook (after the user's own groups for that event). Mutates `settings`.
 * Throws if `hooks` is not in the usual shape (see `hooksProblem`).
 */
export function addHooks(settings: Json, groups: readonly HookGroup[]): HooksAdded {
  const problem = hooksProblem(settings)
  if (problem) throw new Error(problem)
  const added: HooksAdded = { hooksKey: settings.hooks === undefined, events: [] }
  const hooks = (settings.hooks ??= {}) as Json
  for (const g of missingGroups(settings, groups)) {
    if (hooks[g.event] === undefined) {
      hooks[g.event] = []
      added.events.push(g.event)
    }
    ;(hooks[g.event] as unknown[]).push(g.matcher === null ? { hooks: [g.entry] } : { matcher: g.matcher, hooks: [g.entry] })
  }
  return added
}

/**
 * Remove every hook entry whose command is one of `ours`, wherever it sits (also when the user moved it into a group of
 * their own). A group that only held ours goes; an event list and the `hooks` key go only when they are empty now and
 * `added` says Claudock created them. Mutates `settings`; returns false when there was nothing to remove.
 */
export function removeHooks(settings: Json, ours: ReadonlySet<string>, added: HooksAdded | null): boolean {
  const hooks = settings.hooks
  if (!isObj(hooks)) return false
  let changed = false
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept: unknown[] = []
    let here = false
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) {
        kept.push(g)
        continue
      }
      const rest = g.hooks.filter((e) => !(isObj(e) && typeof e.command === 'string' && ours.has(e.command)))
      if (rest.length === g.hooks.length) {
        kept.push(g)
        continue
      }
      here = true
      if (rest.length > 0) kept.push({ ...g, hooks: rest })
    }
    if (!here) continue
    changed = true
    if (kept.length === 0 && added?.events.includes(event)) delete hooks[event]
    else hooks[event] = kept
  }
  if (changed && added?.hooksKey && Object.keys(hooks).length === 0) delete settings.hooks
  return changed
}
