import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { RuleDoc, RuleItem, RulesApi } from '@shared/api/rules'
import { splitFrontmatter } from '@shared/frontmatter'
import { RESERVED_NAME_ERROR, isReservedName } from '@shared/names'
import { listDir, matchEol, readText, stat } from '../fsx'
import { defineDomain } from '../ipcx'
import { assertNotSecretReal, assertWritable, configDir, resolveInside } from '../paths'
import { retryWhileLocked, safeWriteText, snapshot, trash } from '../safeWrite'

const ROOT_FILE = 'CLAUDE.md'
const RULES_DIR = 'rules'
const MAX_READ = 2 * 1024 * 1024
const HEAD_BYTES = 4096

/** Forward-slash id -> config-dir-relative path with OS separators. Throws for anything that is not CLAUDE.md or rules/**.md. */
function relOf(id: unknown): string {
  if (typeof id !== 'string') throw new Error('Unknown file')
  const norm = id.replace(/\\/g, '/')
  if (norm === ROOT_FILE) return ROOT_FILE
  const parts = norm.split('/')
  if (parts[0] !== RULES_DIR || parts.length < 2 || parts.length > 4 || !/\.md$/i.test(parts[parts.length - 1])) throw new Error('Unknown file')
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\0'))) throw new Error('Unknown file')
  return parts.join(path.sep)
}

const idOf = (rel: string): string => rel.split(path.sep).join('/')

function titleOf(text: string): string | null {
  const body = splitFrontmatter(text.replace(/^\uFEFF/, '')).body
  let firstLine: string | null = null
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
    if (h) return h[1].slice(0, 140)
    if (firstLine === null) firstLine = line.replace(/^[-*>\s]+/, '').replace(/[`*_]/g, '').slice(0, 140)
  }
  return firstLine || null
}

async function head(abs: string, size: number): Promise<string> {
  if (size === 0) return ''
  await assertNotSecretReal(abs)
  const fh = await fsp.open(abs, 'r')
  try {
    const buf = Buffer.alloc(Math.min(size, HEAD_BYTES))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

async function itemFor(rel: string): Promise<RuleItem> {
  const abs = resolveInside(rel)
  const st = await stat(abs)
  const id = idOf(rel)
  const isRoot = id === ROOT_FILE
  const fileName = path.basename(rel)
  const name = isRoot ? ROOT_FILE : id.slice(RULES_DIR.length + 1).replace(/\.md$/i, '')
  if (!st || !st.isFile) {
    return { id, kind: isRoot ? 'claude' : 'rule', fileName, name, title: null, size: 0, mtimeMs: 0, missing: true }
  }
  let title: string | null = null
  try {
    title = titleOf(await head(abs, st.size))
  } catch {
    /* unreadable: no subtitle */
  }
  return { id, kind: isRoot ? 'claude' : 'rule', fileName, name, title, size: st.size, mtimeMs: st.mtimeMs, missing: false }
}

/** rules/*.md and rules/<folder>/*.md (Claude Code reads nested rule folders too). */
export async function ruleRels(): Promise<string[]> {
  const out: string[] = []
  const walk = async (relDir: string, depth: number): Promise<void> => {
    for (const e of await listDir(resolveInside(relDir))) {
      if (e.secret) continue
      const rel = path.join(relDir, e.name)
      if (e.isFile && /\.md$/i.test(e.name)) out.push(rel)
      else if (e.isDir && depth < 2) await walk(rel, depth + 1)
    }
  }
  await walk(RULES_DIR, 0)
  return out
}

function cleanName(raw: unknown): string {
  let n = String(raw ?? '').trim().replace(/\.md$/i, '')
  if (!n) throw new Error('Give the rule a name')
  if (n.length > 80) throw new Error('Use a name under 80 characters')
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(n) || /[. ]$/.test(n)) {
    throw new Error('Use letters, numbers, spaces, dots, dashes and underscores, starting with a letter or number')
  }
  if (isReservedName(n)) throw new Error(RESERVED_NAME_ERROR)
  n = n.replace(/\s+/g, ' ')
  return n
}

async function taken(dirRel: string, fileName: string): Promise<boolean> {
  const lower = fileName.toLowerCase()
  return (await listDir(resolveInside(dirRel))).some((e) => e.name.toLowerCase() === lower)
}

/** Like `taken`, but ignoring the file being renamed itself. */
async function takenByOther(dirRel: string, fileName: string, self: string): Promise<boolean> {
  const lower = fileName.toLowerCase()
  return (await listDir(resolveInside(dirRel))).some((e) => e.name !== self && e.name.toLowerCase() === lower)
}

const impl: RulesApi = {
  async list() {
    const rels = [ROOT_FILE, ...(await ruleRels())]
    const items = await Promise.all(rels.map(itemFor))
    const [root, ...rules] = items
    rules.sort((a, b) => a.name.localeCompare(b.name))
    return [root, ...rules]
  },

  async read(id) {
    const rel = relOf(id)
    const abs = resolveInside(rel)
    const st = await stat(abs)
    if (!st || !st.isFile) return { id: idOf(rel), text: '', size: 0, mtimeMs: null, missing: true, path: abs }
    if (st.size > MAX_READ) throw new Error('This file is larger than 2 MB. Open it in your editor instead.')
    const doc: RuleDoc = { id: idOf(rel), text: await readText(abs), size: st.size, mtimeMs: st.mtimeMs, missing: false, path: abs }
    return doc
  },

  async save(id, text, expectedMtimeMs) {
    const rel = relOf(id)
    if (typeof text !== 'string') throw new Error('Nothing to save')
    assertWritable()
    const abs = resolveInside(rel)
    const st = await stat(abs)
    const current = st?.mtimeMs ?? null
    const same = current === expectedMtimeMs || (current !== null && expectedMtimeMs !== null && Math.abs(current - expectedMtimeMs) < 1)
    if (!same) throw new Error(`CHANGED_ON_DISK: ${path.basename(rel)} changed on disk since you opened it.`)
    const out = st?.isFile ? matchEol(await readText(abs), text) : text
    await safeWriteText(rel, out, `Edit ${idOf(rel)} in Claudock`)
    const after = await stat(abs)
    return { mtimeMs: after?.mtimeMs ?? 0 }
  },

  async create(name) {
    assertWritable()
    const clean = cleanName(name)
    const fileName = `${clean}.md`
    if (await taken(RULES_DIR, fileName)) throw new Error(`A rule called ${clean} already exists`)
    const heading = clean.replace(/[-_]+/g, ' ')
    const text = `# ${heading.charAt(0).toUpperCase()}${heading.slice(1)}\n\nSay when this applies, then list the rules.\n\n- \n`
    const rel = path.join(RULES_DIR, fileName)
    await safeWriteText(rel, text, `Create ${idOf(rel)} in Claudock`)
    return itemFor(rel)
  },

  async rename(id, newName) {
    assertWritable()
    const rel = relOf(id)
    if (idOf(rel) === ROOT_FILE) throw new Error('CLAUDE.md cannot be renamed')
    const clean = cleanName(newName)
    const dirRel = path.dirname(rel)
    const toRel = path.join(dirRel, `${clean}.md`)
    const from = resolveInside(rel)
    const to = resolveInside(toRel)
    if (from === to) return itemFor(rel)
    const fromSt = await fsp.lstat(from, { bigint: true }).catch(() => null)
    if (!fromSt || !fromSt.isFile()) throw new Error('That rule is no longer there')
    const exists = (): Error => new Error(`A rule called ${clean} already exists`)
    // Is the target name already a different file? (On a case-insensitive disk a case-only rename "finds" the file itself.)
    const toSt = await fsp.lstat(to, { bigint: true }).catch(() => null)
    const sameFile = !!toSt && toSt.ino !== 0n && toSt.dev === fromSt.dev && toSt.ino === fromSt.ino
    if (toSt && !sameFile) throw exists()
    if (!toSt && (await takenByOther(dirRel, `${clean}.md`, path.basename(from)))) throw exists()
    await snapshot([rel], `Rename ${idOf(rel)} to ${idOf(toRel)}`)
    if (sameFile) {
      // the same file under another spelling: the only way to change the case is rename, and it replaces nothing
      await retryWhileLocked(() => fsp.rename(from, to))
    } else {
      // hard link then unlink: unlike rename it fails instead of replacing a file that appeared a moment ago
      let linked = false
      try {
        await fsp.link(from, to)
        linked = true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw exists()
        // no hard links on this disk (FAT/exFAT, network shares report EPERM, ENOTSUP, EISDIR, EINVAL...): copy instead
      }
      if (!linked) {
        // exclusive copy: fails if the target exists
        try {
          await fsp.copyFile(from, to, fsp.constants.COPYFILE_EXCL)
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') throw exists()
          await fsp.unlink(to).catch(() => undefined) // a half-written copy of ours
          throw e2
        }
      }
      try {
        await retryWhileLocked(() => fsp.unlink(from))
      } catch (e) {
        // the original is locked (antivirus, an editor): undo, so the rule is not left under both names
        await fsp.unlink(to).catch(() => undefined)
        throw new Error(`Could not rename ${path.basename(from)}: it is in use (${(e as NodeJS.ErrnoException).code ?? 'error'}). Try again in a moment.`, { cause: e })
      }
    }
    return itemFor(toRel)
  },

  async trash(id) {
    const rel = relOf(id)
    if (idOf(rel) === ROOT_FILE) throw new Error('CLAUDE.md cannot be moved to the Trash')
    await trash(rel)
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'rules', impl)
}

/** Sidebar badge: number of rules plus CLAUDE.md when it has content. */
export async function count(): Promise<number> {
  const rel = await ruleRels()
  const root = await stat(path.join(configDir(), ROOT_FILE))
  return rel.length + (root?.isFile && root.size > 0 ? 1 : 0)
}
