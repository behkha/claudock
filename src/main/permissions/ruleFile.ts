import type { ProjectRuleList } from '@shared/api/permissions'
import { maskText, secretsInText } from '../../shared/secrets.ts'

/**
 * A rule file as text: taking one rule out of it without touching anything else, and covering the secrets in it before
 * it is shown. Pure, so `npm test` loads it as is.
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

class Scan {
  private i = 0
  /** The array at `want`, once found. */
  found: ArrayAt | null = null
  private readonly text: string
  private readonly want: readonly string[]

  // plain fields, not parameter properties: Node's type stripping (npm test) can't run those
  constructor(text: string, want: readonly string[]) {
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
    if (c === '"') return this.string()
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

/**
 * A rule file's text with every secret in it covered, for the diff in Backups: each string value is searched the way
 * a rule is, and the file is written out again with its own indentation. Text that is not JSON is covered as it stands.
 */
export function maskRuleFile(text: string): string {
  const cover = (s: string): string => maskText(s, secretsInText(s)).text
  let parsed: unknown
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return cover(text)
  }
  const walk = (v: unknown): unknown =>
    typeof v === 'string' ? cover(v) : Array.isArray(v) ? v.map(walk) : typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? 2
  return JSON.stringify(walk(parsed), null, indent) + (text.endsWith('\n') ? '\n' : '')
}
