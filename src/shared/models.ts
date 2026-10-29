/** Model ids as people say them, for the share card and its price table. No imports, so `npm test` can load it. */

const FAMILIES = 'opus|sonnet|haiku|fable|mythos'

/** "Opus 5", "Sonnet 5.5", "Haiku 4.5", "Fable 5.1". Unknown ids come back as they are. */
export function friendlyModel(id: string): string {
  const s = id
    .trim()
    .toLowerCase()
    .replace(/^.*anthropic\./, '')
    .replace(/\[.*\]$/, '')
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1)
  // claude-opus-5, claude-sonnet-5-5, claude-opus-4-20250514, claude-haiku-4-5-20251001
  // (Vertex writes claude-sonnet-4-5@20250929; claude-opus-4-0 is Opus 4)
  let m = new RegExp(`^claude-(${FAMILIES})-(\\d+)(?:-(\\d{1,2}))?(?=-\\d{8}|-v\\d|[:@]|$)`).exec(s)
  if (m) return `${cap(m[1])} ${m[2]}${m[3] && m[3] !== '0' ? `.${m[3]}` : ''}`
  // claude-3-5-sonnet-20241022, claude-3-opus-20240229
  m = new RegExp(`^claude-(\\d+)(?:-(\\d{1,2}))?-(${FAMILIES})`).exec(s)
  if (m) return `${cap(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ''}`
  return id
}

export const isClaudeModel = (id: string): boolean => new RegExp(`claude|${FAMILIES}`, 'i').test(id) && !id.startsWith('<')
