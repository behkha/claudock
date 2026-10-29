import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * How the session archive keeps a transcript (src/main/domains/archive.ts): a hard link where the disk allows, so the
 * archive shares Claude Code's bytes and costs nothing until Claude Code deletes its file; else a copy, kept up to date
 * by appending what Claude Code appended. Plain Node, so `npm test` checks both ways on real files.
 */

export type HoldMode = 'link' | 'copy'

/** Errors that mean "no hard links here" (another disk, FAT, a network share), not "something is wrong". */
const NO_LINKS = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS', 'EINVAL'])

const tmpBeside = (file: string): string => path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString('hex')}.tmp`)

/** The last `n` bytes of `file` before offset `end`. */
async function bytesBefore(file: string, end: number, n: number): Promise<Buffer> {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(n, end))
    const { bytesRead } = await fh.read(buf, 0, buf.length, end - buf.length)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** `a` (of `aSize` bytes) is the start of `b`: no bigger, and its last 4 KB are the same bytes at the same place. */
async function isPrefix(a: string, aSize: number, b: string, bSize: number): Promise<boolean> {
  if (aSize > bSize) return false
  if (aSize === 0) return true
  const n = Math.min(4096, aSize)
  const [x, y] = await Promise.all([bytesBefore(a, aSize, n), bytesBefore(b, aSize, n)])
  return x.equals(y)
}

/** `<name>.<ms>.<ext>` beside `file`: where a version only the archive has is kept. */
function aside(file: string, ms: number): string {
  const ext = path.extname(file)
  return path.join(path.dirname(file), `${path.basename(file, ext)}.${Math.round(ms)}${ext}`)
}

/** Append `live`'s bytes from `from` on to `held`. */
async function appendFrom(live: string, held: string, from: number): Promise<void> {
  const src = await fsp.open(live, 'r')
  const dst = await fsp.open(held, 'a')
  try {
    const buf = Buffer.allocUnsafe(256 * 1024)
    for (let pos = from; ; ) {
      const { bytesRead } = await src.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      await dst.write(buf, 0, bytesRead)
      pos += bytesRead
    }
  } finally {
    await src.close()
    await dst.close()
  }
}

/**
 * Make `held` hold `live`'s bytes and say how. Already the same file: nothing to do. Otherwise a new hard link replaces
 * `held` (Claude Code wrote a new file under the old name), unless this folder copies (`prev` 'copy', or linking fails
 * with a "no links here" error): then what Claude Code appended is appended, or the file is copied again when it changed
 * otherwise. A `held` that only the archive has and that the live file doesn't start with (an older copy put back over a
 * longer one) is first kept beside it as `<name>.<ms>.<ext>`. `link` is swappable for tests.
 */
export async function hold(live: string, held: string, prev: HoldMode | null, link: (a: string, b: string) => Promise<void> = fsp.link): Promise<HoldMode> {
  const ls = await fsp.lstat(live)
  if (!ls.isFile()) throw new Error(`Not a file: ${path.basename(live)}`)
  let hs = await fsp.lstat(held).catch(() => null)
  if (hs && hs.ino === ls.ino && hs.dev === ls.dev) return 'link'
  await fsp.mkdir(path.dirname(held), { recursive: true })
  const extended = !hs?.isFile() || (await isPrefix(held, hs.size, live, ls.size))
  if (hs?.isFile() && hs.nlink === 1 && !extended) {
    await fsp.rename(held, aside(held, hs.mtimeMs))
    hs = null
  }
  if (prev !== 'copy') {
    const tmp = tmpBeside(held)
    try {
      await link(live, tmp)
      await fsp.rename(tmp, held)
      return 'link'
    } catch (e) {
      await fsp.rm(tmp, { force: true })
      if (!NO_LINKS.has((e as NodeJS.ErrnoException).code ?? '')) throw e
    }
  }
  // a copy that is a prefix of the live file only needs what was appended since
  if (hs?.isFile() && hs.size > 0 && extended) {
    if (hs.size < ls.size) await appendFrom(live, held, hs.size)
    return 'copy'
  }
  const tmp = tmpBeside(held)
  try {
    await fsp.copyFile(live, tmp)
    await fsp.rename(tmp, held)
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    throw e
  }
  return 'copy'
}

const MAX_TREE_FILES = 5000

/**
 * `hold` every file below `liveDir` (a session's folder of sub-agent transcripts and tool output) at the same place
 * below `heldDir`. Symlinks and what `skip` names are left out. Returns how the files are held, or null when there were none.
 */
export async function holdTree(
  liveDir: string,
  heldDir: string,
  prev: HoldMode | null,
  skip: (abs: string) => boolean = () => false,
  link?: (a: string, b: string) => Promise<void>
): Promise<HoldMode | null> {
  let mode: HoldMode | null = null
  let files = 0
  const walk = async (rel: string): Promise<void> => {
    const ents = await fsp.readdir(path.join(liveDir, rel), { withFileTypes: true }).catch(() => [])
    for (const e of ents) {
      if (files >= MAX_TREE_FILES) return
      const r = path.join(rel, e.name)
      const abs = path.join(liveDir, r)
      if (e.isSymbolicLink() || skip(abs) || e.name.endsWith('.tmp')) continue
      if (e.isDirectory()) await walk(r)
      else if (e.isFile()) {
        files++
        const got = await hold(abs, path.join(heldDir, r), mode ?? prev, link).catch(() => null)
        if (got === 'copy' || mode === null) mode = got ?? mode
      }
    }
  }
  await walk('')
  return mode
}

/**
 * Let go of the archive's copy of a file or a folder. A file whose bytes are also somewhere else is removed: another hard
 * link to them (in Claude Code's folder, or in the Trash after a delete), or, for a copy, the live file `liveOf` names
 * when it starts with the same bytes. Returns the files only the archive has, for the caller to keep or send to the Trash.
 */
export async function unhold(held: string, liveOf: (heldAbs: string) => string | null = () => null): Promise<string[]> {
  const st = await fsp.lstat(held).catch(() => null)
  if (!st) return []
  if (st.isDirectory()) {
    const only: string[] = []
    for (const name of await fsp.readdir(held)) only.push(...(await unhold(path.join(held, name), liveOf)))
    await fsp.rmdir(held).catch(() => undefined) // only once it is empty
    return only
  }
  if (!st.isFile()) return [held]
  if (st.nlink > 1) {
    await fsp.rm(held)
    return []
  }
  const live = liveOf(held)
  const ls = live ? await fsp.lstat(live).catch(() => null) : null
  if (live && ls?.isFile() && (await isPrefix(held, st.size, live, ls.size))) {
    await fsp.rm(held)
    return []
  }
  return [held]
}
