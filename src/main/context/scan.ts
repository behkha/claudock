import fsp from 'node:fs/promises'
import path from 'node:path'
import { iterLines, parseLine } from '../transcripts/parse.ts'
import { emptyRecords, foldRecord, mcpCalls, type Records } from './model.ts'

/**
 * Reading transcripts for the Context screen, incrementally: a file is read from where the last read stopped, so a
 * live session costs only what it appended. No Electron here, so `npm test` (and a quick timing script) load it as is.
 */

export interface FileInfo {
  abs: string
  size: number
  mtimeMs: number
}

/**
 * Main transcripts (`projects/<p>/<id>.jsonl`) and, with `subagents`, the sub-agent ones, changed since `since`,
 * newest first. Symlinks are skipped (Claude Code never makes them), so a link can never lead a read elsewhere.
 */
export async function transcripts(dir: string, since: number, subagents: boolean): Promise<FileInfo[]> {
  const root = path.join(dir, 'projects')
  const out: FileInfo[] = []
  const add = async (abs: string): Promise<void> => {
    const st = await fsp.lstat(abs).catch(() => null)
    if (st?.isFile() && st.mtimeMs >= since) out.push({ abs, size: st.size, mtimeMs: st.mtimeMs })
  }
  const projects = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const p of projects) {
    if (!p.isDirectory()) continue
    const pdir = path.join(root, p.name)
    const items = await fsp.readdir(pdir, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      items.map(async (it) => {
        if (it.isFile() && it.name.endsWith('.jsonl')) return add(path.join(pdir, it.name))
        if (!subagents || !it.isDirectory()) return
        const sub = path.join(pdir, it.name, 'subagents')
        const agents = await fsp.readdir(sub, { withFileTypes: true }).catch(() => [])
        await Promise.all(agents.filter((a) => a.isFile() && a.name.endsWith('.jsonl')).map((a) => add(path.join(sub, a.name))))
      })
    )
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** How far a file was read: grown means read on from `offset`, anything else from the start. */
interface Progress {
  size: number
  mtimeMs: number
  offset: number
}
const fresh = (p: Progress | undefined, f: FileInfo): boolean => !!p && p.size === f.size && p.mtimeMs === f.mtimeMs
const resumable = (p: Progress | undefined, f: FileInfo): boolean => !!p && f.size > p.size && f.size >= p.offset

export interface RecordsRead extends Progress {
  records: Records
  cwd: string | null
}

const RECORD = '"attachment":{"type":"'
const RECORD_TYPES = ['skill_listing"', 'deferred_tools_delta"', 'mcp_instructions_delta"', 'instructions"']

/** A transcript's records of its session's start, folded on from `prev` when the file only grew. */
export async function readRecords(f: FileInfo, prev?: RecordsRead): Promise<RecordsRead> {
  if (prev && fresh(prev, f)) return prev
  const r: RecordsRead = prev && resumable(prev, f) ? prev : { size: 0, mtimeMs: 0, offset: 0, records: emptyRecords(), cwd: null }
  const fh = await fsp.open(f.abs, 'r')
  try {
    for await (const { line, end, open } of iterLines(fh, r.offset)) {
      // a line still being written is read again next time
      if (open) break
      r.offset = end
      if (!line) continue
      const at = line.indexOf(RECORD)
      const record = at >= 0 && RECORD_TYPES.some((t) => line.includes(t, at + RECORD.length))
      if (!record && r.cwd !== null) continue
      if (!record && !line.includes('"cwd"')) continue
      const o = parseLine(line)
      if (!o) continue
      if (r.cwd === null && typeof o.cwd === 'string' && o.cwd) r.cwd = o.cwd
      if (record) foldRecord(r.records, o)
    }
  } finally {
    await fh.close()
  }
  r.size = f.size
  r.mtimeMs = f.mtimeMs
  return r
}

export interface CallsRead extends Progress {
  calls: { key: string; id: string; t: number }[]
}

const CALL = Buffer.from('"name":"mcp__')
const CHUNK = 4 * 1024 * 1024
/** A line longer than this is skipped, like iterLines does. */
const MAX_LINE = 16 * 1024 * 1024

/**
 * The MCP tool calls in a transcript, read on from `prev` when the file only grew. Only the lines that hold
 * `"name":"mcp__` are parsed: the rest of a multi-GB folder is searched as bytes.
 */
export async function readCalls(f: FileInfo, prev?: CallsRead): Promise<CallsRead> {
  if (prev && fresh(prev, f)) return prev
  const r: CallsRead = prev && resumable(prev, f) ? prev : { size: 0, mtimeMs: 0, offset: 0, calls: [] }
  const fh = await fsp.open(f.abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let carry: Buffer = Buffer.alloc(0)
    let pos = r.offset
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      const last = data.lastIndexOf(10)
      if (last < 0) {
        // no line end yet: keep it for the next chunk, unless the line is too long to bother with
        carry = data.length > MAX_LINE ? Buffer.alloc(0) : Buffer.from(data)
        if (carry.length === 0) r.offset = pos
        continue
      }
      const whole = data.subarray(0, last + 1)
      for (let hit = whole.indexOf(CALL); hit >= 0; ) {
        const start = whole.lastIndexOf(10, hit) + 1
        const end = whole.indexOf(10, hit)
        const o = parseLine(whole.subarray(start, end))
        if (o) {
          const t = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
          for (const call of mcpCalls(o)) r.calls.push({ ...call, t: Number.isFinite(t) ? t : f.mtimeMs })
        }
        hit = whole.indexOf(CALL, end + 1)
      }
      r.offset = pos - (data.length - whole.length)
      carry = Buffer.from(data.subarray(last + 1))
    }
  } finally {
    await fh.close()
  }
  r.size = f.size
  r.mtimeMs = f.mtimeMs
  return r
}
