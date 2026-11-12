/**
 * Finding literal secrets, in two kinds of text: a value under a name (an MCP server's header, env value, argument or
 * URL: Team mode, src/main/team/model.ts) and free text (a saved permission rule: src/main/permissions/). One set of
 * patterns for both. Pure, no Electron and no file access, so `npm test` loads it as is.
 *
 * A value read from a variable (`${NAME}`, `$NAME`, `%NAME%`) is never a secret: it names where the secret is, it does
 * not hold it.
 */

/** A name under which a literal value is a secret. */
export const SECRET_NAME = /(token|secret|passw(or)?d|api[-_]?key|apikey|authorization|credential|private[-_]?key|access[-_]?key|^auth$)/i
/** "Bearer <value>": the value after it is the secret. */
export const SCHEME = /^(Bearer|Basic|Token|token|bearer)\s+/
/** Token shapes that are secrets wherever they appear. */
export const SHAPES: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
]
export const URL_USERINFO = /:\/\/([^/@\s:]+:[^/@\s]+)@/
export const URL_PARAM = /[?&](?:token|key|api[-_]?key|apikey|access[-_]?token|secret|password)=([^&#\s]+)/gi

/** `[start, end)` in a string. */
export type Span = [number, number]

const insideVar = (v: string, i: number): boolean => {
  const open = v.lastIndexOf('${', i)
  return open >= 0 && v.indexOf('}', open) >= i
}

/**
 * The parts of a value that are a secret, in order, not overlapping. `name`: the key it sits under (a header or env
 * name), or null for a bare value (an argument, a URL). `isUrl`: also look for a password or a secret parameter in a URL.
 */
export function secretSpans(value: string, name: string | null, isUrl: boolean): Span[] {
  const spans: Span[] = []
  const add = (s: number, e: number): void => {
    if (e > s && !insideVar(value, s) && !spans.some(([a, b]) => s < b && e > a)) spans.push([s, e])
  }
  for (const re of SHAPES) for (const m of value.matchAll(re)) add(m.index, m.index + m[0].length)
  if (isUrl) {
    const u = URL_USERINFO.exec(value)
    if (u) add(u.index + 3, u.index + 3 + u[1].length)
    for (const m of value.matchAll(URL_PARAM)) add(m.index + m[0].length - m[1].length, m.index + m[0].length)
  }
  if (name !== null && spans.length === 0) {
    const scheme = SCHEME.exec(value)
    const start = scheme ? scheme[0].length : 0
    const rest = value.slice(start)
    const named = SECRET_NAME.test(name)
    // under a secret's name, anything that is not a variable; under any name, "Bearer <long value>"
    if (!rest.includes('${') && ((named && rest.length >= 8) || (scheme && /^[A-Za-z0-9._~+/=-]{20,}$/.test(rest)))) add(start, value.length)
  }
  return spans.sort((a, b) => a[0] - b[0])
}

/* ------------------------------------------------------------------ free text */

/** A secret found in free text. */
export interface TextSecret {
  start: number
  end: number
  /** How many of its first characters say only what kind of token it is (`ghp_`, `sk-`) and may be shown; 0 for anything else. */
  keep: number
}

/** The start of each token shape that is public: it names the issuer, not the secret. */
const SHAPE_PREFIX = /^(gh[pousr]_|github_pat_|glpat-|sk-|xox[abprs]-|AKIA|eyJ)/

/** What covers a secret: never as many dots as it has characters, so its length is not shown either. */
export const MASK = '••••••'
/** A value that was covered already (it holds the dots, not the secret). */
export const isCovered = (v: string): boolean => v.includes('•')

/**
 * A value that holds no secret of its own: read from somewhere else when the command runs (`$NAME`, `${NAME}`, `$(…)`,
 * `%NAME%`, a backtick command), or already covered.
 */
const isVariable = (v: string): boolean => /^\$|\$\{|\$\(|^`|^%[A-Za-z_][A-Za-z0-9_]*%$/.test(v) || isCovered(v)

/** The least a literal value under a secret's name is long. */
const MIN_NAMED = 8
/** `NAME=value` (also `--name=value`, `name="value"`), and `Name: value` with a space after the colon (a header). */
const ASSIGN = /([A-Za-z_][A-Za-z0-9_.-]*)(=|:\s+)(?:"([^"]*)"|'([^']*)'|([^\s"'&;|)]+))/g
const BEARER = /\b(?:Bearer|Basic|Token|token|bearer)\s+([A-Za-z0-9._~+/=-]{20,})/g
const USERINFO_ALL = /:\/\/[^/@\s:]+:([^/@\s]+)@/g
/** A rule's trailing wildcard is not part of a value: `Bash(TOKEN=abc12345:*)`. */
const WILDCARD_END = /(:\*|\*)$/

/**
 * Every literal secret in free text (a saved permission rule such as `Bash(API_TOKEN=… npm run sync)`), in order, not
 * overlapping:
 *   - a known token shape, anywhere;
 *   - `name=value` or `name: value` under a secret-like name (or the bare name `key`), with a literal value of 8 or more
 *     characters that is not only digits (a count, as in `--max-tokens=100000`);
 *   - `Bearer`, `Basic` or `Token` followed by a long value;
 *   - a password in a URL (`://user:password@`) or a secret parameter (`?token=…`).
 */
export function secretsInText(text: string): TextSecret[] {
  const found: TextSecret[] = []
  const add = (start: number, end: number, keep = 0): void => {
    if (end > start && !found.some((f) => start < f.end && end > f.start)) found.push({ start, end, keep })
  }
  for (const re of SHAPES) {
    for (const m of text.matchAll(re)) {
      if (!insideVar(text, m.index)) add(m.index, m.index + m[0].length, SHAPE_PREFIX.exec(m[0])?.[0].length ?? 0)
    }
  }
  for (const m of text.matchAll(BEARER)) add(m.index + m[0].length - m[1].length, m.index + m[0].length)
  for (const m of text.matchAll(USERINFO_ALL)) if (!isVariable(m[1])) add(m.index + m[0].length - 1 - m[1].length, m.index + m[0].length - 1)
  for (const m of text.matchAll(URL_PARAM)) {
    const value = m[1].replace(/[)"']+$/, '').replace(WILDCARD_END, '')
    const start = m.index + m[0].length - m[1].length
    if (value.length >= MIN_NAMED && !isVariable(value)) add(start, start + value.length)
  }
  for (const m of text.matchAll(ASSIGN)) {
    const name = m[1].replace(/^-+/, '')
    if (!SECRET_NAME.test(name) && !/^key$/i.test(name)) continue
    const quoted = m[3] ?? m[4]
    let value = quoted ?? m[5].replace(WILDCARD_END, '')
    // where the value starts: after the name, the sign and an opening quote
    let start = m.index + m[1].length + m[2].length + (quoted === undefined ? 0 : 1)
    const scheme = SCHEME.exec(value)
    if (scheme) {
      start += scheme[0].length
      value = value.slice(scheme[0].length)
    }
    if (value.length < MIN_NAMED || isVariable(value) || /^\d+$/.test(value)) continue
    add(start, start + value.length)
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * `text` with every secret covered: the public start of a known token shape, then dots; dots alone for anything else.
 * `spans` are the covered parts in the returned text. The secret itself is in neither.
 */
export function maskText(text: string, secrets: readonly TextSecret[]): { text: string; spans: Span[] } {
  let out = ''
  let at = 0
  const spans: Span[] = []
  for (const s of secrets) {
    out += text.slice(at, s.start)
    const shown = text.slice(s.start, s.start + s.keep) + MASK
    spans.push([out.length, out.length + shown.length])
    out += shown
    at = s.end
  }
  return { text: out + text.slice(at), spans }
}
