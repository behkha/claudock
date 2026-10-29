import fsp from 'node:fs/promises'
import path from 'node:path'
import { iterLines, parseLine } from '../transcripts/parse.ts'
import { msgOf, promptOf, type Msg, type Prompt, type ScannedFile } from './week.ts'

/**
 * Reading transcripts for the week card, incrementally: every file changed since `from` is read once, then only what
 * Claude Code appends. A file's messages are all kept (not just those after `from`), so stepping back to an earlier
 * week only reads the files it didn't read before. Roots are a profile's config folder and its session archive: a file
 * the archive holds as a hard link or a copy of one Claude Code still has is read once, from Claude Code's folder. Only
 * lines that can hold usage or a prompt are parsed, and a message written as several lines is kept once. No Electron here.
 */

interface FileScan extends ScannedFile {
  /** Device and inode: another file renamed over this path is read from the start. */
  id: string
  size: number
  mtimeMs: number
  /** Bytes read so far, always at a line start. */
  offset: number
  msgs: Msg[]
  prompts: Prompt[]
}

export interface Scans {
  files: Map<string, FileScan>
  /** Every file changed since this time has been read. */
  from: number
  /** When the oldest transcript was created (else last changed): no week before its week has anything. */
  oldest: number | null
}

export const emptyScans = (): Scans => ({ files: new Map(), from: Infinity, oldest: null })

interface Listed {
  abs: string
  id: string
  size: number
  mtimeMs: number
  /** A session's own file; sub-agents' files hold no prompts of yours. */
  main: boolean
}

/**
 * `<root>/projects/<project>/<id>.jsonl` and `<project>/<id>/subagents/*.jsonl`, the first root first; symlinks
 * skipped. A later root's file is left out when an earlier root has the same path under projects/ (the archive's copy
 * of a file Claude Code still has) or the same file (a hard link).
 */
async function list(roots: string[]): Promise<{ files: Listed[]; oldest: number | null }> {
  const files: Listed[] = []
  const inodes = new Set<string>()
  const paths = new Set<string>()
  let oldest: number | null = null
  const add = async (abs: string, rel: string, main: boolean, first: boolean): Promise<void> => {
    if (!first && paths.has(rel)) return
    // bigint: a file id above 2^53 (NTFS) would lose precision as a number and two files could look like one
    const st = await fsp.lstat(abs, { bigint: true }).catch(() => null)
    if (!st?.isFile()) return
    const id = `${st.dev}:${st.ino}`
    if (inodes.has(id)) return
    inodes.add(id)
    paths.add(rel)
    const mtimeMs = Number(st.mtimeMs)
    const born = st.birthtimeMs > 0n ? Math.min(Number(st.birthtimeMs), mtimeMs) : mtimeMs
    oldest = oldest === null ? born : Math.min(oldest, born)
    files.push({ abs, id, size: Number(st.size), mtimeMs, main })
  }
  for (const [i, root] of roots.entries()) {
    const projects = path.join(root, 'projects')
    for (const p of await fsp.readdir(projects, { withFileTypes: true }).catch(() => [])) {
      if (!p.isDirectory()) continue
      const dir = path.join(projects, p.name)
      for (const it of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (it.isFile() && it.name.endsWith('.jsonl')) await add(path.join(dir, it.name), path.join(p.name, it.name), true, i === 0)
        else if (it.isDirectory()) {
          const sub = path.join(dir, it.name, 'subagents')
          for (const a of await fsp.readdir(sub).catch(() => [] as string[]))
            if (a.endsWith('.jsonl')) await add(path.join(sub, a), path.join(p.name, it.name, 'subagents', a), false, i === 0)
        }
      }
    }
  }
  return { files, oldest }
}

const USAGE = Buffer.from('"usage"')
const ASSISTANT = Buffer.from('"assistant"')
const USER = Buffer.from('"type":"user"')
const RESULT = Buffer.from('"tool_use_id"')

/** Read from `scan.offset`, adding messages and prompts; returns the offset after the last whole line. */
async function readFrom(abs: string, scan: FileScan, main: boolean): Promise<number> {
  const fh = await fsp.open(abs, 'r')
  let offset = scan.offset
  try {
    for await (const l of iterLines(fh, scan.offset)) {
      const line = l.line
      // a last line without a newline counts once it is whole (it parses); one still being written is read next time
      if (l.open && (line === null || parseLine(line) === null)) break
      const wanted = line !== null && ((line.includes(USAGE) && line.includes(ASSISTANT)) || (main && line.includes(USER) && !line.includes(RESULT)))
      const o = wanted ? parseLine(line) : null
      if (o) {
        const m = msgOf(o)
        // Claude Code writes a message as one line per content block, each with the same usage
        if (m) {
          if (scan.msgs[scan.msgs.length - 1]?.key !== m.key) scan.msgs.push(m)
        } else if (main) {
          const p = promptOf(o)
          if (p) scan.prompts.push(p)
        }
      }
      offset = l.end
    }
  } finally {
    await fh.close()
  }
  return offset
}

/** Bring `s` up to date with every transcript under `roots` changed since `from` (or the earlier time it already covers). */
export async function scanSince(s: Scans, roots: string[], from: number): Promise<void> {
  const since = Math.min(s.from, from)
  const { files, oldest } = await list(roots)
  const keep = new Set<string>()
  for (const f of files) {
    if (f.mtimeMs < since) continue
    keep.add(f.abs)
    let c = s.files.get(f.abs)
    if (c && c.id === f.id && c.size === f.size && c.mtimeMs === f.mtimeMs) continue
    // another file, shrunk or rewritten in place: read it all again; grown: read only what was appended
    if (!c || c.id !== f.id || f.size < c.offset || (f.size === c.size && f.mtimeMs !== c.mtimeMs)) c = { id: f.id, size: 0, mtimeMs: 0, offset: 0, msgs: [], prompts: [] }
    try {
      c.offset = await readFrom(f.abs, c, f.main)
      c.size = f.size
      c.mtimeMs = f.mtimeMs
      s.files.set(f.abs, c)
    } catch {
      s.files.delete(f.abs)
    }
  }
  for (const k of s.files.keys()) if (!keep.has(k)) s.files.delete(k)
  s.from = since
  s.oldest = oldest
}
