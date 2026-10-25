/**
 * Help for the settings JSON editor, built from the Claude Code docs (`SettingsDocs`): a completion popup with a docs
 * card beside the selected item, the same card on hover, and warnings (unknown key, wrong value kind, value outside a
 * closed list, removed or misplaced key, repeated key). A warning needs a rule the docs themselves state: what only the JSON schema
 * says (`DocNode.schemaOnly`) can lag the docs, so it feeds suggestions but never warnings. Warnings never block Save. The context is read from the lezer JSON syntax tree, which
 * stays usable while a key or value is half typed.
 */
import { autocompletion, completionStatus, pickedCompletion, selectedCompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { linter, type Action, type Diagnostic } from '@codemirror/lint'
import type { EditorState, Extension } from '@codemirror/state'
import { hoverTooltip, keymap, type EditorView, type Tooltip } from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'
import { SETTINGS_DOCS_PAGE, SETTINGS_DOCS_SOURCES, type DocNode, type DocValue, type JsonKind, type SettingsDocs } from '@shared/settingsDocs'

/** One step of a key path: an object key, or `null` for "an item of this array". */
type Step = string | null

const has = (o: object | undefined, k: string): boolean => !!o && Object.prototype.hasOwnProperty.call(o, k)
const ENV_PAGE = SETTINGS_DOCS_SOURCES.envVars.replace(/\.md$/, '')
/** Docs links are only followed when they stay on the docs site: `https://code.claude.com/docs/`. */
const DOCS_BASE = new URL('/docs/', SETTINGS_DOCS_PAGE).href

/** The URL when it is a page of the Claude Code docs, else undefined. */
export function safeDocsUrl(url: string | undefined): string | undefined {
  if (!url || !url.startsWith(DOCS_BASE)) return undefined
  try {
    new URL(url)
    return url
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------------------------------ docs lookups */

/** The doc node at `path`, or undefined where the docs say nothing. */
function resolve(root: DocNode, path: Step[]): DocNode | undefined {
  let n: DocNode | undefined = root
  for (const s of path) {
    if (!n) return undefined
    n = s === null ? n.items : has(n.properties, s) ? n.properties![s] : n.additional
  }
  return n
}

/** Env var summaries by name, built once per docs object. */
const envCache = new WeakMap<SettingsDocs, Map<string, string>>()
function envMap(docs: SettingsDocs): Map<string, string> {
  let m = envCache.get(docs)
  if (!m) {
    m = new Map(docs.env.map((e) => [e.name, e.summary]))
    envCache.set(docs, m)
  }
  return m
}

/** Kinds a node accepts: as documented, else guessed from its shape. */
function kindsOf(n: DocNode): JsonKind[] {
  if (n.kinds?.length) return n.kinds
  if (n.values?.length) {
    const v = n.values[0].value
    return [v === null ? 'null' : (typeof v as JsonKind)]
  }
  if (n.properties || n.additional || n.keySource) return ['object']
  if (n.items) return ['array']
  return []
}

/** Short label for the list row, e.g. `string` or `string | array`. */
function kindLabel(n: DocNode): string {
  return kindsOf(n).join(' | ')
}

/* ------------------------------------------------------------------------------------------ docs card */

/** What a docs card shows, as plain data. `cardDom` turns it into elements. */
export interface CardData {
  /** Key name or value, shown in the mono font. */
  title: string
  summary?: string
  rows: Array<[label: string, text: string]>
  url?: string
}

function keyCard(key: string, n: DocNode): CardData {
  const rows: CardData['rows'] = []
  if (n.removed) rows.push(['Removed', `in Claude Code ${n.removed}; it does nothing now`])
  const type = n.typeText ?? kindLabel(n).replace(/ \| /g, ' or ')
  if (type) rows.push(['Type', type])
  if (n.default) rows.push(['Default', n.default])
  if (n.scope) rows.push(['Files', n.scope])
  return { title: key, summary: n.summary, rows, url: n.url }
}

function envCard(name: string, summary: string): CardData {
  return { title: name, summary, rows: [['Type', 'string'], ['Files', 'The env block']], url: ENV_PAGE }
}

function valueCard(v: DocValue, parent: DocNode | undefined): CardData {
  return { title: JSON.stringify(v.value), summary: v.summary, rows: [], url: parent?.url }
}

/** The shortcuts of the open-docs command, as the footer names them. (No `window` in the test harness.) */
const DOCS_KEYS = typeof window !== 'undefined' && window.claudock?.platform === 'darwin' ? 'F1 or ⌘⇧D' : 'F1 or Ctrl+Shift+D'

/** Builds the card with createElement only; nothing from the docs goes through innerHTML. */
export function cardDom(card: CardData): HTMLElement {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag)
    e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }
  const root = el('div', 'cm-doc')
  root.appendChild(el('div', 'cm-doc-key', card.title))
  if (card.summary) root.appendChild(el('p', 'cm-doc-summary', card.summary))
  if (card.rows.length) {
    const dl = el('dl', 'cm-doc-meta')
    for (const [label, text] of card.rows) {
      dl.appendChild(el('dt', '', label))
      dl.appendChild(el('dd', '', text))
    }
    root.appendChild(dl)
  }
  const href = safeDocsUrl(card.url)
  if (href) {
    const a = el('a', 'cm-doc-link', 'Open in Claude Code docs ↗')
    a.href = href
    a.target = '_blank'
    a.rel = 'noreferrer'
    // keep the editor focused so the popup stays open until the click lands
    a.addEventListener('mousedown', (e) => e.preventDefault())
    root.appendChild(a)
    root.appendChild(el('p', 'cm-doc-hint', `${DOCS_KEYS} opens the docs`))
  }
  return root
}

/* ------------------------------------------------------------------------------------------ syntax tree */

const tree = (state: EditorState): Tree => ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)

/** The key of a Property node (the unescaped name text), '' when it has none. */
function keyOf(state: EditorState, prop: SyntaxNode): string {
  const name = prop.getChild('PropertyName')
  if (!name) return ''
  const raw = state.sliceDoc(name.from, name.to)
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.replace(/^"|"$/g, '')
  }
}

/** Key path of a node: the keys of the Properties it sits under, with `null` for array items. */
function pathOf(state: EditorState, node: SyntaxNode): Step[] {
  const path: Step[] = []
  for (let n: SyntaxNode = node; n.parent; n = n.parent) {
    const p: SyntaxNode = n.parent
    if (p.name === 'Property' && n.name !== 'PropertyName') path.push(keyOf(state, p))
    else if (p.name === 'Array') path.push(null)
  }
  return path.reverse()
}

/** Docs page of each completion row, for F1 while the popup is open. */
const completionUrls = new WeakMap<Completion, string>()

const closer = { Object: '}', Array: ']' } as const

/** The object or array whose brackets surround `pos`. */
function containerAt(from: SyntaxNode, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = from; n; n = n.parent) {
    if ((n.name === 'Object' || n.name === 'Array') && n.from < pos && (pos < n.to || n.lastChild?.name !== closer[n.name])) return n
  }
  return null
}

const LITERALS = new Set(['String', 'PropertyName', 'Number', 'True', 'False', 'Null'])
const isIncomplete = (n: SyntaxNode): boolean => n.type.isError

/* ------------------------------------------------------------------------------------------ cursor context */

interface Ctx {
  role: 'key' | 'value'
  /** Doc path of the object (key role) or of the value (value role). */
  path: Step[]
  container: SyntaxNode
  /** The token being replaced, quotes included; empty (pos, pos) when nothing is typed yet. */
  tokFrom: number
  tokTo: number
  /** Where the typed text starts (after an opening quote). */
  prefixFrom: number
  quoted: boolean
  /** Key role: a colon already follows, so only the name is replaced. */
  hasColon: boolean
  /** Key role: another property follows, so an inserted pair needs a comma. */
  nextProp: boolean
  /** Key role: the Property being edited, which does not count as "already present". */
  own: SyntaxNode | null
}

/**
 * Where the cursor is: a key or a value position, which object/array it is in, and the half-typed token under it.
 * Null where suggestions make no sense (after a value, in a number, in a comment, ...).
 */
export function contextAt(state: EditorState, pos: number): Ctx | null {
  const t = tree(state)
  const inner = t.resolveInner(pos, -1)

  // the token the cursor is in or at the end of
  let tok: SyntaxNode | null = null
  if (!inner.firstChild && inner.from < pos && pos <= inner.to && (LITERALS.has(inner.name) || isIncomplete(inner))) {
    const text = state.sliceDoc(inner.from, inner.to)
    const wordy = text[0] === '"' || /^[^\s"{}[\],:]+$/.test(text)
    const terminated = text.length >= 2 && text[0] === '"' && text.endsWith('"')
    if (wordy && !(terminated && pos === inner.to)) tok = inner
  }

  const container = containerAt(inner, pos)
  if (!container) return null
  const start = tok ? tok.from : pos
  const before = state.sliceDoc(container.from, start).trimEnd()
  const prev = before.slice(-1)
  const prevAt = container.from + before.length - 1

  let role: 'key' | 'value'
  let path = pathOf(state, container)
  let own: SyntaxNode | null = null
  if (container.name === 'Object') {
    if (tok?.name === 'PropertyName') {
      role = 'key'
      own = tok.parent
    } else if (prev === '{' || prev === ',') role = 'key'
    else if (prev === ':') {
      role = 'value'
      const prop = container.childAfter(prevAt)
      if (!prop || prop.name !== 'Property' || prop.from > prevAt) return null
      path = [...path, keyOf(state, prop)]
    } else return null
  } else {
    if (prev !== '[' && prev !== ',') return null
    role = 'value'
    path = [...path, null]
  }

  const tokFrom = tok ? tok.from : pos
  const tokTo = tok ? tok.to : pos
  const quoted = !!tok && state.sliceDoc(tok.from, tok.from + 1) === '"'
  const next = /^\s*(\S)/.exec(state.sliceDoc(tokTo, Math.min(state.doc.length, tokTo + 400)))?.[1] ?? ''
  return {
    role,
    path,
    container,
    tokFrom,
    tokTo,
    prefixFrom: quoted ? tokFrom + 1 : tokFrom,
    quoted,
    hasColon: next === ':',
    nextProp: next === '"' || /[A-Za-z_$]/.test(next),
    own
  }
}

/* ------------------------------------------------------------------------------------------ completion */

/** What goes after `"key": `, where the cursor lands, and whether to reopen the popup for the next choice. */
interface Shape {
  text: string
  /** Cursor offset into `text`. */
  cursor: number
  /** Characters to select from the cursor (the placeholder `true`). */
  select?: number
  reopen?: boolean
}

function shapeFor(n: DocNode | undefined): Shape {
  if (!n) return { text: '', cursor: 0 }
  const kind = kindsOf(n)[0]
  switch (kind) {
    case 'string':
      return { text: '""', cursor: 1, reopen: !!n.values?.length }
    case 'boolean':
      return { text: 'true', cursor: 0, select: 4 }
    case 'array':
      return { text: '[]', cursor: 1, reopen: !!n.items && !!(n.items.valueSource || n.items.values?.length) }
    case 'object':
      return { text: '{}', cursor: 1, reopen: !!n.properties || !!n.keySource }
    default:
      return { text: '', cursor: 0 }
  }
}

/** The edit that inserts `"key": <empty value>` over the typed token. */
export function keyEdit(c: Ctx, name: string, node: DocNode | undefined): { from: number; to: number; insert: string; anchor: number; head: number; reopen: boolean } {
  let insert = JSON.stringify(name)
  let anchor = insert.length
  let head = anchor
  let reopen = false
  if (!c.hasColon) {
    const shape = shapeFor(node)
    insert += ': '
    anchor = insert.length + shape.cursor
    head = anchor + (shape.select ?? 0)
    insert += shape.text
    reopen = !!shape.reopen
    if (c.nextProp) insert += ','
  }
  return { from: c.tokFrom, to: c.tokTo, insert, anchor: c.tokFrom + anchor, head: c.tokFrom + head, reopen }
}

function applyEdit(view: EditorView, completion: Completion, e: { from: number; to: number; insert: string; anchor: number; head?: number }, reopen = false): void {
  view.dispatch({
    changes: { from: e.from, to: e.to, insert: e.insert },
    selection: { anchor: e.anchor, head: e.head ?? e.anchor },
    userEvent: 'input.complete',
    annotations: pickedCompletion.of(completion)
  })
  if (reopen) startCompletion(view)
}

/** The docs' scope for the few keys Claude Code keeps in ~/.claude.json. */
const GLOBAL_CONFIG = 'Global config'

function withUrl(c: Completion, url: string | undefined): Completion {
  if (url) completionUrls.set(c, url)
  return c
}

function keyOptions(state: EditorState, c: Ctx, docs: SettingsDocs, obj: DocNode): Completion[] {
  const present = new Set<string>()
  for (let ch = c.container.firstChild; ch; ch = ch.nextSibling) {
    if (ch.name === 'Property' && ch.from !== c.own?.from) present.add(keyOf(state, ch))
  }
  const out: Completion[] = []
  let i = 0
  for (const [name, node] of Object.entries(obj.properties ?? {})) {
    const order = String(i++).padStart(4, '0')
    // keys the docs list for ~/.claude.json do nothing in a settings file, and removed keys do nothing anywhere
    if (present.has(name) || node.scope === GLOBAL_CONFIG || node.removed) continue
    out.push(
      withUrl(
        {
          label: name,
          detail: kindLabel(node),
          type: 'property',
          sortText: order,
          info: () => cardDom(keyCard(name, node)),
          apply: (view, completion, _from, to) => {
            const cur = contextAt(view.state, to) ?? c
            const e = keyEdit(cur, name, node)
            applyEdit(view, completion, e, e.reopen)
          }
        },
        node.url
      )
    )
  }
  if (obj.keySource === 'env') {
    const valueDoc = obj.additional
    for (const { name, summary } of docs.env) {
      if (present.has(name) || has(obj.properties, name)) continue
      out.push(
        withUrl(
          {
            label: name,
            detail: 'env var',
            type: 'variable',
            sortText: 'e' + name,
            info: () => cardDom(envCard(name, summary)),
            apply: (view, completion, _from, to) => {
              const cur = contextAt(view.state, to) ?? c
              const e = keyEdit(cur, name, valueDoc ?? { kinds: ['string'] })
              applyEdit(view, completion, e, e.reopen)
            }
          },
          ENV_PAGE
        )
      )
    }
  }
  return out
}

/** The edit that puts `text` (already JSON) over the typed token. */
function valueApply(text: string): NonNullable<Completion['apply']> {
  return (view, completion, from, to) => {
    const cur = contextAt(view.state, to)
    const [a, b] = cur ? [cur.tokFrom, cur.tokTo] : [from, to]
    applyEdit(view, completion, { from: a, to: b, insert: text, anchor: a + text.length })
  }
}

function valueOptions(c: Ctx, docs: SettingsDocs, node: DocNode | undefined, ruleSource: boolean, url: string | undefined): Completion[] {
  const out: Completion[] = []
  let list: DocValue[] = node?.values ?? []
  if (!list.length && node && kindsOf(node).includes('boolean')) list = [{ value: true }, { value: false }]
  if (!list.length && c.path.length === 1 && c.path[0] === '$schema') {
    list = [{ value: 'https://json.schemastore.org/claude-code-settings.json', summary: 'The JSON schema for Claude Code settings. Editors that read it offer the same keys.' }]
  }
  list.forEach((v, i) => {
    out.push(
      withUrl(
        {
          label: typeof v.value === 'string' ? v.value : String(v.value),
          type: 'enum',
          sortText: String(i).padStart(4, '0'),
          info: v.summary ? () => cardDom(valueCard(v, node)) : undefined,
          apply: valueApply(JSON.stringify(v.value))
        },
        url
      )
    )
  })

  // permission rules start with a tool name: `Bash(`, `Read(`, ...
  if (ruleSource) {
    docs.tools.forEach((tool, i) => {
      out.push(
        withUrl(
          {
            label: `${tool}(`,
            detail: 'permission rule',
            type: 'keyword',
            sortText: 'r' + String(i).padStart(4, '0'),
            info: () =>
              cardDom({
                title: `${tool}(…)`,
                summary: `Matches uses of the ${tool} tool. Put what to match inside the parentheses, or leave them off to match every use.`,
                rows: []
              }),
            apply: (view, completion, from, to) => {
              const cur = contextAt(view.state, to)
              const a = cur ? cur.tokFrom : from
              const b = cur ? cur.tokTo : to
              const text = JSON.stringify(`${tool}()`)
              applyEdit(view, completion, { from: a, to: b, insert: text, anchor: a + text.length - 2 })
            }
          },
          url
        )
      )
    })
  }
  return out
}

/** Completion source, exported for tests. */
export function completeSettings(context: CompletionContext, docs: SettingsDocs): CompletionResult | null {
  const { state, pos } = context
  const c = contextAt(state, pos)
  if (!c) return null
  // while typing, wait for the first character or a quote; Ctrl+Space always asks
  if (!context.explicit && c.prefixFrom === pos && !c.quoted) return null

  let options: Completion[] = []
  if (c.role === 'key') {
    const obj = resolve(docs.root, c.path)
    if (obj) options = keyOptions(state, c, docs, obj)
  } else {
    // the doc node of the value; for an array item that is the array's `items`. The docs may put `valueSource` on either.
    const node = resolve(docs.root, c.path)
    const parent = c.path[c.path.length - 1] === null ? resolve(docs.root, c.path.slice(0, -1)) : undefined
    const rule = (node?.valueSource ?? parent?.valueSource) === 'permissionRule'
    // once the tool name is finished (`Bash(`), what follows is the user's own pattern
    options = valueOptions(c, docs, node, rule && !state.sliceDoc(c.prefixFrom, pos).includes('('), node?.url ?? parent?.url)
  }
  if (!options.length) return null
  return { from: c.prefixFrom, options, validFor: c.role === 'value' && c.quoted ? /^[^"\n]*$/ : /^[\w$.-]*$/ }
}

/* ------------------------------------------------------------------------------------------ hover */

/** The card for the key or known value under `pos`, with the range it covers. */
export function hoverInfo(state: EditorState, pos: number, side: -1 | 1, docs: SettingsDocs): { from: number; to: number; card: CardData } | null {
  const n = tree(state).resolveInner(pos, side)
  if (!n.parent) return null
  if (n.name === 'PropertyName') {
    const prop = n.parent
    const obj = prop.parent
    if (prop.name !== 'Property' || !obj) return null
    const key = keyOf(state, prop)
    const parentDoc = resolve(docs.root, pathOf(state, obj))
    if (!parentDoc) return null
    if (has(parentDoc.properties, key)) return { from: n.from, to: n.to, card: keyCard(key, parentDoc.properties![key]) }
    const env = parentDoc.keySource === 'env' ? envMap(docs).get(key) : undefined
    return env !== undefined ? { from: n.from, to: n.to, card: envCard(key, env) } : null
  }
  if (n.name === 'String' || n.name === 'Number' || n.name === 'True' || n.name === 'False' || n.name === 'Null') {
    const doc = resolve(docs.root, pathOf(state, n))
    if (!doc?.values) return null
    let value: unknown
    try {
      value = JSON.parse(state.sliceDoc(n.from, n.to))
    } catch {
      return null
    }
    const hit = doc.values.find((v) => v.value === value)
    return hit ? { from: n.from, to: n.to, card: valueCard(hit, doc) } : null
  }
  return null
}

/* ------------------------------------------------------------------------------------------ warnings */

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]
}

/** A documented key that `key` is probably a typo of: same letters in another case, else within edit distance 2. */
function didYouMean(key: string, candidates: string[]): string | undefined {
  const lower = key.toLowerCase()
  const same = candidates.find((k) => k.toLowerCase() === lower)
  if (same) return same
  const max = key.length <= 3 ? 1 : 2
  let best: string | undefined
  let bestD = max + 1
  for (const k of candidates) {
    if (Math.abs(k.length - key.length) > max) continue
    const d = levenshtein(lower, k.toLowerCase())
    if (d < bestD) {
      best = k
      bestD = d
    }
  }
  return best
}

const KIND_OF_NODE: Record<string, JsonKind> = { String: 'string', Number: 'number', True: 'boolean', False: 'boolean', Null: 'null', Array: 'array', Object: 'object' }
const WANT: Record<JsonKind, string> = { string: 'a string', number: 'a number', boolean: 'true or false', array: 'a list', object: 'an object', null: 'null' }
const GOT: Record<JsonKind, string> = { string: 'a string', number: 'a number', boolean: 'a boolean', array: 'a list', object: 'an object', null: 'null' }

/** Documented key names of an object node, for "did you mean". */
const candidateCache = new WeakMap<DocNode, string[]>()
function candidatesOf(n: DocNode): string[] {
  let c = candidateCache.get(n)
  if (!c) {
    // never suggest a key that would only draw the next warning
    c = Object.entries(n.properties ?? {})
      .filter(([, d]) => !d.removed && d.scope !== GLOBAL_CONFIG)
      .map(([k]) => k)
    candidateCache.set(n, c)
  }
  return c
}

interface LintCtx {
  state: EditorState
  docs: SettingsDocs
  out: Diagnostic[]
}

function warn(l: LintCtx, from: number, to: number, message: string, actions?: Action[]): void {
  l.out.push({ from, to, severity: 'warning', message, actions })
}

/** The value node of a Property (after the colon), if there is one. */
function valueOf(prop: SyntaxNode): SyntaxNode | null {
  const name = prop.getChild('PropertyName')
  let v = name?.nextSibling ?? null
  if (v && v.name === ':') v = v.nextSibling
  return v && KIND_OF_NODE[v.name] ? v : null
}

/** Check one value against its doc node. `label` names it for the message; `owner` is the nearest key for items. */
function lintValue(l: LintCtx, v: SyntaxNode, doc: DocNode, label: string | null, owner: string): void {
  const kind = KIND_OF_NODE[v.name]
  // what only the schema says may lag the docs: it never warns
  if (doc.kinds?.length && !doc.kinds.includes(kind) && !doc.schemaOnly?.includes('kinds')) {
    const want = doc.kinds.map((k) => WANT[k]).join(' or ')
    warn(l, v.from, v.to, label ? `${label} takes ${want}; this is ${GOT[kind]}` : `Each item in ${owner} takes ${want}; this is ${GOT[kind]}`)
    return
  }
  if (doc.closedValues && !doc.schemaOnly?.includes('closedValues') && doc.values && kind !== 'object' && kind !== 'array') {
    let value: unknown
    try {
      value = JSON.parse(l.state.sliceDoc(v.from, v.to))
    } catch {
      return
    }
    if (!doc.values.some((x) => x.value === value)) {
      const shown = doc.values.slice(0, 8).map((x) => JSON.stringify(x.value))
      const more = doc.values.length > 8 ? ', …' : ''
      warn(l, v.from, v.to, `${label ?? `Items in ${owner}`} does not accept ${JSON.stringify(value)}. Use one of: ${shown.join(', ')}${more}`)
    }
    return
  }
  if (v.name === 'Object') lintObject(l, v, doc, label ?? owner, false)
  else if (v.name === 'Array' && doc.items) {
    for (let it = v.firstChild; it; it = it.nextSibling) if (KIND_OF_NODE[it.name]) lintValue(l, it, doc.items, null, label ?? owner)
  }
}

function lintObject(l: LintCtx, obj: SyntaxNode, doc: DocNode, owner: string, isRoot: boolean): void {
  const seen = new Map<string, SyntaxNode[]>()
  const props: Array<{ prop: SyntaxNode; key: string }> = []
  for (let p = obj.firstChild; p; p = p.nextSibling) {
    if (p.name !== 'Property' || !p.getChild('PropertyName')) continue
    const key = keyOf(l.state, p)
    props.push({ prop: p, key })
    const list = seen.get(key)
    if (list) list.push(p)
    else seen.set(key, [p])
  }
  const env = doc.keySource === 'env' ? envMap(l.docs) : undefined
  for (const { prop, key } of props) {
    const name = prop.getChild('PropertyName')!
    const dups = seen.get(key)!
    if (dups.length > 1 && dups[dups.length - 1] !== prop) warn(l, name.from, name.to, `"${key}" appears twice; the last one wins`)

    let child: DocNode | undefined
    if (has(doc.properties, key)) child = doc.properties![key]
    else if (doc.additional) child = doc.additional
    else if (env?.has(key) || (isRoot && key === '$schema')) child = undefined
    else if (doc.closed && !doc.schemaOnly?.includes('closed')) {
      const guess = didYouMean(key, candidatesOf(doc))
      const where = isRoot ? 'a known setting' : `a known key under ${owner}`
      const actions: Action[] | undefined = guess
        ? [{ name: `Use "${guess}"`, apply: (view, from, to) => view.dispatch({ changes: { from, to, insert: JSON.stringify(guess) } }) }]
        : undefined
      warn(l, name.from, name.to, `"${key}" is not ${where}.${guess ? ` Did you mean "${guess}"?` : ''}`, actions)
    }
    if (!child) continue
    if (child.removed) {
      warn(l, name.from, name.to, `"${key}" was removed in Claude Code ${child.removed} and does nothing now`)
      continue
    }
    if (isRoot && child.scope === GLOBAL_CONFIG) warn(l, name.from, name.to, `Claude Code ignores "${key}" here. It belongs in ~/.claude.json`)
    const value = valueOf(prop)
    if (value) lintValue(l, value, child, key, key)
  }
}

/** Warnings for a settings file, exported for tests. Empty while the JSON has syntax errors (the parse linter reports those). */
export function lintSettings(state: EditorState, docs: SettingsDocs): Diagnostic[] {
  const t = tree(state)
  let broken = false
  t.iterate({
    enter(n) {
      if (broken) return false
      if (n.type.isError) {
        broken = true
        return false
      }
      return undefined
    }
  })
  if (broken) return []
  const top = t.topNode.firstChild
  if (!top || top.name !== 'Object') return []
  const l: LintCtx = { state, docs, out: [] }
  lintObject(l, top, docs.root, '', true)
  return l.out
}

/* ------------------------------------------------------------------------------------------ F1: open the docs */

/**
 * The docs page for F1. `selected` is the highlighted row while the completion popup is open (null: open with no row),
 * undefined when it is closed; then the page of the nearest key around `pos`, or the env var docs inside `env`.
 */
export function docsUrlFor(state: EditorState, docs: SettingsDocs, pos: number, selected?: Completion | null): string | undefined {
  if (selected !== undefined) return selected ? safeDocsUrl(completionUrls.get(selected)) : undefined
  for (let n: SyntaxNode | null = tree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name !== 'Property' || !n.getChild('PropertyName')) continue
    const key = keyOf(state, n)
    const objPath = pathOf(state, n)
    if (resolve(docs.root, objPath)?.keySource === 'env' && envMap(docs).has(key)) return ENV_PAGE
    const url = safeDocsUrl(resolve(docs.root, [...objPath, key])?.url)
    if (url) return url
  }
  return undefined
}

/** F1: open the docs for the selected completion, else for the key at the cursor. False (key not taken) when there is no page. */
export function openDocsCommand(docs: SettingsDocs): (view: EditorView) => boolean {
  return (view) => {
    const popup = completionStatus(view.state) === 'active'
    const url = docsUrlFor(view.state, docs, view.state.selection.main.head, popup ? selectedCompletion(view.state) : undefined)
    if (!url) return false
    // the main process sends http(s) to the system browser and denies the window
    window.open(url, '_blank')
    return true
  }
}

/* ------------------------------------------------------------------------------------------ extension */

/** Completion, hover and warnings for the settings JSON editor. Memoize the result: a new array reconfigures the editor. */
export function settingsAssist(docs: SettingsDocs): Extension[] {
  return [
    autocompletion({
      override: [(context) => completeSettings(context, docs)],
      icons: false,
      maxRenderedOptions: 80,
      tooltipClass: () => 'cm-settings-assist'
    }),
    hoverTooltip(
      (view, pos, side): Tooltip | null => {
        const hit = hoverInfo(view.state, pos, side < 0 ? -1 : 1, docs)
        if (!hit) return null
        return { pos: hit.from, end: hit.to, above: true, create: () => ({ dom: cardDom(hit.card) }) }
      },
      { hoverTime: 350 }
    ),
    linter((view) => lintSettings(view.state, docs)),
    keymap.of([
      { key: 'F1', run: openDocsCommand(docs) },
      // F1 is a media key on Mac keyboards unless Fn is held
      { key: 'Mod-Shift-d', run: openDocsCommand(docs) }
    ])
  ]
}
