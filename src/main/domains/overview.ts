import { BrowserWindow, ClipboardItem, app, clipboard, dialog, nativeImage, shell, type IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Finding, OverviewApi } from '@shared/api/overview'
import { formatBytes, formatCount } from '@shared/format'
import { shareText } from '@shared/wrapped'
import { readJson, stat } from '../fsx'
import { defineDomain, emit } from '../ipcx'
import { assertWritable, configDir, globalStateFile, isInside, isSecret, resolveInside, samePath } from '../paths'
import { safeWriteText, trash } from '../safeWrite'
import { scanLoose } from './backups'
import { scanUser } from './skills'
import { computeWrapped } from './overviewWrapped'
import { sizeOf } from './storage'

const MB = 1024 * 1024
const DAY = 86_400_000
/** Thresholds from the spec. */
const BIG_PROJECT = 500 * MB
const BIG_OFF_SKILL = 50 * MB
const BIG_FOLDER = 100 * MB
const BIG_LOG = 1 * MB
const OLD_BUILD_AGE = 30 * DAY

const rel = (...parts: string[]): string => path.join(...parts)
const abs = (...parts: string[]): string => path.join(configDir(), ...parts)

/* ------------------------------------------------------------------ findings */

/** Real working directory of a project folder: the `cwd` of the first transcript line that has one (head only). */
async function projectCwd(folderAbs: string): Promise<string | null> {
  try {
    const names = (await fsp.readdir(folderAbs)).filter((n) => n.endsWith('.jsonl'))
    for (const name of names.slice(0, 3)) {
      const fh = await fsp.open(path.join(folderAbs, name), 'r')
      try {
        const buf = Buffer.alloc(64 * 1024)
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
        const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, bytesRead))
        if (m) return JSON.parse(m[1]) as string
      } finally {
        await fh.close()
      }
    }
  } catch {
    /* unreadable: fall back to the folder name */
  }
  return null
}

const plural = (n: number, one: string, many = one + 's'): string => `${formatCount(n)} ${n === 1 ? one : many}`

type Push = (f: Finding) => void

async function bigProjects(push: Push, force?: boolean): Promise<void> {
  const projects = abs('projects')
  const names = await fsp.readdir(projects).catch(() => [] as string[])
  // one walk over projects/ fills the size cache; the per-folder lookups below are then cache hits
  await sizeOf(projects, { force })
  await Promise.all(
    names.map(async (name) => {
      const folder = path.join(projects, name)
      const st = await stat(folder)
      if (!st?.isDir) return
      const size = await sizeOf(folder)
      if (size.bytes < BIG_PROJECT) return
      const cwd = await projectCwd(folder)
      const label = cwd ? path.basename(cwd.replace(/[\\/]+$/, '')) || cwd : name
      push({
        id: `bigProject:${name}`,
        kind: 'bigProject',
        title: `${label} has ${formatBytes(size.bytes)} of transcripts`,
        detail: rel('projects', name),
        bytes: size.bytes,
        paths: [rel('projects', name)],
        action: { type: 'open', label: 'Open in Projects', screen: 'projects', selectId: name }
      })
    })
  )
}

async function offSkills(push: Push): Promise<void> {
  const settings = await readJson<{ skillOverrides?: Record<string, unknown> }>(abs('settings.json'))
  const overrides = settings?.skillOverrides
  if (!overrides || typeof overrides !== 'object') return
  // skillOverrides keys are skill NAMES (frontmatter `name`, which may differ from the folder). Map them to the user
  // skill folders with the Skills scanner, which already leaves out skills/synced, plugin skills and folders without a SKILL.md.
  const off = (await scanUser(overrides)).filter((s) => s.override === 'off' && !s.symlink)
  await Promise.all(
    off.map(async (skill) => {
      const folder = path.basename(skill.dir)
      const dir = abs('skills', folder)
      const st = await stat(dir)
      if (!st?.isDir) return // links are not ours to remove
      const size = await sizeOf(dir)
      if (size.bytes < BIG_OFF_SKILL) return
      push({
        id: `bigSkillOff:${folder}`,
        kind: 'bigSkillOff',
        title: `Skill "${skill.name}" is off but takes ${formatBytes(size.bytes)}`,
        detail: rel('skills', folder),
        bytes: size.bytes,
        paths: [rel('skills', folder)],
        action: {
          type: 'trash',
          label: 'Move to Trash',
          rels: [rel('skills', folder)],
          confirmTitle: `Move "${skill.name}" to Trash?`,
          confirmBody: `skills/${folder} (${formatBytes(size.bytes)}) goes to the Trash. You can put it back from there.`
        }
      })
    })
  )
}

async function oldDownloads(push: Push): Promise<void> {
  const dir = abs('downloads')
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  const files = (
    await Promise.all(
      names.map(async (name) => {
        const st = await stat(path.join(dir, name))
        return st?.isFile && !isSecret(name) && (/^claude[-_]/i.test(name) || st.size > 20 * MB) ? { name, size: st.size, mtimeMs: st.mtimeMs } : null
      })
    )
  )
    .filter((f): f is { name: string; size: number; mtimeMs: number } => f !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  // the newest build may be the one in use; the rest, and anything over 30 days old, is a leftover installer
  const now = Date.now()
  const old = files.filter((f, i) => i > 0 || now - f.mtimeMs > OLD_BUILD_AGE)
  if (old.length === 0) return
  const bytes = old.reduce((n, f) => n + f.size, 0)
  push({
    id: 'oldDownload',
    kind: 'oldDownload',
    title: old.length === 1 ? 'Old CLI build in downloads/' : `${old.length} old CLI builds in downloads/`,
    detail: old.map((f) => f.name).join(', '),
    bytes,
    paths: old.map((f) => rel('downloads', f.name)),
    action: {
      type: 'trash',
      label: 'Move to Trash',
      rels: old.map((f) => rel('downloads', f.name)),
      confirmTitle: old.length === 1 ? 'Move this build to Trash?' : `Move ${old.length} builds to Trash?`,
      confirmBody: `${old.map((f) => f.name).join(', ')} (${formatBytes(bytes)}). Claude Code downloads a new one when it updates.`
    }
  })
}

async function looseBackups(push: Push): Promise<void> {
  const loose = (await scanLoose()).filter((l) => l.location === 'root' && !l.hidden)
  if (loose.length === 0) return
  const bytes = loose.reduce((n, l) => n + l.size, 0)
  const names = loose.map((l) => l.name)
  push({
    id: 'looseBackups',
    kind: 'looseBackups',
    title: `${plural(loose.length, 'loose backup file')} in the root`,
    detail: names.slice(0, 3).join(', ') + (names.length > 3 ? ` and ${names.length - 3} more` : ''),
    bytes,
    paths: loose.map((l) => l.rel),
    action: { type: 'tidy', label: 'Tidy into backups/', rels: loose.map((l) => l.rel) }
  })
}

async function bigLogs(push: Push): Promise<void> {
  const names = await fsp.readdir(configDir()).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((n) => /\.log$/i.test(n) && !isSecret(n))
      .map(async (name) => {
        const st = await stat(abs(name))
        if (!st?.isFile || st.size <= BIG_LOG) return
        push({
          id: `bigLog:${name}`,
          kind: 'bigLog',
          title: `${name} has grown to ${formatBytes(st.size)}`,
          detail: name,
          bytes: st.size,
          paths: [name],
          action: {
            type: 'clearLog',
            label: 'Clear log',
            rel: name,
            confirmTitle: `Clear ${name}?`,
            confirmBody: `A snapshot of the current ${formatBytes(st.size)} is kept in Backups, then the file is emptied.`
          }
        })
      })
  )
}

async function emptyClaudeMd(push: Push): Promise<void> {
  const st = await stat(abs('CLAUDE.md'))
  if (!st?.isFile) return
  let empty = st.size === 0
  if (!empty && st.size <= 4096) empty = (await fsp.readFile(abs('CLAUDE.md'), 'utf8')).trim() === ''
  if (!empty) return
  push({
    id: 'emptyClaudeMd',
    kind: 'emptyClaudeMd',
    title: 'CLAUDE.md is empty',
    detail: 'CLAUDE.md',
    paths: ['CLAUDE.md'],
    action: { type: 'open', label: 'Open CLAUDE.md', screen: 'rules', selectId: 'CLAUDE.md' }
  })
}

async function bigFolders(push: Push, force?: boolean): Promise<void> {
  await Promise.all(
    ['file-history', 'shell-snapshots', 'debug'].map(async (name) => {
      const st = await stat(abs(name))
      if (!st?.isDir) return
      const size = await sizeOf(abs(name), { force })
      if (size.bytes < BIG_FOLDER) return
      push({
        id: `bigFolder:${name}`,
        kind: 'bigFolder',
        title: `${name}/ holds ${formatBytes(size.bytes)}`,
        detail: `${name}/ · ${plural(size.files, 'file')}`,
        bytes: size.bytes,
        paths: [name],
        action: { type: 'open', label: 'Open in Storage', screen: 'storage', selectId: name }
      })
    })
  )
}

async function computeFindings(scanId: string, force?: boolean): Promise<Finding[]> {
  const found: Finding[] = []
  const push: Push = (f) => {
    found.push(f)
    emit('overview:finding', { scanId, finding: f })
  }
  const tasks = [bigFolders(push, force), looseBackups(push), bigLogs(push), emptyClaudeMd(push), oldDownloads(push), offSkills(push), bigProjects(push, force)]
  // one failing check must not hide the others
  await Promise.all(tasks.map((t) => t.catch(() => undefined)))
  return found.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.title.localeCompare(b.title))
}

/* ------------------------------------------------------------------ share card */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_PNG = 20 * MB
const X_INTENT = 'https://x.com/intent/post'

/** The renderer's bytes, checked: a real PNG, not empty, at most 20 MB. */
function pngBuffer(v: unknown): Buffer {
  if (!ArrayBuffer.isView(v)) throw new Error('No image')
  const buf = Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  if (buf.length === 0 || buf.length > MAX_PNG) throw new Error('The image is empty or larger than 20 MB')
  if (!PNG_MAGIC.every((b, i) => buf[i] === b)) throw new Error('The image is not a PNG')
  return buf
}

/** Electron 45 has no sync `writeImage`: the clipboard takes ClipboardItems. The decode check keeps a broken PNG off it. */
async function copyPng(buf: Buffer): Promise<void> {
  if (nativeImage.createFromBuffer(buf).isEmpty()) throw new Error('The image could not be read')
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(buf)], { type: 'image/png' }) })])
}

/** The only external page the app opens on its own: the X compose page, with the text in the query. */
async function openXCompose(text: string): Promise<void> {
  const url = `${X_INTENT}?text=${encodeURIComponent(text)}`
  const u = new URL(url)
  if (u.protocol !== 'https:' || u.origin !== 'https://x.com' || u.pathname !== '/intent/post') throw new Error('Refusing to open this address')
  await shell.openExternal(url)
}

/* ------------------------------------------------------------------ api */

const impl: OverviewApi = {
  findings(scanId, force) {
    return computeFindings(scanId, force)
  },

  async trash(rels) {
    assertWritable()
    if (!Array.isArray(rels) || rels.length === 0) return { trashed: 0 }
    for (const r of rels) resolveInside(r) // validate everything before touching anything
    let trashed = 0
    let firstError: string | null = null
    for (const r of rels) {
      try {
        await trash(r)
        trashed++
      } catch (e) {
        firstError ??= (e as Error).message
      }
    }
    if (firstError) throw new Error(`Moved ${trashed} of ${rels.length} to Trash. ${firstError}`)
    return { trashed }
  },

  async clearLog(relPath) {
    assertWritable()
    const target = resolveInside(relPath)
    if (path.dirname(target) !== configDir() || !/\.log$/i.test(target) || isSecret(target)) throw new Error('Only .log files in the config folder can be cleared')
    const r = await safeWriteText(relPath, '', `Clear log ${path.basename(target)}`)
    return { snapshotId: r.snapshotId }
  },

  // The share card only reads stats and writes to the clipboard or to a path the user picks, so none of it asks
  // assertWritable(): CLAUDOCK_READONLY and the dev write guard protect the config folder, which this never touches.
  wrapped: computeWrapped,

  async copyImage(png) {
    await copyPng(pngBuffer(png))
  },

  async saveImage(png) {
    const buf = pngBuffer(png)
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      defaultPath: path.join(app.getPath('downloads'), 'claude-code-wrapped.png'),
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    }
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (canceled || !filePath) return { saved: false }
    // Config files are written through safeWrite only; a picture never goes into that folder or over the global state file.
    if (isInside(configDir(), path.resolve(filePath)) || samePath(filePath, globalStateFile())) throw new Error('Choose a folder outside the Claude config folder')
    await fsp.writeFile(filePath, buf)
    return { saved: true }
  },

  async postOnX(png) {
    const buf = pngBuffer(png)
    const stats = await computeWrapped()
    if (!stats) throw new Error('There are no stats to share yet')
    await copyPng(buf)
    await openXCompose(shareText(stats))
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'overview', impl)
}
