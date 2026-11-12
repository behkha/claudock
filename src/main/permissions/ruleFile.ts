import type { ProjectRuleList } from '@shared/api/permissions'
import { MASK, isCovered, maskText, secretSpans, secretsInText } from '../../shared/secrets.ts'

/**
 * A rule file as text: taking one rule out of it without touching anything else, covering the secrets in it before it
 * is stored as a snapshot or shown, and putting a covered snapshot back without losing a secret the file still holds.
 * Pure, so `npm test` loads it as is.
 */

/** Where one value of a JSON text is: `[start, end)`. */
interface Range {
  start: number
  end: number
}

/** An array in a JSON text: the brackets and each item, a string item with its value. */
interface ArrayAt {
  open: number
  close: number
  items: (Range & { value: string | null })[]
}

/** A string value in a JSON text (not a key): where it is, what it says, and the key it sits under (null inside a list). */
interface StringAt extends Range {
  value: string
  key: string | null
}

class Scan {
  private i = 0
  /** The array at `want`, once found. */
  found: ArrayAt | null = null
  /** Every string value, in order. */
  readonly strings: StringAt[] = []
  private readonly text: string
  private readonly want: readonly string[]

  // plain fields, not parameter properties: Node's type stripping (npm test) can't run those
  constructor(text: string, want: readonly string[] = []) {
    this.text = text
    this.want = want
  }

  run(): void {
    if (this.text.charCodeAt(0) === 0xfeff) this.i = 1
    this.ws()
    this.value([])
    this.ws()
    if (this.i !== this.text.length) throw new Error('not JSON')
  }

  private ws(): void {
    while (/[ \t\r\n]/.test(this.text[this.i] ?? '')) this.i++
  }

  /** A string token: its range and value. */
  private string(): Range & { value: string } {
    const start = this.i
    if (this.text[this.i] !== '"') throw new Error('not JSON')
    this.i++
    while (this.i < this.text.length && this.text[this.i] !== '"') this.i += this.text[this.i] === '\\' ? 2 : 1
    if (this.text[this.i] !== '"') throw new Error('not JSON')
    this.i++
    return { start, end: this.i, value: JSON.parse(this.text.slice(start, this.i)) as string }
  }

  private value(path: readonly string[]): Range & { value: string | null } {
    const start = this.i
    const c = this.text[this.i]
    if (c === '"') {
      const s = this.string()
      const key = path[path.length - 1]
      this.strings.push({ ...s, key: key === undefined || key === '#' ? null : key })
      return s
    }
    if (c === '{') {
      this.i++
      this.ws()
      while (this.text[this.i] !== '}') {
        const key = this.string().value
        this.ws()
        if (this.text[this.i] !== ':') throw new Error('not JSON')
        this.i++
        this.ws()
        this.value([...path, key])
        this.ws()
        if (this.text[this.i] === ',') {
          this.i++
          this.ws()
        } else if (this.text[this.i] !== '}') throw new Error('not JSON')
      }
      this.i++
      return { start, end: this.i, value: null }
    }
    if (c === '[') {
      const at: ArrayAt = { open: this.i, close: -1, items: [] }
      this.i++
      this.ws()
      while (this.text[this.i] !== ']') {
        at.items.push(this.value([...path, '#']))
        this.ws()
        if (this.text[this.i] === ',') {
          this.i++
          this.ws()
        } else if (this.text[this.i] !== ']') throw new Error('not JSON')
      }
      at.close = this.i
      this.i++
      // the first array at that path (a key written twice keeps Claude Code's reading out of scope: the first is changed)
      if (!this.found && path.length === this.want.length && path.every((k, n) => k === this.want[n])) this.found = at
      return { start, end: this.i, value: null }
    }
    const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.i, this.i + 40))
    if (!m) throw new Error('not JSON')
    this.i += m[0].length
    return { start, end: this.i, value: null }
  }
}

/**
 * `text` (a settings file) without the first `rule` in `permissions.<list>`: exactly that item goes, with the comma
 * and the white space that belonged to it. Every other byte stays: the other keys, the indentation, the line ends, a
 * trailing newline, a second copy of the same rule. Null when the text is not JSON or holds no such rule.
 */
export function removeRuleFromText(text: string, list: ProjectRuleList, rule: string): string | null {
  const scan = new Scan(text, ['permissions', list])
  try {
    scan.run()
  } catch {
    return null
  }
  const arr = scan.found
  if (!arr) return null
  const n = arr.items.findIndex((it) => it.value === rule)
  if (n < 0) return null
  const it = arr.items[n]
  // followed by another item: up to where that one starts; the last of several: from where the one before ends;
  // the only one: everything between the brackets
  const [from, to] = n < arr.items.length - 1 ? [it.start, arr.items[n + 1].start] : n > 0 ? [arr.items[n - 1].end, it.end] : [arr.open + 1, arr.close]
  const out = text.slice(0, from) + text.slice(to)
  try {
    JSON.parse(out.charCodeAt(0) === 0xfeff ? out.slice(1) : out)
  } catch {
    return null
  }
  return out
}

/** A string value of a rule file with its secrets covered: searched the way a rule is, and as a value under its key (`env`). */
function coverValue(value: string, key: string | null): string {
  if (isCovered(value)) return maskText(value, secretsInText(value)).text
  const found = secretsInText(value)
  if (found.length) return maskText(value, found).text
  const spans = key === null ? [] : secretSpans(value, key, value.includes('://'))
  let out = ''
  let at = 0
  for (const [s, e] of spans) {
    out += value.slice(at, s) + MASK
    at = e
  }
  return out + value.slice(at)
}

/** Every string value of a JSON text, or null when it is not JSON. */
function stringsOf(text: string): StringAt[] | null {
  const scan = new Scan(text)
  try {
    scan.run()
  } catch {
    return null
  }
  return scan.strings
}

/**
 * A rule file's text with every secret in it covered: what a snapshot stores and what Backups shows. Only the secrets
 * change; every other byte stays (the keys, the indentation, the line ends), so a file with no secret is stored as it
 * is. Covering covered text changes nothing. Text that is not JSON is covered as it stands.
 */
export function coverRuleFile(text: string): string {
  const strings = stringsOf(text)
  if (!strings) return maskText(text, secretsInText(text)).text
  let out = text
  for (let n = strings.length - 1; n >= 0; n--) {
    const s = strings[n]
    const covered = coverValue(s.value, s.key)
    if (covered !== s.value) out = out.slice(0, s.start) + JSON.stringify(covered) + out.slice(s.end)
  }
  return out
}

/**
 * The text to write when a covered snapshot is restored over `current` (null: the file is gone): the snapshot, with each
 * covered value put back in full from the current file wherever the current file still holds a value that covers to the
 * same text. So a secret the file still has is never replaced by dots. A value the file no longer holds (the rule that
 * was removed for its secret) comes back covered: the secret itself was never stored. Throws when the snapshot holds
 * covered values and the current file cannot be read as JSON to take them from.
 */
export function restoreCovered(snapshot: string, current: string | null): string {
  if (!isCovered(snapshot)) return snapshot
  const want = stringsOf(snapshot)
  const have = current === null ? [] : stringsOf(current)
  if (!want || !have) throw new Error('This snapshot holds covered secrets, and the file as it is now cannot be read as JSON to keep its own, so Claudock will not restore over it.')
  // the current file's values that hold a secret, by what they look like covered; the same covered text twice is taken in order
  const pool = new Map<string, string[]>()
  for (const s of have) {
    const covered = coverValue(s.value, s.key)
    if (covered === s.value) continue
    pool.set(covered, [...(pool.get(covered) ?? []), (current as string).slice(s.start, s.end)])
  }
  const puts: { at: StringAt; raw: string }[] = []
  for (const s of want) {
    const raw = isCovered(s.value) ? pool.get(s.value)?.shift() : undefined
    if (raw !== undefined) puts.push({ at: s, raw })
  }
  let out = snapshot
  for (const p of puts.reverse()) out = out.slice(0, p.at.start) + p.raw + out.slice(p.at.end)
  return out
}
