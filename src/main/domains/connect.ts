import type { IpcMain } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ConnectApi, ConnectParts, ConnectPreview, ConnectStatus, HookLine } from '@shared/api/connect'
import { baselineAfterConnect, disconnectPlan } from '../connect/baseline'
import { connectSerial, readConnectState, removeOwn, sha256, writeConnectState, type ConnectState } from '../connect/folder'
import { addHooks, hooksProblem, missingGroups, removeHooks } from '../connect/settingsHooks'
import { defineDomain, emit } from '../ipcx'
import { assertWritable, configDir } from '../paths'
import { restoreSnapshot, safeWriteJson, trash, withFileLock } from '../safeWrite'
import { SETTINGS_REL, isObj, readSettings } from './extendShared'
import { commandOf, isStepOn, removeStepFiles, retireStepFiles, stepChanged, stepCommand, wrappable, writeStepScript } from './limits'
import { hookGroups, hooksChanged, hooksInstalled, ourHookCommands, removeHookFiles, retireHookFiles, writeHookFiles } from './sessions'

/**
 * "Connect to Claude Code": adds the live limits status line step and the session hooks to settings.json in one write
 * (one snapshot, through safeWrite under the settings.json lock), and Disconnect removes both. The scripts live in Claudock's connect folder and are written before
 * settings.json points at them (Claude Code runs a changed command at once) and removed after it no longer does.
 *
 * Disconnect puts back the exact bytes settings.json had before the first Connect when nothing else has changed the
 * file since (state.json `baseline`: the snapshot, and the hash of what Claudock wrote last). Otherwise it removes only
 * Claudock's keys, keeping every other edit.
 */

const WIN = process.platform === 'win32'
const SETTINGS_FILE = (): string => path.join(configDir(), SETTINGS_REL)
const withoutBom = (b: Buffer): Buffer => (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b)

function assertSupported(): void {
  if (WIN) throw new Error('Connecting to Claude Code is not available on Windows yet')
}

/** Which parts are in settings.json now (also the first-run rule, src/main/firstRun.ts). */
export async function status(): Promise<ConnectStatus> {
  if (WIN) return { statusLine: 'unsupported', hooks: 'unsupported' }
  const { data } = await readSettings()
  return { statusLine: isStepOn(data.statusLine) ? 'on' : 'off', hooks: hooksInstalled(data) ? 'on' : 'off' }
}

const lines = (groups: ReturnType<typeof hookGroups>): HookLine[] => groups.map((g) => ({ event: g.event, matcher: g.matcher, command: String(g.entry.command) }))

const NOT_A_COMMAND = "statusLine in settings.json isn't a command, so live limits can't run alongside it"
/** disableAllHooks turns off hooks and the status line alike: connecting would change nothing that runs. */
const ALL_OFF = 'Hooks and the status line are turned off in settings.json (disableAllHooks)'
const allOff = (data: Record<string, unknown>): boolean => data.disableAllHooks === true

async function previewConnect(): Promise<ConnectPreview> {
  assertSupported()
  const { data, error } = await readSettings()
  if (error) throw new Error(error)
  const sl = data.statusLine
  const slOn = isStepOn(sl)
  const off = allOff(data)
  const problem = off ? ALL_OFF : hooksProblem(data)
  return {
    statusLine: slOn || off || !wrappable(sl) ? null : { before: sl?.command ?? null, after: stepCommand() },
    statusLineProblem: slOn ? null : off ? ALL_OFF : !wrappable(sl) ? NOT_A_COMMAND : null,
    hooks: problem ? [] : lines(missingGroups(data, hookGroups())),
    hooksProblem: problem
  }
}

async function previewDisconnect(): Promise<ConnectPreview> {
  assertSupported()
  const { data, error } = await readSettings()
  if (error) throw new Error(error)
  const missing = new Set(missingGroups(data, hookGroups()).map((g) => g.event))
  return {
    statusLine: isStepOn(data.statusLine) ? { before: stepCommand(), after: commandOf(await readConnectState()) } : null,
    statusLineProblem: null,
    hooks: lines(hookGroups().filter((g) => !missing.has(g.event))),
    hooksProblem: null
  }
}

function changed(): void {
  void status().then((s) => emit('connect:changed', s), () => undefined)
}

/** settings.json's bytes (null when missing), BOM left out, hashed: what the baseline compares. */
async function currentSha(): Promise<string | null> {
  const b = await fsp.readFile(SETTINGS_FILE()).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null
    throw e
  })
  return b === null ? null : sha256(withoutBom(b))
}

async function connect(parts: ConnectParts): Promise<{ snapshotId: string | null }> {
  assertSupported()
  assertWritable()
  if (!isObj(parts) || typeof parts.statusLine !== 'boolean' || typeof parts.hooks !== 'boolean') throw new Error('Choose what to connect')
  // read, decide and write under the settings.json lock, so no other Claudock write lands in between
  return connectSerial(() =>
    withFileLock(SETTINGS_REL, async () => {
      const shaBefore = await currentSha()
      const { data, error } = await readSettings()
      if (error) throw new Error(`${error}. Nothing was written.`)
      const sl = data.statusLine
      const slOn = isStepOn(sl)
      const hooksOn = hooksInstalled(data)
      const addSl = parts.statusLine && !slOn
      const groups = parts.hooks ? missingGroups(data, hookGroups()) : []
      if (!addSl && groups.length === 0) return { snapshotId: null }
      if (allOff(data)) throw new Error(`${ALL_OFF}. Nothing was written.`)
      if (addSl && !wrappable(sl)) throw new Error(`${NOT_A_COMMAND}. Nothing was written.`)
      const problem = groups.length ? hooksProblem(data) : null
      if (problem) throw new Error(`${problem}. Nothing was written.`)

      const first = !slOn && !hooksOn
      const prevState = await readConnectState()
      const state: ConnectState = prevState && !first ? { ...prevState } : { v: 2, statusLine: null, hooks: null, baseline: null, at: new Date().toISOString() }
      if (addSl) state.statusLine = { original: sl === undefined ? { present: false } : { present: true, value: JSON.parse(JSON.stringify(sl)) as unknown } }
      if (groups.length) {
        const hooksObj = isObj(data.hooks) ? data.hooks : {}
        const created = [...new Set(groups.map((g) => g.event))].filter((e) => hooksObj[e] === undefined)
        // keep what an earlier Connect created: those containers are still Claudock's to remove
        state.hooks = { hooksKey: (state.hooks?.hooksKey ?? false) || data.hooks === undefined, events: [...new Set([...(state.hooks?.events ?? []), ...created])] }
      }

      // scripts and state first: Claude Code runs a changed command at once, and Disconnect needs the original statusLine
      if (addSl) await writeStepScript(isObj(sl) && typeof sl.command === 'string' ? sl.command : null)
      if (groups.length) await writeHookFiles()
      await writeConnectState(state)

      if (addSl) data.statusLine = sl === undefined ? { type: 'command', command: stepCommand() } : { ...(sl as object), command: stepCommand() }
      if (groups.length) addHooks(data, groups)
      let r: { snapshotId: string | null }
      try {
        r = await safeWriteJson(SETTINGS_REL, data, 'Connect to Claude Code')
      } catch (e) {
        // settings.json is unchanged: put state.json back and drop the files of parts that are still off
        if (prevState && !first) await writeConnectState(prevState)
        else await removeOwn('state.json')
        if (addSl) await removeStepFiles()
        if (groups.length && !hooksOn) await removeHookFiles()
        throw e
      }
      state.baseline = baselineAfterConnect(state.baseline, first, shaBefore, sha256(JSON.stringify(data, null, 2) + '\n'), r.snapshotId)
      await writeConnectState(state)

      if (addSl) stepChanged(true)
      if (groups.length) hooksChanged()
      changed()
      return { snapshotId: r.snapshotId }
    })
  )
}

async function disconnect(): Promise<{ snapshotId: string | null }> {
  assertSupported()
  assertWritable()
  return connectSerial(async () => {
    const state = await readConnectState()
    const r = await withFileLock(SETTINGS_REL, async (): Promise<{ snapshotId: string | null }> => {
      const plan = disconnectPlan(state?.baseline ?? null, await currentSha())
      // nothing but Claudock changed the file since the first Connect: put back exactly what was there
      if (plan === 'trash') {
        try {
          await trash(SETTINGS_REL)
          return { snapshotId: null }
        } catch {
          /* no Trash here: remove Claudock's keys instead */
        }
      }
      if (plan === 'restore' && state?.baseline?.snapshotId) {
        try {
          return await restoreSnapshot(state.baseline.snapshotId, SETTINGS_REL, 'Disconnect from Claude Code')
        } catch {
          /* the snapshot was deleted in Backups: remove Claudock's keys instead */
        }
      }
      const { data, error } = await readSettings()
      if (error) throw new Error(`${error}. Nothing was written.`)
      const slOn = isStepOn(data.statusLine)
      const hooksOn = hooksInstalled(data)
      if (!slOn && !hooksOn) return { snapshotId: null }
      if (slOn) {
        if (state?.statusLine?.original.present) data.statusLine = state.statusLine.original.value
        // no record of what was there (Claudock's folder was cleared): remove the step rather than leave it broken
        else delete data.statusLine
      }
      if (hooksOn) removeHooks(data, ourHookCommands(), state?.hooks ?? null)
      return safeWriteJson(SETTINGS_REL, data, 'Disconnect from Claude Code')
    })
    await Promise.all([retireStepFiles(), retireHookFiles(), removeOwn('state.json')])
    stepChanged(false)
    hooksChanged()
    changed()
    return r
  })
}

export function register(ipcMain: IpcMain): void {
  const impl: ConnectApi = { get: status, previewConnect, connect, previewDisconnect, disconnect }
  defineDomain(ipcMain, 'connect', impl)
}
