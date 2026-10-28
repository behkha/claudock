import type { IpcMain } from 'electron'
import path from 'node:path'
import type { TodayApi, TodayState } from '@shared/api/today'
import { defineDomain } from '../ipcx'
import { configDir } from '../paths'
import { sumActivity } from '../today/activity'
import { transcriptUsage } from './limits'
import { ownSessionName, sessionTitle } from './projects'

/**
 * Today: the home screen's sessions from today and its 7 days of tokens, from the limits scan of the transcripts
 * (src/main/today/activity.ts sums them). Each session is named as Claude Code names it, else by its first prompt.
 */

const lastFolder = (cwd: string | null): string | undefined =>
  cwd
    ?.split(/[\\/]+/)
    .filter(Boolean)
    .pop()

async function get(): Promise<TodayState> {
  const { sessions, days, tokens } = sumActivity(await transcriptUsage(), Date.now())
  const root = path.join(configDir(), 'projects')
  return {
    sessions: await Promise.all(
      sessions.map(async (s) => {
        // the id comes from inside the transcript: name only ids that are a plain file name
        const abs = /^[A-Za-z0-9._-]{1,200}$/.test(s.id) && !s.id.startsWith('.') ? path.join(root, s.projectId, `${s.id}.jsonl`) : null
        const title = abs ? ((await ownSessionName(abs)) ?? (await sessionTitle(abs))) : ''
        return { id: s.id, projectId: s.projectId, folder: lastFolder(s.cwd) ?? s.projectId, title, first: s.first, last: s.last, tokens: s.tokens }
      })
    ),
    days,
    tokens
  }
}

export function register(ipcMain: IpcMain): void {
  const impl: TodayApi = { get }
  defineDomain(ipcMain, 'today', impl)
}
