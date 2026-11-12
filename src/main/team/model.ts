import crypto from 'node:crypto'
import type { Finding, Fix, FixChoice, JoinCommands, TeamItemState, TeamKind, TeamRemote } from '@shared/api/team'
import { MASK, secretSpans } from '../../shared/secrets.ts'

/**
 * The pure parts of Team mode (src/main/domains/team.ts): what is wrong with an item before it may be shared, the
 * files a write puts in the team folder, where each item stands against the repo, the pointer in a connected
 * project and the commands to copy. No Electron and no file access here, so `npm test` loads it as is.
 *
 * The team folder holds an ordinary Claude Code marketplace with one plugin:
 *   .claude-plugin/marketplace.json
 *   plugins/<plugin>/.claude-plugin/plugin.json, skills/, agents/, commands/, hooks/hooks.json, bin/, .mcp.json
 *   plugins/<plugin>/.claudock.json   what Claudock wrote, so it only ever changes its own files
 * Every path in this file is relative to the plugin folder with forward slashes, unless it says "root".
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObj = { [key: string]: Json }

export const isObj = (v: unknown): v is JsonObj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const sha256 = (data: Uint8Array | string): string => crypto.createHash('sha256').update(data).digest('hex')

/** JSON with every object's keys sorted: the same value always gives the same text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/** As Claudock writes every JSON file: 2-space indentation and a trailing newline. */
export const jsonText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** The text of a file when it is text (valid UTF-8 without NUL bytes), else null. */
export function textOf(data: Uint8Array): string | null {
  if (data.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ what the domain collects */

export interface SrcFile {
  /** Inside the item's own folder, forward slashes. */
  rel: string
  data: Uint8Array
}

export interface HookScript {
  /** The file the command runs, as written in the command (quotes included). */
  token: string
  abs: string
  /** A regular file small enough to copy; `data` is set with it. */
  file: boolean
  data: Uint8Array | null
}

export type Source =
  | { kind: 'skill'; id: string; name: string; files: SrcFile[]; link: boolean; bytes: number }
  /** `rel` is the file under agents/ or commands/ (a command may sit in a folder: `review/pr.md`). */
  | { kind: 'agent'; id: string; name: string; rel: string; data: Uint8Array }
  | { kind: 'command'; id: string; name: string; rel: string; data: Uint8Array }
  | { kind: 'hook'; id: string; name: string; event: string; matcher: string | null; entry: JsonObj; commandKey: 'command' | 'prompt'; script: HookScript | null }
  | { kind: 'mcp'; id: string; name: string; config: JsonObj }

export const BIG_SKILL_BYTES = 5 * 1024 * 1024
export const MAX_SCRIPT_BYTES = 1024 * 1024
const MAX_SCAN_BYTES = 256 * 1024

/* ------------------------------------------------------------------ paths on this computer */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `/Users/me/bin/x` -> `~/bin/x`, for showing. */
export function tilde(abs: string, home: string): string {
  return home && (abs === home || abs.startsWith(`${home}/`) || abs.startsWith(`${home}\\`)) ? `~${abs.slice(home.length)}` : abs
}

/** A command's words, quotes kept on each word as written. */
export function words(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|[^\s"']+(?:"[^"]*"|'[^']*'|[^\s"'])*/g) ?? []
}

const unquote = (w: string): string => (w.length >= 2 && ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) ? w.slice(1, -1) : w)

/** A word that names something under the home folder (`~/…`, `$HOME/…`, `${HOME}/…` or the folder itself): its full path, else null. */
export function underHome(word: string, home: string): string | null {
  const w = unquote(word)
  for (const p of ['~', '$HOME', '${HOME}']) {
    if (w === p) return home
    if (w.startsWith(`${p}/`) || w.startsWith(`${p}\\`)) return home + w.slice(p.length)
  }
  if (home && (w === home || w.startsWith(`${home}/`) || w.startsWith(`${home}\\`))) return w
  return null
}

/** The first word of a hook's command that is a path under the home folder: the script it runs. */
export function hookScriptToken(command: string, home: string): { token: string; abs: string } | null {
  for (const w of words(command)) {
    const abs = underHome(w, home)
    if (abs && abs !== home) return { token: w, abs }
  }
  return null
}

/** True when the text names this computer's home folder outright. `~/` is fine: it means each reader's own. */
export function namesHome(text: string, home: string): boolean {
  return home.length > 1 && new RegExp(`${escapeRe(home)}(?![A-Za-z0-9_.-])`).test(text)
}

/* ------------------------------------------------------------------ secrets (the patterns are in src/shared/secrets.ts, shared with the saved-rules check) */

export interface SecretHit {
  /** `headers.<name>`, `env.<name>`, `args.<index>` or `url`. */
  where: string
  /** The parts of the value that are the secret, in order, not overlapping. */
  spans: [number, number][]
}

/** Every literal secret in an MCP server's settings. Values already read from a variable (`${…}`) are left alone. */
export function findSecrets(config: JsonObj): SecretHit[] {
  const hits: SecretHit[] = []
  const push = (where: string, value: unknown, name: string | null, isUrl = false): void => {
    if (typeof value !== 'string') return
    const spans = secretSpans(value, name, isUrl)
    if (spans.length) hits.push({ where, spans })
  }
  for (const part of ['headers', 'env'] as const) {
    const o = config[part]
    if (isObj(o)) for (const [k, v] of Object.entries(o)) push(`${part}.${k}`, v, k)
  }
  if (Array.isArray(config.args)) config.args.forEach((a, i) => push(`args.${i}`, a, null, typeof a === 'string' && a.includes('://')))
  push('url', config.url, null, true)
  return hits
}

function valueAt(config: JsonObj, where: string): string | null {
  const dot = where.indexOf('.')
  if (dot < 0) return typeof config[where] === 'string' ? (config[where] as string) : null
  const part = config[where.slice(0, dot)]
  const key = where.slice(dot + 1)
  const v = Array.isArray(part) ? part[Number(key)] : isObj(part) ? part[key] : undefined
  return typeof v === 'string' ? v : null
}

function withValueAt(config: JsonObj, where: string, value: string): JsonObj {
  const dot = where.indexOf('.')
  if (dot < 0) return { ...config, [where]: value }
  const name = where.slice(0, dot)
  const key = where.slice(dot + 1)
  const part = config[name]
  if (Array.isArray(part)) return { ...config, [name]: part.map((x, i) => (i === Number(key) ? value : x)) }
  return { ...config, [name]: { ...(isObj(part) ? part : {}), [key]: value } }
}

/** The value with each secret span replaced by `put`. */
function replaceSpans(value: string, spans: [number, number][], put: string): string {
  let out = ''
  let at = 0
  for (const [s, e] of spans) {
    out += value.slice(at, s) + put
    at = e
  }
  return out + value.slice(at)
}

/** The settings with every literal secret replaced by dots: what may be shown or logged. */
export function maskSecrets(config: JsonObj): JsonObj {
  let out = config
  for (const hit of findSecrets(config)) {
    const value = valueAt(config, hit.where)
    if (value !== null) out = withValueAt(out, hit.where, replaceSpans(value, hit.spans, MASK))
  }
  return out
}

const CONFIG_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const snake = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

/** The `userConfig` key offered for a secret: `github_token`, `api_key`. */
export function suggestKey(server: string, where: string): string {
  const [part, key = ''] = [where.slice(0, where.indexOf('.')), where.slice(where.indexOf('.') + 1)]
  const base = part === 'env' ? snake(key) : part === 'headers' && /^authorization$/i.test(key) ? `${snake(server)}_token` : part === 'headers' ? `${snake(server)}_${snake(key)}` : `${snake(server)}_secret`
  const k = /^[a-z]/.test(base) ? base : `k_${base}`
  return k.slice(0, 64) || 'secret'
}

export const fixProblem = (fix: Fix): string | null => {
  if (fix.kind === 'ask' && !CONFIG_KEY_RE.test(fix.key)) return 'Use lowercase letters, digits and underscores.'
  if (fix.kind === 'env' && !ENV_NAME_RE.test(fix.name)) return 'Use letters, digits and underscores.'
  if (fix.kind === 'copy-script' && !/^[A-Za-z0-9._-]{1,80}$/.test(fix.as)) return 'Use letters, digits, dots, dashes and underscores.'
  return null
}

/* ------------------------------------------------------------------ findings */

const CHOICE: Record<FixChoice['kind'], string> = {
  ask: 'Ask each teammate',
  env: 'Read from a variable',
  'copy-script': 'Copy it in',
  keep: 'Keep',
  mine: 'Use mine',
  theirs: "Take the repo's",
  untick: 'Leave it out'
}
const choices = (...kinds: FixChoice['kind'][]): FixChoice[] => kinds.map((kind) => ({ kind, label: CHOICE[kind] }))

const fixAt = (fixes: Fix[], where: string, ...kinds: Fix['kind'][]): Fix | undefined => fixes.find((f) => f.where === where && kinds.includes(f.kind))

function finding(src: Source, code: Finding['code'], where: string, text: string, blocks: boolean, ch: FixChoice[], fix?: Fix): Finding {
  return { key: `${src.id}|${code}|${where}`, itemId: src.id, itemName: src.name, code, where, text, blocks, choices: ch, ...(fix ? { fix } : {}) }
}

/** What stands between an item and the team folder, each with the fix chosen for it (if any). */
export function findingsFor(src: Source, fixes: Fix[], home: string): Finding[] {
  const out: Finding[] = []
  if (src.kind === 'skill') {
    if (src.link) out.push(finding(src, 'link', 'folder', 'Is a link to another folder', true, choices('untick')))
    if (src.bytes > BIG_SKILL_BYTES) out.push(finding(src, 'big', 'folder', 'Is over 5 MB', false, choices('keep', 'untick'), fixAt(fixes, 'folder', 'keep')))
    const named = src.files.some((f) => f.data.length <= MAX_SCAN_BYTES && namesHome(textOf(f.data) ?? '', home))
    if (named) out.push(finding(src, 'home-mention', 'text', 'Names a folder on your computer', false, choices('keep', 'untick'), fixAt(fixes, 'text', 'keep')))
  } else if (src.kind === 'agent' || src.kind === 'command') {
    if (namesHome(textOf(src.data) ?? '', home)) out.push(finding(src, 'home-mention', 'text', 'Names a folder on your computer', false, choices('keep', 'untick'), fixAt(fixes, 'text', 'keep')))
  } else if (src.kind === 'hook') {
    const command = str(src.entry[src.commandKey])
    const s = src.script
    if (src.commandKey === 'command' && s) {
      const copy = fixAt(fixes, 'command', 'copy-script')
      if (s.file) out.push(finding(src, 'script', 'command', `Runs ${tilde(s.abs, home)}, which only you have`, true, choices('copy-script', 'untick'), copy))
      else out.push(finding(src, 'home-command', 'command', `Runs ${tilde(s.abs, home)}, which cannot be copied in`, true, choices('untick')))
      // anything else from the home folder is still out of a teammate's reach after the copy
      const more = words(command).some((w) => w !== s.token && underHome(w, home))
      if (more && s.file) out.push(finding(src, 'home-command', 'more', 'Uses more than one thing from your home folder', true, choices('untick')))
    }
  } else {
    for (const hit of findSecrets(src.config)) {
      out.push(finding(src, 'secret', hit.where, 'A token is written in its settings', true, choices('ask', 'env', 'untick'), fixAt(fixes, hit.where, 'ask', 'env')))
    }
    const parts = [str(src.config.command), ...(Array.isArray(src.config.args) ? src.config.args.map(str) : [])]
    if (parts.some((p) => underHome(p, home) || namesHome(p, home))) out.push(finding(src, 'home-command', 'command', 'Starts from your home folder', true, choices('untick')))
  }
  return out
}

/** A finding that still stops the write. */
export const isOpen = (f: Finding): boolean => f.blocks && !f.fix
/** A finding still to look at: a blocker without a fix, or a warning not accepted. */
export const isUnsettled = (f: Finding): boolean => !f.fix

/* ------------------------------------------------------------------ an item as it is written */

export interface OutFile {
  rel: string
  data: Uint8Array
}

export interface ItemOut {
  id: string
  kind: TeamKind
  name: string
  files: OutFile[]
  hook?: { event: string; key: string; group: JsonObj }
  mcp?: { name: string; config: JsonObj }
  userConfig?: JsonObj
  /** Over everything above: equal when two copies of the item are the same. */
  sha: string
}

interface ShaParts {
  files: [string, string][]
  hook: Json
  mcp: Json
  userConfig: Json
}

const partsSha = (p: ShaParts): string => sha256(canonical({ ...p, files: [...p.files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) }))

export const PLUGIN_ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}'
const BIN_RE = /\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/([A-Za-z0-9._-]+)/

/** What tells one hook of the plugin from another: its event, matcher and the script it runs (else its whole command). */
export function hookKey(event: string, matcher: string | null, entry: JsonObj): string {
  const command = str(entry.command) || str(entry.prompt)
  const bin = BIN_RE.exec(command)
  return `${event}|${matcher ?? ''}|${bin ? `bin/${bin[1]}` : command}`
}

/** The item with its fixes applied, as it goes into the plugin. Fixes that don't apply are ignored. */
export function buildOut(src: Source, fixes: Fix[]): ItemOut {
  const files: OutFile[] = []
  let hook: ItemOut['hook']
  let mcp: ItemOut['mcp']
  let userConfig: JsonObj | undefined
  if (src.kind === 'skill') {
    for (const f of src.files) files.push({ rel: `skills/${src.name}/${f.rel}`, data: f.data })
  } else if (src.kind === 'agent' || src.kind === 'command') {
    files.push({ rel: `${src.kind}s/${src.rel}`, data: src.data })
  } else if (src.kind === 'hook') {
    let entry = src.entry
    const copy = fixAt(fixes, 'command', 'copy-script')
    if (copy?.kind === 'copy-script' && src.script?.file && src.script.data && src.commandKey === 'command') {
      entry = { ...entry, command: str(entry.command).replace(src.script.token, `"${PLUGIN_ROOT_VAR}/bin/${copy.as}"`) }
      files.push({ rel: `bin/${copy.as}`, data: src.script.data })
    }
    const group: JsonObj = { ...(src.matcher !== null ? { matcher: src.matcher } : {}), hooks: [entry] }
    hook = { event: src.event, key: hookKey(src.event, src.matcher, entry), group }
  } else {
    let config = src.config
    for (const hit of findSecrets(src.config)) {
      const fix = fixAt(fixes, hit.where, 'ask', 'env')
      const value = valueAt(src.config, hit.where)
      if (!fix || value === null) continue
      if (fix.kind === 'ask') {
        config = withValueAt(config, hit.where, replaceSpans(value, hit.spans, `\${user_config.${fix.key}}`))
        userConfig = {
          ...userConfig,
          [fix.key]: { type: 'string', title: `${src.name} token`, description: `Used by the ${src.name} MCP server.`, sensitive: true, required: true }
        }
      } else if (fix.kind === 'env') {
        config = withValueAt(config, hit.where, replaceSpans(value, hit.spans, `\${${fix.name}}`))
      }
    }
    mcp = { name: src.name, config }
  }
  const sha = partsSha({ files: files.map((f) => [f.rel, sha256(f.data)]), hook: hook?.group ?? null, mcp: mcp?.config ?? null, userConfig: userConfig ?? null })
  return { id: src.id, kind: src.kind, name: src.name, files, ...(hook ? { hook } : {}), ...(mcp ? { mcp } : {}), ...(userConfig ? { userConfig } : {}), sha }
}

/* ------------------------------------------------------------------ the repo as it is */

export interface ManifestItem {
  id: string
  kind: TeamKind
  name: string
  sha: string
  files: string[]
  hook?: { event: string; key: string }
  mcp?: string
  userConfig?: string[]
}

export interface Manifest {
  claudock: 1
  plugin: string
  items: ManifestItem[]
  /** Every file Claudock wrote in the plugin folder, with its hash. */
  files: Record<string, string>
}

export const MANIFEST_NAME = '.claudock.json'

export function parseManifest(v: unknown): Manifest | null {
  if (!isObj(v) || v.claudock !== 1 || !Array.isArray(v.items) || !isObj(v.files)) return null
  const items: ManifestItem[] = []
  for (const it of v.items) {
    if (!isObj(it) || typeof it.id !== 'string' || typeof it.sha !== 'string' || !Array.isArray(it.files)) return null
    const kind = str(it.kind)
    if (!['skill', 'agent', 'command', 'hook', 'mcp'].includes(kind)) return null
    const hook = isObj(it.hook) ? { event: str(it.hook.event), key: str(it.hook.key) } : undefined
    items.push({
      id: it.id,
      kind: kind as TeamKind,
      name: str(it.name),
      sha: it.sha,
      files: it.files.filter((f): f is string => typeof f === 'string'),
      ...(hook ? { hook } : {}),
      ...(typeof it.mcp === 'string' ? { mcp: it.mcp } : {}),
      ...(Array.isArray(it.userConfig) ? { userConfig: it.userConfig.filter((k): k is string => typeof k === 'string') } : {})
    })
  }
  const files: Record<string, string> = {}
  for (const [k, s] of Object.entries(v.files)) if (typeof s === 'string') files[k] = s
  return { claudock: 1, plugin: str(v.plugin), items, files }
}

export interface RepoView {
  /** Every file under the plugin folder -> its hash. */
  files: Map<string, string>
  manifest: Manifest | null
  /** hooks/hooks.json, .mcp.json, .claude-plugin/plugin.json and the root's marketplace.json, parsed; undefined when missing or unreadable. */
  hooks?: unknown
  mcp?: unknown
  pluginJson?: unknown
  marketplace?: unknown
  /** The root has a README. */
  readme: boolean
}

export const emptyRepo = (): RepoView => ({ files: new Map(), manifest: null, readme: false })

const hooksOf = (v: unknown): JsonObj => (isObj(v) && isObj(v.hooks) ? v.hooks : {})
const serversOf = (v: unknown): JsonObj => (isObj(v) ? (isObj(v.mcpServers) ? v.mcpServers : Object.values(v).every(isObj) ? v : {}) : {})
const userConfigOf = (v: unknown): JsonObj => (isObj(v) && isObj(v.userConfig) ? v.userConfig : {})

/** The repo's hook with this key, as a group of its own; null when it has none. */
export function repoHook(view: RepoView, event: string, key: string): JsonObj | null {
  const groups = hooksOf(view.hooks)[event]
  if (!Array.isArray(groups)) return null
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.hooks)) continue
    const matcher = typeof g.matcher === 'string' ? g.matcher : null
    for (const h of g.hooks) {
      if (isObj(h) && hookKey(event, matcher, h) === key) return { ...(matcher !== null ? { matcher } : {}), hooks: [h] }
    }
  }
  return null
}

interface Where {
  kind: TeamKind
  name: string
  files: string[]
  hook?: { event: string; key: string }
  mcp?: string
  userConfig?: string[]
}

/** The hash of what the repo holds for an item now, the way `ItemOut.sha` is made; null when it holds nothing of it. */
export function repoSha(at: Where, view: RepoView): string | null {
  const rels = at.kind === 'skill' ? [...view.files.keys()].filter((r) => r.startsWith(`skills/${at.name}/`)) : at.files
  const files: [string, string][] = []
  for (const r of rels) {
    const s = view.files.get(r)
    if (s !== undefined) files.push([r, s])
  }
  const hook = at.hook ? repoHook(view, at.hook.event, at.hook.key) : null
  const servers = serversOf(view.mcp)
  const mcp = at.mcp !== undefined && isObj(servers[at.mcp]) ? servers[at.mcp] : null
  const uc = userConfigOf(view.pluginJson)
  const keys = (at.userConfig ?? []).filter((k) => k in uc)
  const userConfig = keys.length ? Object.fromEntries(keys.map((k) => [k, uc[k]])) : null
  if (!files.length && !hook && !mcp) return null
  return partsSha({ files, hook, mcp, userConfig })
}

const whereOfOut = (o: ItemOut): Where => ({
  kind: o.kind,
  name: o.name,
  files: o.files.map((f) => f.rel),
  ...(o.hook ? { hook: { event: o.hook.event, key: o.hook.key } } : {}),
  ...(o.mcp ? { mcp: o.mcp.name } : {}),
  ...(o.userConfig ? { userConfig: Object.keys(o.userConfig) } : {})
})

/**
 * Where an item stands. `out` is the user's copy as it would be written (null when they no longer have it), `rec` what
 * Claudock last wrote for it (null when never).
 */
export function stateOf(ticked: boolean, out: ItemOut | null, rec: ManifestItem | null, view: RepoView): TeamItemState | null {
  if (!rec) {
    if (!ticked || !out) return null
    const repo = repoSha(whereOfOut(out), view)
    return repo === null ? 'new' : repo === out.sha ? 'published' : 'changed-both'
  }
  const repo = repoSha(rec, view)
  if (!ticked || !out) return repo === null ? null : 'removed'
  const mine = out.sha
  if (mine === rec.sha) return repo === rec.sha ? 'published' : 'changed-repo'
  if (repo === rec.sha) return 'changed-here'
  return repo === mine ? 'published' : 'changed-both'
}

/** States whose next write changes the repo. */
export const isChange = (s: TeamItemState | null): boolean => s === 'new' || s === 'changed-here' || s === 'changed-both' || s === 'removed'

/* ------------------------------------------------------------------ the write */

export interface PlanItem {
  out: ItemOut
  /** `keep`: leave what the repo has for it (changed there, not settled here yet). */
  mode: 'write' | 'keep'
}

export interface PlanSetup {
  marketplace: string
  plugin: string
  owner: string
}

export interface Plan {
  /** Root-relative path -> bytes, for every file Claudock keeps in the team folder (changed or not). */
  writes: Map<string, Uint8Array>
  /** Root-relative files of its own that go away. */
  removes: string[]
  manifest: Manifest
}

export const pluginDir = (plugin: string): string => `plugins/${plugin}`
const describe = (owner: string): string => `${owner}'s shared Claude Code setup`

function readme(setup: PlanSetup, remote: TeamRemote | null): string {
  return [
    `# ${describe(setup.owner)}`,
    '',
    'A Claude Code plugin marketplace with one plugin: the skills, agents, commands, hooks and MCP servers the team shares.',
    '',
    '## Join',
    '',
    'Add this repository as a marketplace in Claude Code and install the plugin:',
    '',
    '```sh',
    `claude plugin marketplace add ${remote ? remote.text : '<this repository>'}`,
    `claude plugin install ${setup.plugin}@${setup.marketplace}`,
    '```',
    ''
  ].join('\n')
}

/**
 * Everything a write puts in the team folder. Items the repo has that Claudock didn't write (other hooks, servers,
 * plugins of the marketplace, unknown keys) stay as they are.
 */
export function buildPlan(setup: PlanSetup, items: PlanItem[], view: RepoView, remote: TeamRemote | null = null): Plan {
  const old = view.manifest
  const kept = new Set(items.filter((i) => i.mode === 'keep').map((i) => i.out.id))
  const oldKept = (old?.items ?? []).filter((r) => kept.has(r.id))
  const oldGone = (old?.items ?? []).filter((r) => !kept.has(r.id))
  const writing = items.filter((i) => i.mode === 'write').map((i) => i.out)
  const root = pluginDir(setup.plugin)
  const own = new Map<string, Uint8Array>()

  for (const o of writing) for (const f of o.files) own.set(f.rel, f.data)

  // hooks/hooks.json: the repo's file without the hooks Claudock wrote last time, plus the ones it writes now
  const hooksFile: JsonObj = isObj(view.hooks) ? { ...view.hooks } : {}
  const hooks: JsonObj = {}
  const goneKeys = new Set(oldGone.filter((r) => r.hook).map((r) => `${r.hook?.event}\n${r.hook?.key}`))
  for (const [event, groups] of Object.entries(hooksOf(view.hooks))) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups
      continue
    }
    const left: Json[] = []
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks)) {
        left.push(g)
        continue
      }
      const matcher = typeof g.matcher === 'string' ? g.matcher : null
      const hs = g.hooks.filter((h) => !(isObj(h) && goneKeys.has(`${event}\n${hookKey(event, matcher, h)}`)))
      if (hs.length) left.push(hs.length === g.hooks.length ? g : { ...g, hooks: hs })
    }
    if (left.length) hooks[event] = left
  }
  for (const o of writing) {
    if (!o.hook) continue
    const list = Array.isArray(hooks[o.hook.event]) ? (hooks[o.hook.event] as Json[]) : []
    hooks[o.hook.event] = [...list, o.hook.group]
  }
  hooksFile.hooks = hooks
  if (Object.keys(hooks).length || Object.keys(hooksFile).length > 1) own.set('hooks/hooks.json', utf8(jsonText(hooksFile)))

  // .mcp.json
  const servers: JsonObj = { ...serversOf(view.mcp) }
  for (const r of oldGone) if (r.mcp !== undefined) delete servers[r.mcp]
  for (const o of writing) if (o.mcp) servers[o.mcp.name] = o.mcp.config
  if (Object.keys(servers).length) own.set('.mcp.json', utf8(jsonText({ mcpServers: servers })))

  // .claude-plugin/plugin.json
  const manifestJson: JsonObj = isObj(view.pluginJson) ? { ...view.pluginJson } : {}
  const userConfig: JsonObj = { ...userConfigOf(view.pluginJson) }
  for (const r of oldGone) for (const k of r.userConfig ?? []) delete userConfig[k]
  for (const o of writing) Object.assign(userConfig, o.userConfig ?? {})
  manifestJson.name = setup.plugin
  if (typeof manifestJson.description !== 'string' || !manifestJson.description) manifestJson.description = describe(setup.owner)
  if (manifestJson.author === undefined) manifestJson.author = { name: setup.owner }
  if (Object.keys(userConfig).length) manifestJson.userConfig = userConfig
  else delete manifestJson.userConfig
  own.set('.claude-plugin/plugin.json', utf8(jsonText(manifestJson)))

  // .claudock.json
  const recs: ManifestItem[] = [
    ...writing.map(
      (o): ManifestItem => ({
        id: o.id,
        kind: o.kind,
        name: o.name,
        sha: o.sha,
        files: o.files.map((f) => f.rel).sort(),
        ...(o.hook ? { hook: { event: o.hook.event, key: o.hook.key } } : {}),
        ...(o.mcp ? { mcp: o.mcp.name } : {}),
        ...(o.userConfig ? { userConfig: Object.keys(o.userConfig).sort() } : {})
      })
    ),
    ...oldKept
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const keptFiles = new Set(oldKept.flatMap((r) => r.files))
  const files: Record<string, string> = {}
  for (const rel of [...own.keys()].sort()) files[rel] = sha256(own.get(rel) as Uint8Array)
  for (const rel of [...keptFiles].sort()) if (!(rel in files) && old?.files[rel]) files[rel] = old.files[rel]
  const manifest: Manifest = { claudock: 1, plugin: setup.plugin, items: recs, files }
  own.set(MANIFEST_NAME, utf8(jsonText(manifest)))

  const writes = new Map<string, Uint8Array>()
  for (const [rel, data] of own) writes.set(`${root}/${rel}`, data)

  // the root's marketplace.json: this plugin's entry, the rest untouched
  const market: JsonObj = isObj(view.marketplace) ? { ...view.marketplace } : {}
  market.name = setup.marketplace
  market.owner = { ...(isObj(market.owner) ? market.owner : {}), name: isObj(market.owner) && typeof market.owner.name === 'string' && market.owner.name ? market.owner.name : setup.owner }
  if (typeof market.description !== 'string' || !market.description) market.description = describe(setup.owner)
  const entry: JsonObj = { name: setup.plugin, source: `./${root}`, description: str(manifestJson.description) }
  const plugins = Array.isArray(market.plugins) ? market.plugins : []
  const at = plugins.findIndex((p) => isObj(p) && p.name === setup.plugin)
  market.plugins = at < 0 ? [...plugins, entry] : plugins.map((p, i) => (i === at && isObj(p) ? { ...p, ...entry } : p))
  writes.set('.claude-plugin/marketplace.json', utf8(jsonText(market)))
  if (!view.readme) writes.set('README.md', utf8(readme(setup, remote)))

  // what Claudock wrote before and no longer does
  const removes: string[] = []
  for (const rel of Object.keys(old?.files ?? {})) if (!own.has(rel) && !keptFiles.has(rel)) removes.push(`${root}/${rel}`)
  return { writes, removes: removes.sort(), manifest }
}

/** A hash of a plan: `write` runs only the plan that was shown. */
export function planToken(plan: Plan): string {
  const parts = [...plan.writes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([rel, data]) => [rel, sha256(data)])
  return sha256(canonical({ writes: parts, removes: plan.removes }))
}

/* ------------------------------------------------------------------ the repo's address */

/** The `origin` remote of a `.git/config`, with any login taken out of the URL; null when there is none. */
export function parseRemote(gitConfig: string): TeamRemote | null {
  let inOrigin = false
  let url = ''
  for (const raw of gitConfig.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) inOrigin = /^\[remote\s+"origin"\]$/.test(line)
    else if (inOrigin) {
      const m = /^url\s*=\s*(.+)$/.exec(line)
      if (m && !url) url = m[1].trim()
    }
  }
  if (!url) return null
  const clean = url.replace(/^(https?:\/\/)[^/@]+@/, '$1')
  const gh = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(clean)
  return gh ? { kind: 'github', text: `${gh[1]}/${gh[2]}` } : { kind: 'git', text: clean }
}

/** The marketplace source Claude Code's settings take for the remote. */
export const remoteSource = (remote: TeamRemote): JsonObj => (remote.kind === 'github' ? { source: 'github', repo: remote.text } : { source: 'git', url: remote.text })

/* ------------------------------------------------------------------ a connected project */

export interface PointerResult {
  text: string
  /** The file is not a JSON object, so nothing can be changed in it. */
  problem?: string
}

function parseSettings(existing: string | null): JsonObj | null {
  if (existing === null || !existing.trim()) return {}
  try {
    const v: unknown = JSON.parse(existing)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** The project's `.claude/settings.json` with the two keys that point at the team's marketplace; every other key stays. */
export function pointerText(existing: string | null, setup: PlanSetup, remote: TeamRemote): PointerResult {
  const s = parseSettings(existing)
  if (!s) return { text: existing ?? '', problem: 'Its settings.json is not a JSON object.' }
  const markets = isObj(s.extraKnownMarketplaces) ? s.extraKnownMarketplaces : {}
  const enabled = isObj(s.enabledPlugins) ? s.enabledPlugins : {}
  const next: JsonObj = {
    ...s,
    extraKnownMarketplaces: { ...markets, [setup.marketplace]: { source: remoteSource(remote), autoUpdate: true } },
    enabledPlugins: { ...enabled, [`${setup.plugin}@${setup.marketplace}`]: true }
  }
  return { text: jsonText(next) }
}

/** The same file without the two keys; a container Claudock leaves empty goes too. */
export function unpointerText(existing: string | null, setup: PlanSetup): PointerResult {
  const s = parseSettings(existing)
  if (!s) return { text: existing ?? '', problem: 'Its settings.json is not a JSON object.' }
  const next: JsonObj = { ...s }
  for (const [container, key] of [
    ['extraKnownMarketplaces', setup.marketplace],
    ['enabledPlugins', `${setup.plugin}@${setup.marketplace}`]
  ] as const) {
    const c = next[container]
    if (!isObj(c) || !(key in c)) continue
    const rest = { ...c }
    delete rest[key]
    if (Object.keys(rest).length) next[container] = rest
    else delete next[container]
  }
  return { text: jsonText(next) }
}

/** The project's settings already point at this plugin. */
export function isPointed(existing: string | null, setup: PlanSetup): boolean {
  const s = parseSettings(existing)
  return !!s && isObj(s.extraKnownMarketplaces) && setup.marketplace in s.extraKnownMarketplaces && isObj(s.enabledPlugins) && s.enabledPlugins[`${setup.plugin}@${setup.marketplace}`] === true
}

/* ------------------------------------------------------------------ commands to copy */

export function joinCommands(setup: PlanSetup, remote: TeamRemote, asks: boolean): JoinCommands {
  const key = `${setup.plugin}@${setup.marketplace}`
  return {
    user: `claude plugin marketplace add ${remote.text} && claude plugin install ${key}`,
    project: `claude plugin install ${key} --scope project`,
    configure: asks ? `/plugin configure ${key}` : null
  }
}

export interface Counts {
  added: number
  changed: number
  removed: number
}

/** `Team setup: 2 added, 1 changed`. */
export function commitMessage(c: Counts): string {
  const parts = [c.added ? `${c.added} added` : '', c.changed ? `${c.changed} changed` : '', c.removed ? `${c.removed} removed` : ''].filter(Boolean)
  return parts.length ? `Team setup: ${parts.join(', ')}` : 'Team setup'
}

/** The line that sends a write to the team: only Claudock's own paths are added. */
export function sendCommand(setup: PlanSetup, c: Counts, withReadme: boolean): string {
  const paths = ['.claude-plugin', pluginDir(setup.plugin), ...(withReadme ? ['README.md'] : [])].join(' ')
  return `git add -A ${paths} && git commit -m "${commitMessage(c)}" && git push`
}
