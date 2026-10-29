import path from 'node:path'
import type { TranscriptEntry } from '@shared/api/projects'
import { entriesFromLine, type Json } from '../transcripts/parse.ts'

/**
 * The pure parts of the session archive (src/main/domains/archive.ts): what a transcript line adds to a session's facts
 * and to its search text, matching a query, the Markdown export and the resume command. No Electron here, so `npm test`
 * loads it as is.
 */

/* ------------------------------------------------------------------ facts */

/** What the archive knows about a session from its transcript, built up line by line. */
export interface Facts {
  /** First real prompt, one line, at most 160 characters. */
  prompt: string
  /** Claude Code's own name for it: the newest custom-title, else the newest agent-name. */
  name: string | null
  agent: string | null
  cwd: string | null
  startMs: number | null
  endMs: number | null
  /** Prompts plus Claude's replies. */
  messages: number
}

export const emptyFacts = (): Facts => ({ prompt: '', name: null, agent: null, cwd: null, startMs: null, endMs: null, messages: 0 })

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The title a session shows: its name in Claude Code, else its first prompt. */
export const titleOf = (f: Facts): string => f.name ?? f.agent ?? f.prompt

/** Longest search text kept per entry: a reply longer than this is rare and its start is what people remember. */
const TEXT_LINE_CAP = 20_000

/**
 * Fold one transcript line (starting at byte `offset`) into `facts`, and return its search lines: `<offset>\t<u|a>\t<text>`,
 * one per prompt or reply, each on one line. Tool calls, tool output, thinking and slash commands are not searched.
 */
export function foldLine(facts: Facts, o: Json, offset: number): string[] {
  if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) facts.name = oneLine(o.customTitle).slice(0, 160)
  if (o.type === 'agent-name' && typeof o.agentName === 'string' && o.agentName.trim()) facts.agent = oneLine(o.agentName).slice(0, 160)
  if (facts.cwd === null && typeof o.cwd === 'string' && o.cwd) facts.cwd = o.cwd
  const entries = entriesFromLine(o, String(offset))
  if (entries.length === 0) return []
  if (o.isSidechain !== true && typeof o.timestamp === 'string') {
    const ms = Date.parse(o.timestamp)
    if (Number.isFinite(ms)) {
      facts.startMs = facts.startMs === null ? ms : Math.min(facts.startMs, ms)
      facts.endMs = facts.endMs === null ? ms : Math.max(facts.endMs, ms)
    }
  }
  const out: string[] = []
  for (const e of entries) {
    if (e.kind !== 'user' && e.kind !== 'assistant') continue
    facts.messages++
    const text = oneLine(e.text).slice(0, TEXT_LINE_CAP)
    if (e.kind === 'user' && !facts.prompt) facts.prompt = text.slice(0, 160)
    if (text) out.push(`${offset}\t${e.kind === 'user' ? 'u' : 'a'}\t${text}`)
  }
  return out
}

/* ------------------------------------------------------------------ search */

/** Up to 8 lower-cased words of a query; "quoted words" stay together. */
export function queryTerms(q: string): string[] {
  const out: string[] = []
  for (const m of q.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim()
    if (t && !out.includes(t)) out.push(t)
    if (out.length === 8) break
  }
  return out
}

export interface TextHit {
  snippet: string
  marks: Array<[number, number]>
  /** Byte offset of the transcript line the hit is in; -1 when only the title matched. */
  offset: number
  /** Lines with at least one of the words. */
  count: number
}

const SNIPPET = 160
const LEAD = 48

/** Where each term occurs in `text` (lower-cased already), merged into sorted, non-overlapping ranges. */
function marksIn(lower: string, terms: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const t of terms) for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) ranges.push([i, i + t.length])
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Array<[number, number]> = []
  for (const r of ranges) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/** The part of `text` around its first match, cut at word boundaries, with the matches marked. */
export function snippetOf(text: string, terms: string[]): { snippet: string; marks: Array<[number, number]> } {
  const lower = text.toLowerCase()
  const first = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0))
  let start = Number.isFinite(first) ? Math.max(0, first - LEAD) : 0
  if (start > 0) {
    const space = text.indexOf(' ', start)
    if (space >= 0 && space < first) start = space + 1
  }
  let end = Math.min(text.length, start + SNIPPET)
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space > first) end = space
  }
  const pre = start > 0 ? '…' : ''
  const snippet = pre + text.slice(start, end) + (end < text.length ? '…' : '')
  const marks = marksIn(snippet.toLowerCase(), terms)
  return { snippet, marks }
}

/**
 * Match `terms` against a session: every term must occur in its title or its search text (the lines `foldLine` wrote).
 * The snippet comes from the line holding the most terms (the first of those). Null when some term is missing.
 */
export function matchSession(title: string, text: string, terms: string[]): TextHit | null {
  if (terms.length === 0) return null
  const seen = new Set(terms.filter((t) => title.toLowerCase().includes(t)))
  let best: { line: string; offset: number; n: number } | null = null
  let count = 0
  for (const line of text.split('\n')) {
    const tab2 = line.indexOf('\t', line.indexOf('\t') + 1)
    if (tab2 < 0) continue
    const body = line.slice(tab2 + 1)
    const lower = body.toLowerCase()
    let n = 0
    for (const t of terms)
      if (lower.includes(t)) {
        n++
        seen.add(t)
      }
    if (n === 0) continue
    count++
    if (!best || n > best.n) best = { line: body, offset: Number(line.slice(0, line.indexOf('\t'))), n }
  }
  if (seen.size < terms.length) return null
  if (!best) return { ...snippetOf(title, terms), offset: -1, count: 0 }
  return { ...snippetOf(best.line, terms), offset: Number.isFinite(best.offset) ? best.offset : -1, count }
}

/* ------------------------------------------------------------------ Markdown */

export interface MarkdownHead {
  title: string
  cwd: string | null
  id: string
  /** "29 Oct 2026, 14:02 – 15:40", already formatted. */
  when: string
}

/** A transcript as Markdown: prompts and replies in full, each tool call and slash command as one line. */
export function toMarkdown(head: MarkdownHead, entries: TranscriptEntry[], time: (ts: string) => string): string {
  const out: string[] = [`# ${oneLine(head.title) || 'Untitled session'}`, '']
  const facts = [head.cwd ? `\`${head.cwd}\`` : '', head.when, `session \`${head.id}\``].filter(Boolean)
  out.push(facts.join(' · '), '')
  let inList = false
  for (const e of entries) {
    const at = e.ts ? time(e.ts) : ''
    if (e.kind === 'user' || e.kind === 'assistant') {
      if (inList) out.push('')
      inList = false
      out.push(`## ${e.kind === 'user' ? 'You' : 'Claude'}${at ? ` · ${at}` : ''}`, '', e.text.trim(), '')
    } else if (e.kind === 'tool_use' || e.kind === 'command') {
      const line = e.kind === 'command' ? `- \`${oneLine(e.text)}\`` : `- ${e.name ?? 'tool'}${e.summary ? `: \`${oneLine(e.summary).replace(/`/g, "'")}\`` : ''}`
      out.push(line)
      inList = true
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/* ------------------------------------------------------------------ resume */

const SAFE = /^[A-Za-z0-9._/@%+=:,-]+$/

/** A folder for a POSIX shell: `~/code/app` inside the home folder when it needs no quoting, else quoted. */
function shellFolder(dir: string, home: string): string {
  const rel = path.posix.relative(home, dir)
  if (rel === '') return '~'
  const inHome = !rel.startsWith('..') && !path.posix.isAbsolute(rel)
  if (inHome && SAFE.test(rel)) return `~/${rel}`
  if (inHome && !/["\\$`]/.test(rel)) return `"$HOME/${rel}"`
  return SAFE.test(dir) ? dir : `'${dir.replace(/'/g, `'\\''`)}'`
}

/**
 * The command that resumes a session from anywhere: into its folder, then Claude Code on the profile's folder
 * (`start`, from `startCommand` in src/main/profiles/model.ts) with `--resume`. PowerShell on Windows.
 */
export function resumeCommand(cwd: string | null, sessionId: string, start: string, opts: { home: string; windows: boolean }): string {
  const resume = `${start} --resume ${sessionId}`
  if (!cwd) return resume
  if (opts.windows) return `cd '${cwd.replace(/'/g, "''")}'; ${resume}`
  return `cd ${shellFolder(cwd, opts.home)} && ${resume}`
}

/* ------------------------------------------------------------------ keys */

/** `<project folder>/<session id>`, the archive's key for a session. */
export const keyOf = (projectId: string, sessionId: string): string => `${projectId}/${sessionId}`

export function splitKey(key: unknown): { projectId: string; sessionId: string } | null {
  if (typeof key !== 'string') return null
  const i = key.lastIndexOf('/')
  if (i <= 0 || i === key.length - 1) return null
  return { projectId: key.slice(0, i), sessionId: key.slice(i + 1) }
}

