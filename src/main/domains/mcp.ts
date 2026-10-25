import type { IpcMain } from 'electron'
import {
  hasProblems,
  summarize,
  transportOf,
  validateMcp,
  type McpList,
  type McpApi,
  type McpServer,
  type McpServerConfig
} from '@shared/api/mcp'
import { tryReadJson } from '../fsx'
import { defineDomain } from '../ipcx'
import { globalStateFile } from '../paths'
import { updateGlobalState } from '../safeWrite'
import { isObj } from './extendShared'

/** Read the global state file; never throws. */
async function readState(): Promise<{ state: Record<string, unknown>; exists: boolean; error?: string }> {
  const r = await tryReadJson<unknown>(globalStateFile())
  if (!r.ok) return r.missing ? { state: {}, exists: false } : { state: {}, exists: true, error: `The global state file could not be read: ${r.error}` }
  if (!isObj(r.value)) return { state: {}, exists: true, error: 'The global state file is not a JSON object.' }
  return { state: r.value, exists: true }
}

function toServer(name: string, raw: unknown, scope: 'user' | 'project', projectPath?: string): McpServer | null {
  if (!isObj(raw)) return null
  const config = raw as McpServerConfig
  return { name, scope, projectPath, transport: transportOf(config), config, summary: summarize(config) }
}

function serversOf(v: unknown, scope: 'user' | 'project', projectPath?: string): McpServer[] {
  if (!isObj(v)) return []
  return Object.entries(v)
    .map(([k, c]) => toServer(k, c, scope, projectPath))
    .filter((s): s is McpServer => s !== null)
}

async function list(): Promise<McpList> {
  const { state, exists, error } = await readState()
  const projects: McpList['projects'] = []
  if (isObj(state.projects)) {
    for (const [p, v] of Object.entries(state.projects)) {
      if (!isObj(v)) continue
      const servers = serversOf(v.mcpServers, 'project', p)
      if (servers.length) projects.push({ path: p, servers })
    }
  }
  projects.sort((a, b) => a.path.localeCompare(b.path))
  return { stateFile: globalStateFile(), stateExists: exists, user: serversOf(state.mcpServers, 'user'), projects, error }
}

/** Keep only plain JSON-friendly values and drop empty optional containers. */
function clean(config: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...config }
  const t = transportOf(out)
  if (t === 'stdio') {
    out.type = typeof out.type === 'string' ? out.type : 'stdio'
    delete out.url
    delete out.headers
    if (typeof out.command === 'string') out.command = out.command.trim()
    if (Array.isArray(out.args) && out.args.length === 0) delete out.args
    if (isObj(out.env) && Object.keys(out.env).length === 0) delete out.env
  } else {
    delete out.command
    delete out.args
    delete out.env
    if (typeof out.url === 'string') out.url = out.url.trim()
    if (isObj(out.headers) && Object.keys(out.headers).length === 0) delete out.headers
  }
  return out
}

const userServersOf = (state: Record<string, unknown>): Record<string, unknown> => (isObj(state.mcpServers) ? { ...state.mcpServers } : {})

const impl: McpApi = {
  list,

  async save(input) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name === '__proto__') throw new Error('That name is reserved')
    if (!isObj(input.config)) throw new Error('The server settings are missing')
    const config = clean(input.config)
    // The checks run inside the write, on the state re-read at that moment, so a server added by `claude mcp add`
    // between the click and the write is neither lost nor overwritten.
    const r = await updateGlobalState((state) => {
      const servers = userServersOf(state)
      const problems = validateMcp(name, config, Object.keys(servers), input.originalName)
      if (hasProblems(problems)) throw new Error(Object.values(problems)[0])
      if (input.originalName !== undefined && !Object.hasOwn(servers, input.originalName)) throw new Error(`${input.originalName} no longer exists`)
      // keep the original position when editing or renaming
      const next: Record<string, unknown> = {}
      if (input.originalName !== undefined) {
        for (const [k, v] of Object.entries(servers)) next[k === input.originalName ? name : k] = k === input.originalName ? config : v
      } else {
        Object.assign(next, servers)
        next[name] = config
      }
      state.mcpServers = next
    }, input.originalName === undefined ? `Add MCP server ${name}` : `Edit MCP server ${name}`)
    return { snapshotId: r.snapshotId }
  },

  async remove(name) {
    const r = await updateGlobalState((state) => {
      const servers = userServersOf(state)
      if (!Object.hasOwn(servers, name)) throw new Error(`${name} no longer exists`)
      delete servers[name]
      state.mcpServers = servers
    }, `Remove MCP server ${name}`)
    return { snapshotId: r.snapshotId }
  }
}

export function register(ipcMain: IpcMain): void {
  defineDomain(ipcMain, 'mcp', impl)
}

/** Sidebar badge: number of user-scope servers. */
export async function count(): Promise<number> {
  const { state } = await readState()
  return isObj(state.mcpServers) ? Object.keys(state.mcpServers).length : 0
}
