/** Small JSON helpers for the settings editor. */

export interface JsonProblem {
  message: string
  /** 1-based; null when the position is unknown. */
  line: number | null
  column: number | null
}

/** Offset of the first syntax error in `text`, or null if it is valid JSON. (V8 messages do not always carry a position.) */
function firstErrorOffset(text: string): number | null {
  let i = 0
  const n = text.length
  const ws = (): void => {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++
  }
  const fail = (at = i): never => {
    throw at
  }
  const literal = (word: string): void => {
    if (text.startsWith(word, i)) i += word.length
    else {
      let k = 0
      while (k < word.length && text[i + k] === word[k]) k++
      fail(i + k)
    }
  }
  const str = (): void => {
    i++ // opening quote
    while (i < n) {
      const c = text[i]
      if (c === '"') {
        i++
        return
      }
      if (c === '\\') {
        const e = text[i + 1]
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail(i + 2)
          i += 6
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2
        else fail(i + 1)
      } else if (c < ' ') fail(i)
      else i++
    }
    fail(n)
  }
  const num = (): void => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400))
    if (!m) fail(i + (text[i] === '-' ? 1 : 0))
    i += m![0].length
  }
  const value = (depth: number): void => {
    ws()
    if (i >= n) fail(n)
    if (depth > 200) fail(i)
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') return void i++
      for (;;) {
        ws()
        if (text[i] !== '"') fail(i)
        str()
        ws()
        if (text[i] !== ':') fail(i)
        i++
        value(depth + 1)
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') return void i++
        fail(i)
      }
    } else if (c === '[') {
      i++
      ws()
      if (text[i] === ']') return void i++
      for (;;) {
        value(depth + 1)
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') return void i++
        fail(i)
      }
    } else if (c === '"') str()
    else if (c === '-' || (c >= '0' && c <= '9')) num()
    else if (c === 't') literal('true')
    else if (c === 'f') literal('false')
    else if (c === 'n') literal('null')
    else fail(i)
  }
  try {
    value(0)
    ws()
    if (i < n) fail(i)
    return null
  } catch (at) {
    return typeof at === 'number' ? Math.min(at, n) : 0
  }
}

function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let last = -1
  for (let k = 0; k < offset && k < text.length; k++) {
    if (text[k] === '\n') {
      line++
      last = k
    }
  }
  return { line, column: offset - last }
}

/** Null if `text` is a JSON object; otherwise what is wrong and where. */
export function checkSettingsJson(text: string): JsonProblem | null {
  if (text.trim() === '') return { message: 'The file is empty. An empty settings file is {}', line: 1, column: 1 }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    const raw = (e as Error).message
    const offset = firstErrorOffset(text)
    const pos = offset === null ? null : lineCol(text, offset)
    const message = raw.replace(/\s+in JSON at position \d+(?: \(line \d+ column \d+\))?/, '').replace(/, ".*" is not valid JSON$/s, '')
    return { message, line: pos?.line ?? null, column: pos?.column ?? null }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { message: 'The top level must be an object { … }', line: 1, column: 1 }
  }
  return null
}

export function describeProblem(p: JsonProblem): string {
  return p.line === null ? p.message : `Line ${p.line}, column ${p.column}: ${p.message}`
}

export type JsonObject = Record<string, unknown>

/** Parse a settings text for the form. A blank text is `{}`. Returns null if it is not a JSON object. */
export function parseObject(text: string): JsonObject | null {
  if (text.trim() === '') return {}
  try {
    const v: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : null
  } catch {
    return null
  }
}
