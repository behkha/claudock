import { SCREENS, type ScreenId } from '@shared/nav'
import type { WhatsNewNote } from '@shared/types'

/**
 * A release's notes, read from its GitHub body: the bullets under "## What's new in X.Y.Z". Each bullet is
 * `- **Lead-in.** The rest.`; the lead-in is the note's title and the update popover's highlight. A note links to the
 * first screen its text names ("Storage opens with…" → Storage). No Electron here.
 */

/** Names in a note that point at a screen beside its sidebar label. */
const ALIASES: [string, ScreenId][] = [
  ['CLAUDE.md', 'rules'],
  ['MCP server', 'mcp']
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The screen a note is about: the earliest sidebar label (or alias) its text names as a word, or null. */
export function noteScreen(text: string): ScreenId | null {
  let best: { at: number; id: ScreenId } | null = null
  const names: [string, ScreenId][] = [...SCREENS.map((s): [string, ScreenId] => [s.label, s.id]), ...ALIASES]
  for (const [name, id] of names) {
    // a word of its own: "Storage" but not "Storages" or "settings.json"
    const m = new RegExp(`(^|[^A-Za-z0-9_.])${escape(name)}(?![A-Za-z0-9_]|\\.[A-Za-z])`).exec(text)
    if (!m) continue
    const at = m.index + m[1].length
    if (!best || at < best.at) best = { at, id }
  }
  return best?.id ?? null
}

/** Markdown inline marks out: bold, code, links (their text kept). */
const plain = (s: string): string =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/** The notes under the body's "What's new" heading (any level, any version in it), or [] when it has none. */
export function parseNotes(body: string): WhatsNewNote[] {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^#{1,4}\s+What['’]s new\b/i.test(l.trim()))
  if (start < 0) return []
  const bullets: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break
    if (!line.trim()) continue
    const b = /^ ?[-*+]\s+(.*)$/.exec(line)
    if (b) bullets.push(b[1])
    else if (/^\s/.test(line) && bullets.length) bullets[bullets.length - 1] += ' ' + line.trim() // a wrapped or nested line
    else if (bullets.length) break // the paragraph after the list
  }
  return bullets.map((b) => {
    const lead = /^\*\*(.+?)\*\*\s*(.*)$/.exec(b.trim())
    const title = plain(lead ? lead[1] : b).replace(/[.:]\s*$/, '')
    const text = lead ? plain(lead[2]) : ''
    return { title, text, screen: noteScreen(`${title} ${text}`) }
  })
}
