/**
 * A session's context size, from its transcript: what Claude Code recorded as the input of a reply
 * (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens` of an assistant line's `message.usage`).
 * Tokens as recorded, never a share of a window: Claudock does not know the model's window. Pure, so `npm test` loads
 * it as is; src/main/domains/sessions.ts reads the files.
 */

/** One reply's context. */
export interface ContextReading {
  /** When the reply was written (ms since the epoch); NaN when the line has no timestamp. */
  t: number
  /** The message's id: Claude Code writes one message as several lines that repeat the same usage. */
  key: string
  context: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * One transcript line as a reading, or null: not an assistant line with usage, one Claude Code made up itself
 * (`<synthetic>`), a sub-agent's line (each sub-agent has its own context), or a line cut in half.
 */
export function readingOf(line: string): ContextReading | null {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!isObj(o) || o.type !== 'assistant' || o.isSidechain === true || !isObj(o.message) || !isObj(o.message.usage)) return null
  if (o.message.model === '<synthetic>') return null
  const u = o.message.usage
  const context = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens)
  if (context === 0) return null
  const key = typeof o.message.id === 'string' && o.message.id ? o.message.id : typeof o.uuid === 'string' ? o.uuid : ''
  return { t: typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN, key, context }
}

/** Every reply in `lines`, in order, each message once (its last line). */
export function readings(lines: Iterable<string>): ContextReading[] {
  const out: ContextReading[] = []
  for (const line of lines) {
    const r = readingOf(line)
    if (!r) continue
    const last = out[out.length - 1]
    if (last && r.key && last.key === r.key) out[out.length - 1] = r
    else out.push(r)
  }
  return out
}

/** The context of the last reply in `text`, the end of a transcript (it may start in the middle of a line). Null when it holds none. */
export function contextIn(text: string): number | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = readingOf(lines[i])
    if (r) return r.context
  }
  return null
}

/** The first timestamp in `text`, the start of a transcript: when the session began. Null when it holds none. */
export function startedIn(text: string): number | null {
  for (const line of text.split('\n')) {
    const m = /"timestamp":"([^"]+)"/.exec(line)
    const t = m ? Date.parse(m[1]) : NaN
    if (Number.isFinite(t)) return t
  }
  return null
}
