/**
 * Builds `SettingsDocs` from Anthropic's pages: the settings reference (Markdown), the env-vars page (Markdown) and
 * the published JSON schema. Pure functions, no Node / Electron / DOM APIs, so the main process and
 * scripts/make-settings-docs.mjs run the same code.
 *
 * Node runs this file directly through its TypeScript type stripping (scripts/make-settings-docs.mjs), so it only uses
 * erasable syntax (no enums, namespaces or parameter properties) and only `import type`.
 *
 * Merge rules: the docs are primary (summary, type text, default, scope, URL, value order); the schema supplies the
 * nested structure and fills kinds and values the docs only describe in prose. Kinds are unioned from both so the
 * editor never warns about a type one of them accepts. `closedValues` is set only when the list is clearly complete.
 * The schema lags the docs, so every constraint only it backs is listed in `schemaOnly` and never produces a warning.
 */
import type { DocNode, DocValue, JsonKind, SettingsDocs } from './settingsDocs'

export interface SettingsDocsInput {
  /** settings-reference.md */
  reference: string
  /** env-vars.md */
  envVars: string
  /** The parsed claude-code-settings.json schema. */
  schema: unknown
  /** `SETTINGS_DOCS_PAGE`: links in the result are `<docsPage>#<anchor>`. */
  docsPage: string
  /** `SETTINGS_DOCS_FORMAT`, stored in the result (passed in because this file may only `import type`). */
  format: number
  /** ISO time stored in the result. */
  builtAt: string
  /** URLs the three inputs came from. */
  sources: string[]
}

export type BuiltSettingsDocs = Omit<SettingsDocs, 'origin' | 'fetchError'>

/* ------------------------------------------------------------------ working nodes */

type State = 'exhaustive' | 'open'

/** A DocNode under construction, plus the bookkeeping that decides `closedValues` (removed by `finish`). */
interface Work {
  summary?: string
  typeText?: string
  default?: string
  scope?: string
  topic?: string
  url?: string
  kinds?: JsonKind[]
  values?: DocValue[]
  properties?: Record<string, Work>
  closed?: boolean
  additional?: Work
  items?: Work
  keySource?: 'env'
  valueSource?: 'permissionRule'
  example?: string
  removed?: string
  /** The docs type line gave `kinds` for this exact node. */
  _dk?: boolean
  /** The docs have dotted entries (`permissions.allow`) under this object, so they stand behind its `closed`. */
  _dc?: boolean
  /** Docs verdict on the value list: complete, or has other forms (patterns, "such as ..."). */
  _d?: State
  /** Schema verdict: an enum with no free-form string branch, or a free-form string branch. */
  _s?: State
  /** The schema itself listed values here. */
  _sv?: boolean
  /** The docs type text hints at accepted values beyond the list. */
  _veto?: boolean
  /** Sub-key names the docs "object with `a`, `b`" type line mentions. */
  _fields?: string[]
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const SCALARS = ['summary', 'typeText', 'default', 'scope', 'topic', 'url', 'example', 'removed'] as const

function unionKinds(a?: JsonKind[], b?: JsonKind[]): JsonKind[] | undefined {
  if (!a && !b) return undefined
  return [...new Set([...(a ?? []), ...(b ?? [])])]
}

function unionValues(a?: DocValue[], b?: DocValue[]): DocValue[] | undefined {
  if (!a && !b) return undefined
  const out: DocValue[] = []
  for (const v of [...(a ?? []), ...(b ?? [])]) {
    const same = out.find((o) => o.value === v.value)
    if (!same) out.push({ ...v })
    else if (!same.summary && v.summary) same.summary = v.summary
  }
  return out
}

function strongest(a?: State, b?: State): State | undefined {
  return a === 'open' || b === 'open' ? 'open' : (a ?? b)
}

/**
 * Merge two nodes. 'union' combines two alternatives (anyOf branches): an object is closed only when every object branch
 * is. 'overlay' puts docs (a) over schema (b): a's text wins, structure and flags combine.
 */
function merge(a: Work, b: Work, mode: 'union' | 'overlay'): Work {
  const out: Work = {}
  for (const k of SCALARS) {
    const v = a[k] ?? b[k]
    if (v !== undefined) out[k] = v
  }
  const kinds = unionKinds(a.kinds, b.kinds)
  if (kinds) out.kinds = kinds
  const values = unionValues(a.values, b.values)
  if (values) out.values = values
  if (a.properties || b.properties) {
    out.properties = {}
    for (const k of new Set([...Object.keys(a.properties ?? {}), ...Object.keys(b.properties ?? {})])) {
      const x = a.properties?.[k]
      const y = b.properties?.[k]
      out.properties[k] = x && y ? merge(x, y, mode) : (x ?? y)!
    }
  }
  if (mode === 'overlay') {
    const c = a.closed ?? b.closed
    if (c !== undefined) out.closed = c
  } else {
    const aObj = a.kinds?.includes('object')
    const bObj = b.kinds?.includes('object')
    const c = aObj && bObj ? a.closed === true && b.closed === true : aObj ? a.closed : bObj ? b.closed : (a.closed ?? b.closed)
    if (c !== undefined) out.closed = c
  }
  const additional = a.additional && b.additional ? merge(a.additional, b.additional, mode) : (a.additional ?? b.additional)
  if (additional) out.additional = additional
  const items = a.items && b.items ? merge(a.items, b.items, mode) : (a.items ?? b.items)
  if (items) out.items = items
  const keySource = a.keySource ?? b.keySource
  if (keySource) out.keySource = keySource
  const valueSource = a.valueSource ?? b.valueSource
  if (valueSource) out.valueSource = valueSource
  const d = strongest(a._d, b._d)
  if (d) out._d = d
  const s = strongest(a._s, b._s)
  if (s) out._s = s
  if (a._sv || b._sv) out._sv = true
  if (a._dk || b._dk) out._dk = true
  if (a._dc || b._dc) out._dc = true
  if (a._veto || b._veto) out._veto = true
  if (a._fields || b._fields) out._fields = [...new Set([...(a._fields ?? []), ...(b._fields ?? [])])]
  return out
}

/* ------------------------------------------------------------------ text helpers */

/** Markdown to plain text: links to their text, no backticks, bold, or inline HTML tags. */
function plain(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<\/?(?:br|b|i|em|strong|code|a|span|sup|sub)\b[^>]*>/gi, ' ')
    .replace(/`+/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\\([|`*_[\]])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([).,;:])/g, '$1')
    .trim()
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

/** First sentence of a description (plain text, no trailing period), or undefined when there is none. */
function firstSentence(s: unknown, max = 220): string | undefined {
  if (typeof s !== 'string') return undefined
  const line = s
    .replace(/^\s*UNDOCUMENTED\.?\s*/i, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  if (!line) return undefined
  const first = plain(line).split(/(?<=[.!?])\s+(?=[A-Z("])/)[0].replace(/\.$/, '')
  return first ? clip(first, max) : undefined
}

/** A backticked JSON literal (`"low"`, `5`, `true`) to its value; undefined when it is not one. */
function literal(src: string): DocValue['value'] | undefined {
  const t = src.trim()
  if (!/^(?:"[^"\\]*"|-?\d+(?:\.\d+)?|true|false|null)$/.test(t)) return undefined
  try {
    return JSON.parse(t) as DocValue['value']
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------ JSON schema to Work */

interface SchemaCtx {
  defs: Obj
}

function schemaKinds(type: unknown): JsonKind[] {
  const list = Array.isArray(type) ? type : [type]
  const out = new Set<JsonKind>()
  for (const t of list) {
    if (t === 'integer' || t === 'number') out.add('number')
    else if (t === 'string' || t === 'boolean' || t === 'array' || t === 'object' || t === 'null') out.add(t)
  }
  return [...out]
}

function convertSchema(n: unknown, ctx: SchemaCtx, depth: number): Work {
  if (!isObj(n) || depth > 14) return {}
  let out: Work = {}

  if (typeof n.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(n.$ref)
    const target = m ? ctx.defs[m[1]] : undefined
    if (target) out = convertSchema(target, ctx, depth + 1)
    if (m?.[1] === 'permissionRule') out.valueSource = 'permissionRule'
  }

  const summary = firstSentence(n.description)
  if (summary) out.summary = summary

  const kinds = n.type !== undefined ? schemaKinds(n.type) : []
  if (kinds.length) out.kinds = unionKinds(out.kinds, kinds)

  const listed: unknown[] = Array.isArray(n.enum) ? n.enum : n.const !== undefined ? [n.const] : []
  const values: DocValue[] = []
  for (const v of listed) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) values.push({ value: v })
  if (values.length) {
    out.values = unionValues(out.values, values)
    out._sv = true
    if (kinds.includes('string') || typeof listed[0] === 'string') out._s = strongest(out._s, 'exhaustive')
  } else if (kinds.includes('string') && !n.$ref) {
    out._s = 'open'
  }

  if (isObj(n.properties)) {
    out.properties = { ...out.properties }
    for (const [k, v] of Object.entries(n.properties)) out.properties[k] = convertSchema(v, ctx, depth + 1)
  }
  if (n.additionalProperties === false) out.closed = true
  else if (isObj(n.additionalProperties)) out.additional = convertSchema(n.additionalProperties, ctx, depth + 1)
  if (isObj(n.items)) out.items = convertSchema(n.items, ctx, depth + 1)

  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = n[key]
    if (!Array.isArray(branches)) continue
    let acc: Work | undefined
    for (const b of branches) {
      if (isObj(b) && isObj(b.not)) continue
      const w = convertSchema(b, ctx, depth + 1)
      acc = acc ? merge(acc, w, 'union') : w
    }
    if (acc) out = merge(out, acc, 'union')
  }
  return out
}

/** Names of the tools in `$defs.permissionRule.pattern` (`^((Agent|Bash|...)(\(...\))?|mcp__.*)$`). */
function schemaTools(schema: Obj): string[] {
  const defs = isObj(schema.$defs) ? schema.$defs : {}
  const rule = isObj(defs.permissionRule) ? defs.permissionRule : {}
  const m = typeof rule.pattern === 'string' ? /^\^\(\(([A-Za-z0-9_|]+)\)/.exec(rule.pattern) : null
  return m ? [...new Set(m[1].split('|').filter(Boolean))].sort((a, b) => a.localeCompare(b)) : []
}

/* ------------------------------------------------------------------ docs: settings index and sections */

interface IndexRow {
  key: string
  anchor: string
  summary: string
  topic: string
  scope: string
}

function parseIndex(lines: string[]): IndexRow[] {
  const start = lines.findIndex((l) => /^##\s+Settings index\s*$/.test(l))
  if (start < 0) throw new Error('The settings index was not found in the reference page')
  const rows: IndexRow[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (/^##\s/.test(l)) break
    const m = /^\|\s*\[`([^`]+)`\]\(#([^)]+)\)\s*\|(.*)\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/.exec(l)
    if (m) rows.push({ key: m[1], anchor: m[2], summary: clip(plain(m[3]), 300), topic: plain(m[4]), scope: plain(m[5]) })
  }
  return rows
}

interface Bullet {
  text: string
  children: string[]
}

interface Section {
  key: string
  scope?: Bullet
  type?: Bullet
  default?: Bullet
  example?: string
}

function parseSections(lines: string[]): Map<string, Section> {
  const out = new Map<string, Section>()
  let cur: Section | undefined
  let fence = false
  let fenceInfo = ''
  let fenceBody: string[] = []
  let last: Bullet | undefined
  for (const l of lines) {
    const h = /^###\s+`([^`]+)`\s*$/.exec(l)
    if (!fence && (h || /^##\s/.test(l) || /^###\s/.test(l))) {
      cur = h ? { key: h[1] } : undefined
      if (cur && !out.has(cur.key)) out.set(cur.key, cur)
      last = undefined
      continue
    }
    if (!cur) continue
    const f = /^```(.*)$/.exec(l)
    if (f) {
      if (!fence) {
        fence = true
        fenceInfo = f[1].trim()
        fenceBody = []
      } else {
        fence = false
        if (cur.example === undefined && /^json\b/.test(fenceInfo)) cur.example = fenceBody.join('\n').trim()
      }
      last = undefined
      continue
    }
    if (fence) {
      fenceBody.push(l)
      continue
    }
    const b = /^\* \*\*(Scope|Type|Default)\*\*:\s*(.*)$/.exec(l)
    if (b) {
      const name = b[1].toLowerCase() as 'scope' | 'type' | 'default'
      last = cur[name] ? undefined : (cur[name] = { text: b[2], children: [] })
      continue
    }
    const c = /^ {2}[*-]\s+(.*)$/.exec(l)
    if (c && last) last.children.push(c[1])
    else if (!/^\s{2,}\S/.test(l)) last = undefined
  }
  return out
}

/** Words in a type line that mean the listed values are not the only accepted ones. */
const OPEN_HINT = /\b(?:such as|e\.g\.|for example|custom|any|IDs?|paths?|commands?|URLs?|patterns?|or an?|aliases|also accepts?|either case|otherwise|names?)\b/i

interface TypeInfo {
  typeText: string
  kinds: JsonKind[]
  values?: DocValue[]
  state?: State
  veto: boolean
  itemsKinds?: JsonKind[]
  itemsValues?: DocValue[]
  itemsState?: State
  additionalValues?: DocValue[]
  additionalState?: State
  childName?: string
  fields?: Array<[string, string]>
  fieldsOnAdditional?: boolean
  fieldNames?: string[]
  /** Values the type line gives to a sub-key: `a `mode` of "deny" or "mask"`. */
  childLiterals?: Record<string, DocValue[]>
  permissionRules?: boolean
  itemOf?: string
}

/** A value bullet: backticked literal(s), a colon, then what it does. Returns undefined for anything else. */
function parseValueBullet(text: string): { values: DocValue['value'][]; summary?: string; pattern: boolean } | undefined {
  const m = /^((?:`[^`]*`(?:\s*(?:,|or)\s*)?)+)\s*:\s*(.*)$/.exec(text)
  if (!m) return undefined
  const parts = [...m[1].matchAll(/`([^`]*)`/g)].map((x) => x[1])
  const values: DocValue['value'][] = []
  let pattern = false
  for (const p of parts) {
    const v = literal(p)
    if (v === undefined || (typeof v === 'string' && /[<>]/.test(v))) pattern = true
    else values.push(v)
  }
  return { values, summary: firstSentence(m[2], 200), pattern }
}

function bulletValues(children: string[]): { values: DocValue[]; state: State } {
  const values: DocValue[] = []
  let state: State = 'exhaustive'
  for (const c of children) {
    const b = parseValueBullet(c)
    if (!b) {
      state = 'open'
      continue
    }
    if (b.pattern) state = 'open'
    for (const v of b.values) values.push(b.summary ? { value: v, summary: b.summary } : { value: v })
  }
  return { values, state }
}

/** `string, one of "a", "b" or "c"` / `"a" or "b"`: the literals when the clause is nothing but a value list. */
function inlineValues(rest: string): { values: DocValue[]; state: State } | undefined {
  const oneOf = /^one of\s+/.exec(rest)
  if (!oneOf && !rest.startsWith('`')) return undefined
  const clause = rest.replace(/^one of\s+/, '').split(/,\s*which\b|;|\.(?:\s|$)/)[0]
  const found = [...clause.matchAll(/`([^`]*)`/g)].map((m) => literal(m[1]))
  if (!found.length || found.some((v) => v === undefined)) return undefined
  const residue = clause.replace(/`[^`]*`/g, '').replace(/\b(?:the aliases|or|and)\b|[,\s]/g, '')
  return { values: found.map((value) => ({ value: value! })), state: residue === '' ? 'exhaustive' : 'open' }
}

function kindsOfWord(w: string): JsonKind[] {
  if (/\bobjects?\b/.test(w)) return ['object']
  if (/\b(?:strings?|aliases|IDs?|names?|paths?|patterns?|rules?|domains?|commands?|hostnames?|URLs?)\b/.test(w)) return ['string']
  return []
}

/** The kinds named in the first clause of "...can instead be a `"x@y"` string such as ..., which ..." (backticked text skipped). */
function altKinds(tail: string): JsonKind[] {
  const clause = tail.replace(/`[^`]*`/g, ' ').split(/[,;.]|\bsuch as\b|\bwhich\b/)[0]
  const out: JsonKind[] = []
  if (/\bstrings?\b/i.test(clause)) out.push('string')
  if (/\bobjects?\b/i.test(clause)) out.push('object')
  if (/\b(?:numbers?|integers?)\b/i.test(clause)) out.push('number')
  if (/\b(?:booleans?|true or false)\b/i.test(clause)) out.push('boolean')
  if (/\barrays?\b/i.test(clause)) out.push('array')
  return out
}

function parseType(bullet: Bullet): TypeInfo {
  const raw = bullet.text.trim()
  const head = plain(raw)
  const info: TypeInfo = { typeText: head, kinds: [], veto: OPEN_HINT.test(head) }
  const kinds = new Set<JsonKind>()

  if (/^`true` to\b/.test(raw)) kinds.add('boolean')
  else if (/^boolean\b/i.test(raw)) kinds.add('boolean')
  else if (/^(?:string|the string)\b/i.test(raw)) kinds.add('string')
  else if (/^(?:number|integer)\b/i.test(raw)) kinds.add('number')
  else if (/^array\b/i.test(raw)) kinds.add('array')
  else if (/^object\b/i.test(raw)) kinds.add('object')
  if (/\bor `null`/.test(raw)) kinds.add('null')
  if (/\bor `false`/.test(raw)) kinds.add('boolean')
  if (/\bor (?:an? )?array\b/.test(raw)) kinds.add('array')
  info.kinds = [...kinds]

  const colonList = /:\s*$/.test(raw)
  const stripped = raw.replace(/:\s*$/, '')

  if (kinds.has('string') && /^string,\s*/i.test(stripped)) {
    const rest = stripped.replace(/^string,\s*/i, '')
    if (colonList && /^one of$/.test(rest)) {
      const b = bulletValues(bullet.children)
      if (b.values.length) {
        info.values = b.values
        info.state = b.state
        info.typeText = `string, one of ${listText(b.values)}`
        info.veto = false
      }
    } else {
      const inl = inlineValues(rest)
      if (inl) {
        info.values = inl.values
        info.state = inl.state
      }
    }
  } else if (/^the string\s+`/i.test(stripped)) {
    const only = /^the string\s+`([^`]*)`(.*)$/i.exec(stripped)
    const v = only ? literal(only[1]) : undefined
    const inArray = only ? /^\s+in the (?:\[)?`(\w+)`/.exec(only[2]) : null
    if (v !== undefined && inArray) info.itemOf = inArray[1]
    if (v !== undefined) info.values = [{ value: v }]
  } else if (kinds.has('boolean') && !colonList && bullet.children.length) {
    const b = bulletValues(bullet.children)
    if (b.values.length) info.values = b.values
  }

  if (/^array\b/i.test(stripped)) {
    const m = /^array of\s+(.*)$/i.exec(stripped)
    if (m) {
      // "strings", "objects or strings", plus "An entry can instead be a `"a@b"` string" later in the line
      const ik = new Set<JsonKind>(m[1].split(/[,;:]/)[0].split(/\bor\b/).flatMap(kindsOfWord))
      const alt = /\b(?:entry|item|element)s?\s+(?:can|may)\s+instead\s+be\b(.*)$/i.exec(stripped)
      if (alt) for (const k of altKinds(alt[1])) ik.add(k)
      if (ik.size) info.itemsKinds = [...ik]
      if (/permission rule/i.test(m[1])) info.permissionRules = true
      if (/each one of$/i.test(stripped.replace(/\s+$/, '')) || /,\s*each one of$/i.test(stripped)) {
        const b = bulletValues(bullet.children)
        if (b.values.length) {
          info.itemsValues = b.values
          info.itemsState = b.state
        }
      }
    }
  }

  const lits: Record<string, DocValue[]> = {}
  const withFields = /^(?:object with|array of objects, each with)\b/i.test(stripped)
  for (const m of withFields ? stripped.matchAll(/`(\w+)`,?\s+(?:(?:always|of|set to|is|as|one of)\s+)*((?:`"[^`]*"`(?:\s*(?:,|or|and)\s*)*)+)/g) : []) {
    const found = [...m[2].matchAll(/`("[^`]*")`/g)].map((x) => literal(x[1]))
    if (found.every((v) => v !== undefined)) lits[m[1]] = found.map((value) => ({ value: value! }))
  }
  if (Object.keys(lits).length) info.childLiterals = lits

  if (/^object mapping\b/i.test(stripped)) {
    if (/\bto one of$/i.test(stripped)) {
      const b = bulletValues(bullet.children)
      if (b.values.length) {
        info.additionalValues = b.values
        info.additionalState = b.state
      }
    } else if (/\bfields$/i.test(stripped) && bullet.children.length) {
      info.fields = fieldBullets(bullet.children)
      info.fieldsOnAdditional = true
    }
  } else if (/^object with\b/i.test(stripped)) {
    const child = /`(\w+)`,? one of$/.exec(stripped)
    if (child && colonList) {
      const b = bulletValues(bullet.children)
      if (b.values.length) {
        info.childName = child[1]
        info.additionalValues = b.values
        info.additionalState = b.state
      }
    }
    if (colonList && /fields$/i.test(stripped) && bullet.children.length) info.fields = fieldBullets(bullet.children)
    const names = [...stripped.matchAll(/`([A-Za-z_]\w*)`/g)].map((m) => m[1]).filter((n) => n !== 'true' && n !== 'false' && n !== 'null')
    if (names.length) info.fieldNames = [...new Set(names)]
  }
  return info
}

function fieldBullets(children: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const c of children) {
    const m = /^\[?`(\w+)`\]?(?:\([^)]*\))?\s*:\s*(.*)$/.exec(c)
    if (m) out.push([m[1], clip(plain(m[2]), 300)])
  }
  return out
}

function listText(values: DocValue[]): string {
  const q = values.map((v) => JSON.stringify(v.value))
  return q.length < 2 ? q.join('') : `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`
}

/** The docs entry for one key as a Work node. */
function docsNode(row: IndexRow | undefined, sec: Section | undefined, docsPage: string, key: string): { node: Work; info?: TypeInfo } {
  const node: Work = {}
  if (row?.summary) node.summary = row.summary
  if (row?.topic) node.topic = row.topic
  const scope = row?.scope || (sec?.scope ? plain(sec.scope.text).split(/\.\s/)[0].replace(/\.$/, '') : '')
  if (scope) node.scope = scope
  const anchor = row?.anchor ?? key.toLowerCase().replace(/\./g, '-')
  node.url = `${docsPage}#${anchor}`
  const gone = row ? /^Removed in v?(\d+(?:\.\d+)+)/i.exec(row.summary) : null
  if (gone) node.removed = `v${gone[1]}`
  if (sec?.default) node.default = clip(plain(sec.default.text), 500)
  if (sec?.example) node.example = sec.example
  let info: TypeInfo | undefined
  if (sec?.type) {
    info = parseType(sec.type)
    node.typeText = clip(info.typeText, 700)
    if (info.kinds.length) {
      node.kinds = info.kinds
      node._dk = true
    }
    if (info.values) {
      node.values = info.values
      if (info.state) node._d = info.state
    }
    if (info.veto) node._veto = true
    const items: Work = {}
    if (info.itemsKinds) {
      items.kinds = info.itemsKinds
      items._dk = true
    }
    if (info.itemsValues) {
      items.values = info.itemsValues
      if (info.itemsState) items._d = info.itemsState
    }
    if (info.permissionRules) items.valueSource = 'permissionRule'
    if (Object.keys(items).length) {
      node.items = items
      node.kinds = unionKinds(node.kinds, ['array'])
      node._dk = true
    }
    if (info.additionalValues || (info.fields && info.fieldsOnAdditional)) {
      const add: Work = {}
      if (info.additionalValues) {
        add.values = info.additionalValues
        if (info.additionalState) add._d = info.additionalState
      }
      if (info.fields && info.fieldsOnAdditional) {
        add.kinds = ['object']
        add._dk = true
        add.properties = Object.fromEntries(info.fields.map(([n, s]) => [n, { summary: s }]))
      }
      if (info.childName) node.properties = { [info.childName]: add }
      else node.additional = add
    }
    if (info.fields && !info.fieldsOnAdditional) node.properties = Object.fromEntries(info.fields.map(([n, s]) => [n, { summary: s }]))
    if (info.fieldNames) node._fields = info.fieldNames
    if (info.childLiterals) {
      const host = info.itemsKinds?.includes('object') ? (node.items ??= {}) : node
      host.properties ??= {}
      for (const [name, values] of Object.entries(info.childLiterals)) host.properties[name] = { ...host.properties[name], values }
    }
  }
  return { node, info }
}

/* ------------------------------------------------------------------ docs: env vars */

function parseEnv(text: string): Array<{ name: string; summary: string }> {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^##\s+Variables\s*$/.test(l))
  if (start < 0) throw new Error('The Variables table was not found in the env-vars page')
  const out: Array<{ name: string; summary: string }> = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    const m = /^\|\s*`([A-Za-z0-9_]+)`\s*\|(.*)\|\s*$/.exec(lines[i])
    if (m) out.push({ name: m[1], summary: firstSentence(m[2], 260) ?? '' })
  }
  return out
}

/* ------------------------------------------------------------------ assemble */

function ensure(parent: Work, name: string): Work {
  parent.properties ??= {}
  return (parent.properties[name] ??= { kinds: ['object'] })
}

function finish(w: Work, isRoot = false): DocNode {
  const out: DocNode = {}
  const schemaOnly: Array<'kinds' | 'closed' | 'closedValues'> = []
  for (const k of SCALARS) if (w[k] !== undefined) out[k] = w[k]
  if (w.kinds?.length) {
    out.kinds = w.kinds
    if (!w._dk) schemaOnly.push('kinds')
  }
  if (w.values?.length) {
    out.values = w.values
    let closed = false
    let bySchema = false
    const noBool = !w.kinds?.includes('boolean')
    if (noBool && !w._veto) {
      if (w._d === 'open') closed = false
      else if (w._s === 'open' && w._sv) closed = false
      else if (w._d === 'exhaustive') closed = true
      else if (w._d === undefined && w._s === 'exhaustive') {
        closed = true
        bySchema = true
      }
    }
    if (closed) {
      out.closedValues = true
      if (bySchema) schemaOnly.push('closedValues')
    }
  }
  if (w.properties || (w.closed && w._fields)) {
    const props: Record<string, DocNode> = {}
    for (const [k, v] of Object.entries(w.properties ?? {})) props[k] = finish(v)
    if (w.closed) for (const n of w._fields ?? []) props[n] ??= {}
    if (Object.keys(props).length) out.properties = props
  }
  if (w.closed) {
    out.closed = true
    // the root's unknown keys are judged against the docs index; a nested object is only trusted when the docs list its keys
    if (!isRoot && !w._dc) schemaOnly.push('closed')
  }
  if (w.additional) out.additional = finish(w.additional)
  if (w.items) out.items = finish(w.items)
  if (w.keySource) out.keySource = w.keySource
  if (w.valueSource) out.valueSource = w.valueSource
  if (schemaOnly.length) out.schemaOnly = (['kinds', 'closed', 'closedValues'] as const).filter((x) => schemaOnly.includes(x))
  return out
}

export function buildSettingsDocs(input: SettingsDocsInput): BuiltSettingsDocs {
  if (!isObj(input.schema)) throw new Error('The JSON schema is not an object')
  const schema = input.schema
  const ctx: SchemaCtx = { defs: isObj(schema.$defs) ? schema.$defs : {} }

  // 1. The schema gives the structure.
  const root = convertSchema(schema, ctx, 0)
  root.kinds = ['object']
  root._dk = true
  root.closed = true
  root.summary = 'Claude Code settings'
  root.properties ??= {}
  root.properties.$schema ??= { kinds: ['string'], summary: 'JSON schema URL, for editor support' }

  const schemaEnv = isObj(schema.properties) && isObj(schema.properties.env) && isObj(schema.properties.env.properties) ? schema.properties.env.properties : {}
  const env = root.properties.env
  if (env) {
    delete env.properties
    env.keySource = 'env'
  }

  // 2. The docs go over it.
  const lines = input.reference.split('\n')
  const index = parseIndex(lines)
  const sections = parseSections(lines)
  const keys = [...new Set([...index.map((r) => r.key), ...sections.keys()])]
  for (const key of keys) {
    const row = index.find((r) => r.key === key)
    const { node, info } = docsNode(row, sections.get(key), input.docsPage, key)
    const path = key.split('.')
    if (info?.itemOf && path.length > 1) {
      // `strictPluginOnlyCustomization.skills` is a value of the parent's array, not a sub-key.
      const parent = path.slice(0, -1).reduce((p, n) => ensure(p, n), root)
      const value = info.values?.[0]
      if (value) {
        parent.items ??= { kinds: ['string'] }
        parent.items.values = unionValues(parent.items.values, [row?.summary ? { value: value.value, summary: row.summary } : { value: value.value }])
        parent.kinds = unionKinds(parent.kinds, ['array'])
      }
      continue
    }
    const parent = path.slice(0, -1).reduce((p, n) => ensure(p, n), root)
    if (path.length > 1) parent._dc = true
    const name = path[path.length - 1]
    parent.properties ??= {}
    const existing = parent.properties[name]
    const merged = existing ? merge(node, existing, 'overlay') : node
    // Values only the schema lists (the docs gave a list of their own) get a note instead of a blank.
    for (const v of merged.values ?? []) if (node.values?.length && !node.values.some((d) => d.value === v.value)) v.summary ??= 'In the JSON schema, not described in the docs'
    parent.properties[name] = merged
  }

  // Sort the top-level keys; `$schema` stays first.
  const sorted: Record<string, Work> = {}
  for (const k of Object.keys(root.properties).sort((a, b) => (a === '$schema' ? -1 : b === '$schema' ? 1 : a.localeCompare(b, 'en')))) sorted[k] = root.properties[k]
  root.properties = sorted

  // 3. Environment variables and tools.
  const envVars = parseEnv(input.envVars)
  const known = new Set(envVars.map((v) => v.name))
  for (const [name, def] of Object.entries(schemaEnv)) {
    if (known.has(name)) continue
    envVars.push({ name, summary: (isObj(def) ? firstSentence(def.description, 260) : undefined) ?? '' })
  }
  envVars.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return {
    format: input.format,
    builtAt: input.builtAt,
    sources: input.sources,
    root: finish(root, true),
    env: envVars,
    tools: schemaTools(schema)
  }
}

/** A human-readable problem when the result looks broken (page layout changed, wrong page, empty body), else null. */
export function validateSettingsDocs(d: BuiltSettingsDocs | SettingsDocs): string | null {
  const props = d?.root?.properties
  if (!props || typeof props !== 'object') return 'The settings docs have no settings keys'
  const keys = Object.values(props)
  if (keys.length < 120) return `Only ${keys.length} settings keys were found (expected over 120)`
  if (!Array.isArray(d.env) || d.env.length < 200) return `Only ${Array.isArray(d.env) ? d.env.length : 0} environment variables were found (expected over 200)`
  if (!Array.isArray(d.tools) || d.tools.length < 10) return `Only ${Array.isArray(d.tools) ? d.tools.length : 0} tool names were found (expected over 10)`
  const linked = keys.filter((p) => p.url)
  const bare = linked.filter((p) => !p.typeText).length
  if (linked.length < 100) return `Only ${linked.length} documented keys were found (expected over 100)`
  if (bare > linked.length * 0.4) return `${bare} of ${linked.length} documented keys have no type line (the page layout may have changed)`
  return null
}
