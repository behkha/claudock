import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { PlanInfo } from '@shared/api/plans'
import { splitFrontmatter } from '@shared/frontmatter'
import { assertUnchangedOnDisk, matchEol, readText, readTextOr, stat } from '../fsx'
import { defineDomain } from '../ipcx'
import { configDir, resolveInside } from '../paths'
import { safeWriteText, trash, withFileLock } from '../safeWrite'
import { readHead } from './projects'

const plansDir = (): string => path.join(configDir(), 'plans')

function planPath(rel: string): string {
  const abs = resolveInside(rel)
  if (path.dirname(abs) !== plansDir() || !abs.toLowerCase().endsWith('.md')) throw new Error('This is not a plan file')
  return abs
}

function titleAndExcerpt(text: string, file: string): { title: string; excerpt: string } {
  const body = splitFrontmatter(text).body
  let title = ''
  let excerpt = ''
  let fenced = false
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('```')) fenced = !fenced
    if (fenced || !line) continue
    const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)
    if (h) {
      if (!title) title = h[1]
      continue
    }
    if (!excerpt && !line.startsWith('```')) excerpt = line.replace(/[*_`>]/g, '').slice(0, 160)
    if (title && excerpt) break
  }
  return { title: title || file.replace(/\.md$/i, ''), excerpt }
}

export async function listPlans(): Promise<PlanInfo[]> {
  let names: string[]
  try {
    names = (await fsp.readdir(plansDir())).filter((n) => n.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const plans = await Promise.all(
    names.map(async (file): Promise<PlanInfo | null> => {
      const abs = path.join(plansDir(), file)
      const st = await stat(abs)
      if (!st || !st.isFile) return null
      const { title, excerpt } = titleAndExcerpt(await readHead(abs, 8192), file)
      return { rel: path.join('plans', file), file, title, excerpt, bytes: st.size, mtimeMs: st.mtimeMs }
    })
  )
  return plans.filter((p): p is PlanInfo => p !== null).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'plans', {
    list: () => listPlans(),

    async read(rel: string) {
      const abs = planPath(rel)
      const [text, st] = await Promise.all([readText(abs), stat(abs)])
      return { text, mtimeMs: st?.mtimeMs ?? 0 }
    },

    async save(rel: string, text: string, expectedMtimeMs: number) {
      const abs = planPath(rel)
      if (typeof text !== 'string') throw new Error('Nothing to save')
      return withFileLock(rel, async () => {
        await assertUnchangedOnDisk(abs, expectedMtimeMs, path.basename(abs))
        const out = matchEol(await readTextOr(abs), text.endsWith('\n') ? text : text + '\n')
        await safeWriteText(rel, out, `Edit plan ${path.basename(abs)}`)
        return { mtimeMs: (await stat(abs))?.mtimeMs ?? Date.now() }
      })
    },

    async trash(rel: string) {
      const abs = planPath(rel)
      if (!(await stat(abs))) throw new Error('This plan no longer exists')
      await trash(rel)
    }
  })
}

export async function count(): Promise<number> {
  try {
    return (await fsp.readdir(plansDir())).filter((n) => n.toLowerCase().endsWith('.md')).length
  } catch {
    return 0
  }
}
