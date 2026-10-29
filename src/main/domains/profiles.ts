import { BrowserWindow, dialog, shell, type IpcMain } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { FolderChoice, Glance, Profile, ProfileGlance, ProfilesApi, ProfilesState } from '@shared/api/profiles'
import { connectSerial, folderKey } from '../connect/folder'
import { demoMode } from '../demo'
import { defineDomain, emit } from '../ipcx'
import { FIXTURE_MARK, installKind, isInside, launchConfigDir, openConfigDir, samePath, setConfigDir, setLegacySnapshotDir, userDataDir, usesHomeState } from '../paths'
import { cleanName, configFolderRe, nameFor, slug, startCommand } from '../profiles/model'
import { mainWindow, showMainWindow } from '../windows'
import { limitsIn, onLimitsChanged, watchLimitFolders } from './limits'
import { watchArchiveFolders } from './archive'
import { watchRecapFolders } from './overviewShare'
import { everySession, onSessionsChanged, sessionsIn, watchFolders } from './sessions'

/**
 * Profiles: Claude Code config folders under names, one open in the window at a time (`setConfigDir`, which every
 * domain reads through `configDir()`), all of them watched for the menu bar (sessions and limits per folder). Claudock's
 * own data: `<userData>/profiles.json` (`profiles.dev.json` in a git clone, so `npm run dev` on the fixtures never lists
 * an installed copy's real folders), written directly like prefs.json, with `legacy`: the launch folder the first time
 * profiles loaded, which owns the snapshots taken before profiles. The launch folder (CLAUDE_CONFIG_DIR, else
 * ~/.claude) is always a profile. Started with CLAUDE_CONFIG_DIR, Claudock opens that folder; otherwise the last one open.
 * These handlers aren't pinned to a folder (src/main/ipcx.ts): they change it, so they read `openConfigDir()`.
 */

const WIN = process.platform === 'win32'

interface Stored {
  name: string
  dir: string
}

let list: Stored[] = []
let legacy = ''

const file = (): string => path.join(userDataDir(), installKind() === 'dev' ? 'profiles.dev.json' : 'profiles.json')
const key = (dir: string): string => folderKey(path.resolve(dir))
const findId = (id: unknown): Stored => {
  const p = typeof id === 'string' ? list.find((s) => key(s.dir) === id) : undefined
  if (!p) throw new Error('That profile is no longer there')
  return p
}

async function save(): Promise<void> {
  const target = file()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fsp.writeFile(tmp, JSON.stringify({ v: 1, open: key(openConfigDir()), legacy, profiles: list }, null, 2) + '\n')
  await fsp.rename(tmp, target)
}

const isDir = async (dir: string): Promise<boolean> => (await fsp.stat(dir).catch(() => null))?.isDirectory() === true

/** Read the profiles and open the right folder. Runs before the domains register, so they start on that folder. */
export async function loadProfiles(): Promise<void> {
  let open: string | null = null
  try {
    const raw = JSON.parse(await fsp.readFile(file(), 'utf8')) as { open?: unknown; legacy?: unknown; profiles?: unknown }
    if (typeof raw.legacy === 'string' && path.isAbsolute(raw.legacy)) legacy = raw.legacy
    if (Array.isArray(raw.profiles))
      for (const p of raw.profiles as Partial<Stored>[]) {
        if (typeof p?.dir !== 'string' || !path.isAbsolute(p.dir) || list.some((s) => samePath(s.dir, p.dir as string))) continue
        let name: string
        try {
          name = cleanName(p.name)
        } catch {
          name = nameFor(p.dir)
        }
        list.push({ name, dir: path.resolve(p.dir) })
      }
    if (typeof raw.open === 'string') open = raw.open
  } catch {
    /* no profiles yet */
  }
  const launch = launchConfigDir()
  if (!list.some((s) => samePath(s.dir, launch))) list.unshift({ name: nameFor(launch), dir: launch })
  // the first time: snapshots from before profiles were taken in this launch folder (saved with the next change)
  legacy ||= launch
  setLegacySnapshotDir(legacy)
  const last = open ? list.find((s) => key(s.dir) === open) : undefined
  // CLAUDE_CONFIG_DIR given: that folder, as Claude Code would. Otherwise the profile open last, if it's still there.
  const start = !process.env.CLAUDE_CONFIG_DIR?.trim() && last && (await isDir(last.dir)) ? last.dir : launch
  setConfigDir(start)
}

function state(existing: Set<string>): ProfilesState {
  const home = os.homedir()
  const profiles = list.map(
    (s): Profile => ({
      id: key(s.dir),
      name: s.name,
      dir: s.dir,
      launch: samePath(s.dir, launchConfigDir()),
      command: startCommand(s.dir, home, { plain: usesHomeState(s.dir), windows: WIN }),
      exists: existing.has(key(s.dir))
    })
  )
  return { profiles, open: key(openConfigDir()) }
}

async function current(): Promise<ProfilesState> {
  const there = await Promise.all(list.map(async (s) => ((await isDir(s.dir)) ? key(s.dir) : '')))
  return state(new Set(there))
}

/**
 * After a change to the list or the open profile: watch every folder, tell every window, then save. The windows hear
 * first, so a save that fails (disk full) never leaves them on another profile than the one main serves; the error
 * still reaches the caller.
 */
async function changed(): Promise<ProfilesState> {
  watchFolders(list)
  watchLimitFolders(list.map((s) => s.dir))
  watchArchiveFolders(list.map((s) => s.dir))
  watchRecapFolders(list, openInWindow)
  const s = await current()
  emit('profiles:changed', s)
  glanceSoon()
  try {
    await save()
  } catch (e) {
    throw new Error(`The profiles couldn’t be saved: ${(e as Error).message}`, { cause: e })
  }
  return s
}

let chain: Promise<unknown> = Promise.resolve()
/** Adding, opening, renaming and removing run one at a time, so a remove never races an open and saves stay in order. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn)
  chain = next.catch(() => undefined)
  return next
}

/* ------------------------------------------------------------------ the glance */

export async function currentGlance(): Promise<Glance> {
  const open = key(openConfigDir())
  const profiles = await Promise.all(
    list.map(async (s): Promise<ProfileGlance> => {
      const [limits, sessions] = await Promise.all([limitsIn(s.dir), sessionsIn(s.dir)])
      return { id: key(s.dir), name: s.name, open: key(s.dir) === open, limits, hooks: sessions.hooks, waiting: sessions.waiting }
    })
  )
  const sessions = everySession()
  return { profiles, sessions, waiting: sessions.filter((x) => x.status === 'waiting').length }
}

type Listener = (g: Glance) => void
const listeners = new Set<Listener>()

/** For the menu bar: every profile's limits and sessions, after any of them changed. */
export const onGlanceChanged = (cb: Listener): void => void listeners.add(cb)

let glanceTimer: NodeJS.Timeout | null = null
function glanceSoon(): void {
  if (glanceTimer) clearTimeout(glanceTimer)
  glanceTimer = setTimeout(() => {
    glanceTimer = null
    void currentGlance().then((g) => {
      emit('profiles:glance', g)
      for (const l of listeners) l(g)
    }, () => undefined)
  }, 200)
}

/* ------------------------------------------------------------------ adding */

/**
 * Where config folders are looked for and made: beside the launch folder, named like it. `~/.claude` has `.claude-work`
 * beside it; the fixtures (`./.fixture/claude`) and `--demo` have `claude-work`, so development, screenshots and filming
 * stay in their own folders. A launch folder named otherwise looks in the home folder.
 */
function profilesHome(): { dir: string; dotted: boolean } {
  const launch = launchConfigDir()
  const base = path.basename(launch)
  if (base === 'claude' || base === '.claude') return { dir: path.dirname(launch), dotted: base === '.claude' }
  return { dir: os.homedir(), dotted: true }
}

/**
 * A development build makes a new folder only beside a synthetic launch folder CLAUDE_CONFIG_DIR named (the fixture,
 * or a screenshot run's copy of it), marked so it may write there too; never in a real home folder.
 */
function makeFolderAllowed(): string | null {
  if (process.env.CLAUDOCK_READONLY === '1') return 'Claudock is read-only (CLAUDOCK_READONLY=1)'
  if (installKind() !== 'dev') return null
  const launch = launchConfigDir()
  const synthetic = !!process.env.CLAUDE_CONFIG_DIR?.trim() && fs.existsSync(path.join(launch, FIXTURE_MARK))
  if (synthetic && samePath(path.dirname(launch), profilesHome().dir)) return null
  return 'New folders are made only beside the fixture in development'
}

/** Folders this session offered (found or picked): `add()` takes only these, never a path the renderer made up. */
const offered = new Set<string>()

const MARKS = ['settings.json', 'projects', 'history.jsonl', '.claude.json', 'CLAUDE.md']

async function looksLikeConfig(dir: string): Promise<boolean> {
  const hits = await Promise.all(MARKS.map((m) => fsp.lstat(path.join(dir, m)).then(() => true, () => false)))
  return hits.some(Boolean)
}

/** Transcripts directly in each project folder (subagents' files aside). */
async function countSessions(dir: string): Promise<number> {
  const root = path.join(dir, 'projects')
  const projects = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
  const counts = await Promise.all(
    projects
      .filter((p) => p.isDirectory())
      .slice(0, 2000)
      .map(async (p) => (await fsp.readdir(path.join(root, p.name)).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl')).length)
  )
  return counts.reduce((a, b) => a + b, 0)
}

async function choice(dir: string): Promise<FolderChoice> {
  offered.add(key(dir))
  return { dir, name: nameFor(dir), sessions: await countSessions(dir) }
}

async function found(): Promise<FolderChoice[]> {
  const { dir, dotted } = profilesHome()
  const re = configFolderRe(dotted)
  const kids = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  const dirs = kids.filter((k) => k.isDirectory() && re.test(k.name)).map((k) => path.join(dir, k.name))
  const fresh = dirs.filter((d) => !list.some((s) => samePath(s.dir, d)))
  const real = await Promise.all(fresh.map(async (d) => ((await looksLikeConfig(d)) ? d : null)))
  const out = await Promise.all(real.filter((d): d is string => d !== null).map(choice))
  return out.sort((a, b) => b.sessions - a.sessions || a.dir.localeCompare(b.dir))
}

/**
 * A folder that can't be a profile: the file system root, the home folder itself, or a folder holding Claudock's own
 * data or inside it (except `--demo`'s own `claude-*` folders). Judged on where the folder really is (symlinks).
 */
async function refuse(picked: string): Promise<string | null> {
  const real = await fsp.realpath(picked).catch(() => picked)
  const data = await fsp.realpath(userDataDir()).catch(() => userDataDir())
  for (const dir of [picked, real]) {
    if (path.dirname(dir) === dir) return 'Choose a folder, not the whole disk'
    if (samePath(dir, os.homedir())) return 'Choose a Claude Code folder, not your home folder'
    const demoOwn = demoMode && samePath(path.dirname(dir), path.dirname(launchConfigDir())) && configFolderRe(false).test(path.basename(dir))
    if (!demoOwn && (isInside(data, dir) || isInside(dir, data) || isInside(userDataDir(), dir) || isInside(dir, userDataDir()))) return 'That folder holds Claudock’s own data'
    if (list.some((s) => samePath(s.dir, dir))) return 'That folder is already a profile'
  }
  return null
}

async function choose(): Promise<FolderChoice | null> {
  const win = BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: 'Add profile',
    buttonLabel: 'Choose',
    defaultPath: profilesHome().dir,
    properties: ['openDirectory', 'showHiddenFiles', 'createDirectory']
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const picked = r.canceled ? undefined : r.filePaths[0]
  if (!picked) return null
  const dir = path.resolve(picked)
  const why = await refuse(dir)
  if (why) throw new Error(why)
  return choice(dir)
}

async function newFolder(name: unknown): Promise<string> {
  const { dir, dotted } = profilesHome()
  const stem = `${dotted ? '.' : ''}claude-${slug(cleanName(name))}`
  for (let n = 1; n < 100; n++) {
    const p = path.join(dir, n === 1 ? stem : `${stem}-${n}`)
    if (!(await fsp.lstat(p).then(() => true, () => false)) && !list.some((s) => samePath(s.dir, p))) return p
  }
  throw new Error('Could not find a free folder name')
}

function add(input: { dir: string; name: string } | { create: true; name: string }): Promise<ProfilesState> {
  return serial(() => addNow(input))
}

async function addNow(input: { dir: string; name: string } | { create: true; name: string }): Promise<ProfilesState> {
  if (typeof input !== 'object' || input === null) throw new Error('Choose a folder')
  const name = cleanName(input.name)
  let dir: string
  if ('create' in input && input.create === true) {
    const no = makeFolderAllowed()
    if (no) throw new Error(no)
    dir = await newFolder(name)
    // an empty folder, the way Claude Code starts one; it asks to log in the first time it runs there
    await fsp.mkdir(dir, { recursive: false, mode: 0o700 })
    if (installKind() === 'dev') await fsp.writeFile(path.join(dir, FIXTURE_MARK), '')
  } else {
    if (typeof (input as { dir?: unknown }).dir !== 'string') throw new Error('Choose a folder')
    dir = path.resolve((input as { dir: string }).dir)
    if (!offered.has(key(dir))) throw new Error('Choose the folder again')
    const why = await refuse(dir)
    if (why) throw new Error(why)
    if (!(await isDir(dir))) throw new Error('That folder isn’t there anymore')
  }
  list.push({ name, dir })
  return openDir(dir)
}

/* ------------------------------------------------------------------ opening, renaming, removing */

/** Open a folder in the window, between Connect runs so one never spans two folders. */
function openDir(dir: string): Promise<ProfilesState> {
  return connectSerial(async () => {
    setConfigDir(dir)
    return changed()
  })
}

function open(id: string): Promise<ProfilesState> {
  return serial(async () => {
    const p = findId(id)
    if (!(await isDir(p.dir))) throw new Error(`${p.name}’s folder isn’t there anymore: ${p.dir}`)
    if (samePath(p.dir, openConfigDir())) return current()
    return openDir(p.dir)
  })
}

async function openInWindow(id: string): Promise<void> {
  findId(id)
  const w = mainWindow()
  // the window opens it, so a screen with unsaved edits can ask first
  if (w && !w.webContents.isLoading()) {
    showMainWindow()
    emit('profiles:request', { id })
    return
  }
  await open(id)
  showMainWindow()
}

function rename(id: string, name: string): Promise<ProfilesState> {
  return serial(async () => {
    findId(id).name = cleanName(name)
    return changed()
  })
}

function remove(id: string): Promise<ProfilesState> {
  return serial(async () => {
    const p = findId(id)
    if (samePath(p.dir, launchConfigDir())) throw new Error('Claudock was started on this folder, so it stays')
    if (samePath(p.dir, openConfigDir())) throw new Error('Open another profile first')
    list = list.filter((s) => s !== p)
    return changed()
  })
}

async function reveal(id: string): Promise<void> {
  const p = findId(id)
  if (!(await isDir(p.dir))) throw new Error('That folder isn’t there anymore')
  shell.showItemInFolder(p.dir)
}

export function register(ipcMain: IpcMain): void {
  const impl: ProfilesApi = { get: current, open, openInWindow, glance: currentGlance, found, choose, newFolder, add, rename, remove, reveal }
  defineDomain(ipcMain, 'profiles', impl)
  watchFolders(list)
  watchLimitFolders(list.map((s) => s.dir))
  watchArchiveFolders(list.map((s) => s.dir))
  watchRecapFolders(list, openInWindow)
  onSessionsChanged(glanceSoon)
  onLimitsChanged(glanceSoon)
}
