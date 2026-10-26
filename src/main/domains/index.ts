import type { IpcMain } from 'electron'
import type { DomainName } from '@shared/ipc'
import { SCREENS } from '@shared/nav'
import type { SidebarCounts } from '@shared/types'
import type { DomainModule } from './types'
import * as system from './system'
import * as overview from './overview'
import * as storage from './storage'
import * as backups from './backups'
import * as settings from './settings'
import * as rules from './rules'
import * as hooks from './hooks'
import * as permissions from './permissions'
import * as skills from './skills'
import * as agents from './agents'
import * as commands from './commands'
import * as plugins from './plugins'
import * as mods from './mods'
import * as mcp from './mcp'
import * as projects from './projects'
import * as memory from './memory'
import * as plans from './plans'
import * as history from './history'
import * as search from './search'
import * as limits from './limits'

/** Every domain. Do not edit when adding methods: just implement them in `domains/<name>.ts`. */
export const domainModules: Record<DomainName, DomainModule> = {
  system,
  overview,
  storage,
  backups,
  settings,
  rules,
  hooks,
  permissions,
  skills,
  agents,
  commands,
  plugins,
  mods,
  mcp,
  projects,
  memory,
  plans,
  history,
  search,
  limits
}

export function registerAll(ipcMain: IpcMain): void {
  for (const m of Object.values(domainModules)) m.register(ipcMain)
}

const COUNT_TIMEOUT_MS = 3000

/** Calls each screen's optional `count()` in parallel; failures and timeouts just leave the badge out. */
export async function collectCounts(): Promise<SidebarCounts> {
  const out: SidebarCounts = {}
  await Promise.all(
    SCREENS.map(async ({ id }) => {
      const fn = domainModules[id]?.count
      if (!fn) return
      try {
        const v = await Promise.race([
          Promise.resolve(fn()),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), COUNT_TIMEOUT_MS))
        ])
        if (v !== undefined) out[id] = v
      } catch {
        /* ignore */
      }
    })
  )
  return out
}
