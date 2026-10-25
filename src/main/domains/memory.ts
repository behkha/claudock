import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MemoryFileContent, MemoryFileInfo, MemoryGroup } from '@shared/api/memory'
import { joinFrontmatter, parseFrontmatter, splitFrontmatter } from '@shared/frontmatter'
import { assertUnchangedOnDisk, readText, stat } from '../fsx'
import { defineDomain } from '../ipcx'
import { configDir, resolveInside } from '../paths'
import { safeWriteText, trash, withFileLock } from '../safeWrite'
import { listProjectSummaries, readHead } from './projects'

/** Memory files: projects/<project>/memory/*.md. MEMORY.md is the index of a project's memory. */

const INDEX = 'MEMORY.md'
const memoryDir = (projectId: string): string => path.join(configDir(), 'projects', projectId, 'memory')

/** Validate a renderer path: must be projects/<project>/memory/<file>.md. */
function memoryPath(rel: string): { abs: string; projectId: string; file: string } {
  const abs = resolveInside(rel)
  const parts = path.relative(configDir(), abs).split(path.sep)
  if (parts.length !== 4 || parts[0] !== 'projects' || parts[2] !== 'memory' || !parts[3].toLowerCase().endsWith('.md')) {
    throw new Error('This is not a memory file')
  }
  return { abs, projectId: parts[1], file: parts[3] }
}

/* ------------------------------------------------------------------ frontmatter fields */

export interface MemoryFields {
  name: string
  description: string
  type: string
}

const TYPE_LINE = /^([ \t]*)type:[ \t]*(.*)$/

function typeOf(raw: string | null): string {
  if (raw === null) return ''
  for (const line of raw.split(/\r?\n/)) {
    const m = TYPE_LINE.exec(line)
    if (m) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

export function memoryFields(text: string): MemoryFields & { hasFrontmatter: boolean; body: string } {
  const fm = parseFrontmatter(text)
  const s = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(', ') : (v ?? ''))
  return {
    name: s(fm.data.name),
    description: s(fm.data.description),
    type: typeOf(fm.raw) || s(fm.data.type),
    hasFrontmatter: fm.raw !== null,
    body: fm.body
  }
}

function yamlValue(v: string): string {
  const plain = /^[A-Za-z0-9][^:#"'[\]{}&*!|>%@`\n]*$/.test(v) && !/\s$/.test(v) && !/^(true|false|null|yes|no|on|off|\d+)$/i.test(v)
  return plain ? v : JSON.stringify(v)
}

const indentOf = (l: string): number => /^[ \t]*/.exec(l)![0].length

/** Replace `key: value` (and its continuation lines) with a one-line value. Returns false when the key is absent. */
function replaceKey(lines: string[], key: string, value: string, anyIndent: boolean): boolean {
  const re = new RegExp(`^([ \\t]*)${key}:(.*)$`)
  const i = lines.findIndex((l) => {
    const m = re.exec(l)
    return !!m && (anyIndent || m[1].length === 0)
  })
  if (i < 0) return false
  const ind = indentOf(lines[i])
  let j = i + 1
  while (j < lines.length) {
    if (lines[j].trim() === '') {
      let k = j + 1
      while (k < lines.length && lines[k].trim() === '') k++
      if (k < lines.length && indentOf(lines[k]) > ind) j = k + 1
      else break
    } else if (indentOf(lines[j]) > ind) j++
    else break
  }
  lines.splice(i, j - i, `${' '.repeat(ind)}${key}: ${yamlValue(value)}`)
  return true
}

/** Apply changed fields to the raw frontmatter text; lines of other keys stay exactly as they were. */
export function applyFields(raw: string | null, before: MemoryFields, after: MemoryFields): string | null {
  if (raw === null && !after.name && !after.description && !after.type) return null
  const lines = raw === null ? [] : raw.split(/\r?\n/)
  for (const key of ['name', 'description', 'type'] as const) {
    if (after[key] === before[key]) continue
    if (replaceKey(lines, key, after[key], key === 'type')) continue
    if (!after[key]) continue
    if (key === 'type') {
      const meta = lines.findIndex((l) => /^metadata:\s*$/.test(l))
      if (meta >= 0) lines.splice(meta + 1, 0, `  type: ${yamlValue(after.type)}`)
      else lines.push(`type: ${yamlValue(after.type)}`)
    } else if (key === 'name') {
      lines.unshift(`name: ${yamlValue(after.name)}`)
    } else {
      const n = lines.findIndex((l) => /^name:/.test(l))
      lines.splice(n >= 0 ? n + 1 : 0, 0, `description: ${yamlValue(after.description)}`)
    }
  }
  return lines.join('\n')
}

/** True when most line breaks in the text are CRLF. */
function usesCrlf(text: string): boolean {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  return crlf > lf
}

/* ------------------------------------------------------------------ index links */

const linkRe = (file: string): RegExp => {
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const enc = encodeURI(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\]\\(\\s*(?:\\./)?(?:${esc}|${enc})(?:#[^)]*)?\\s*\\)`)
}

const isIndexed = (indexText: string, file: string): boolean => {
  const re = linkRe(file)
  return indexText.split(/\r?\n/).some((l) => re.test(l))
}

/* ------------------------------------------------------------------ listing */

async function projectFiles(projectId: string): Promise<MemoryFileInfo[]> {
  const dir = memoryDir(projectId)
  let names: string[]
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const files = await Promise.all(
    names.map(async (file): Promise<MemoryFileInfo | null> => {
      const abs = path.join(dir, file)
      const st = await stat(abs)
      if (!st || !st.isFile) return null
      const head = await readHead(abs, 4096)
      const f = memoryFields(head)
      const isIndex = file === INDEX
      return {
        rel: path.join('projects', projectId, 'memory', file),
        file,
        isIndex,
        title: isIndex ? 'MEMORY.md' : f.name || file.replace(/\.md$/i, ''),
        description: isIndex ? 'Index of this project’s memory' : f.description,
        type: isIndex ? 'index' : f.type,
        bytes: st.size,
        mtimeMs: st.mtimeMs
      }
    })
  )
  return files
    .filter((f): f is MemoryFileInfo => f !== null)
    .sort((a, b) => Number(b.isIndex) - Number(a.isIndex) || a.title.localeCompare(b.title))
}

export async function listMemoryFiles(): Promise<MemoryGroup[]> {
  const projects = (await listProjectSummaries()).filter((p) => p.hasMemory)
  const groups = await Promise.all(
    projects.map(async (p): Promise<MemoryGroup> => ({
      projectId: p.id,
      projectName: p.name,
      projectPath: p.path,
      files: await projectFiles(p.id)
    }))
  )
  return groups.filter((g) => g.files.length > 0).sort((a, b) => a.projectName.localeCompare(b.projectName))
}

/* ------------------------------------------------------------------ domain */

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'memory', {
    list: () => listMemoryFiles(),

    async read(rel: string): Promise<MemoryFileContent> {
      const { abs, projectId, file } = memoryPath(rel)
      const [raw, st] = await Promise.all([readText(abs), stat(abs)])
      const text = raw.replace(/^\uFEFF/, '')
      const f = memoryFields(text)
      let indexed = false
      if (file !== INDEX) {
        try {
          indexed = isIndexed(await readText(path.join(memoryDir(projectId), INDEX)), file)
        } catch {
          /* no index */
        }
      }
      return { rel, text, mtimeMs: st?.mtimeMs ?? 0, ...f, indexed }
    },

    async save(rel: string, fields: MemoryFields, body: string, expectedMtimeMs: number) {
      const { abs, file } = memoryPath(rel)
      return withFileLock(rel, async () => {
        await assertUnchangedOnDisk(abs, expectedMtimeMs, file)
        const current = (await readText(abs)).replace(/^\uFEFF/, '')
        const { raw } = splitFrontmatter(current)
        const before = memoryFields(current)
        const after: MemoryFields = {
          name: fields.name.trim(),
          description: fields.description.replace(/\s+/g, ' ').trim(),
          type: fields.type.trim()
        }
        const newRaw = file === INDEX ? raw : applyFields(raw, before, after)
        let text = joinFrontmatter(newRaw, body).replace(/\r\n/g, '\n')
        if (!text.endsWith('\n')) text += '\n'
        // keep the file's own line endings throughout (frontmatter and body), not a mix
        if (usesCrlf(current)) text = text.replace(/\n/g, '\r\n')
        await safeWriteText(rel, text, `Edit memory file ${file}`)
        return { mtimeMs: (await stat(abs))?.mtimeMs ?? Date.now() }
      })
    },

    async trash(rel: string, removeFromIndex: boolean) {
      const { abs, projectId, file } = memoryPath(rel)
      if (removeFromIndex && file !== INDEX) {
        const indexRel = path.join('projects', projectId, 'memory', INDEX)
        const indexAbs = resolveInside(indexRel)
        let text: string | null = null
        try {
          text = await readText(indexAbs)
        } catch {
          /* no index file */
        }
        if (text !== null) {
          const re = linkRe(file)
          const kept = text.split('\n').filter((l) => !re.test(l))
          if (kept.length !== text.split('\n').length) await safeWriteText(indexRel, kept.join('\n'), `Remove ${file} from MEMORY.md`)
        }
      }
      if (!(await stat(abs))) throw new Error('This memory file no longer exists')
      await trash(rel)
    }
  })
}

export async function count(): Promise<number> {
  try {
    const projects = await listProjectSummaries()
    const counts = await Promise.all(
      projects
        .filter((p) => p.hasMemory)
        .map(async (p) => {
          try {
            return (await fsp.readdir(memoryDir(p.id))).filter((n) => n.toLowerCase().endsWith('.md')).length
          } catch {
            return 0
          }
        })
    )
    return counts.reduce((a, b) => a + b, 0)
  } catch {
    return 0
  }
}
