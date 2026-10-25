/**
 * Minimal YAML-frontmatter helpers for SKILL.md, agents, commands, rules and memory files.
 * Best effort: handles `key: value`, quoted scalars, inline `[a, b]` lists, `- item` lists and
 * folded/literal block scalars. Unknown or complex YAML is kept verbatim in `raw`, so callers that
 * edit the body should always write back with `joinFrontmatter(raw, body)` and never re-serialise.
 */

export interface Frontmatter {
  /** Parsed top-level keys. Values are strings, string arrays or booleans/numbers as strings. */
  data: Record<string, string | string[]>
  /** The text between the `---` fences (no fences, no trailing newline), or null if there is none. */
  raw: string | null
  /** Everything after the closing fence (leading blank line removed). */
  body: string
}

export function splitFrontmatter(text: string): { raw: string | null; body: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { raw: null, body: text }
  return { raw: m[1], body: text.slice(m[0].length).replace(/^\r?\n/, '') }
}

export function joinFrontmatter(raw: string | null, body: string): string {
  if (raw === null) return body
  return `---\n${raw}\n---\n\n${body}`
}

function unquote(v: string): string {
  const s = v.trim()
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    const inner = s.slice(1, -1)
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'")
  }
  return s
}

export function parseFrontmatter(text: string): Frontmatter {
  const { raw, body } = splitFrontmatter(text)
  const data: Record<string, string | string[]> = {}
  if (raw !== null) {
    const lines = raw.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const m = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line)
      if (!m) continue
      const key = m[1]
      const rest = m[2].trim()
      if (rest === '>' || rest === '|' || rest === '>-' || rest === '|-') {
        const folded = rest.startsWith('>')
        const block: string[] = []
        while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim())
        data[key] = folded ? block.join(' ').trim() : block.join('\n').trim()
      } else if (rest === '') {
        const items: string[] = []
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, '')))
        data[key] = items.length ? items : ''
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        data[key] = rest
          .slice(1, -1)
          .split(',')
          .map((s) => unquote(s))
          .filter(Boolean)
      } else {
        data[key] = unquote(rest)
      }
    }
  }
  return { data, raw, body }
}
