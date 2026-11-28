import { app, net } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { UpdateStatus } from '@shared/types'
import { emit } from './ipcx'
import { installKind, userDataDir } from './paths'
import { feedBase, feedName, fileUrl, parseFeed, pickFile, type FeedFile } from './updateFeed'

declare const __APP_VERSION__: string

/**
 * Update from inside the app (approved 26 Nov 2026, U1). How depends on how this copy was installed:
 *
 * - `mac`: the installed Claudock.app. It is ad-hoc signed, so Squirrel.Mac refuses it. Instead the release's zip for
 *   this chip is downloaded, checked against the sha512 in latest-mac.yml, unpacked with ditto and checked with
 *   codesign. Restart quits, and a detached /bin/sh helper waits for this process to end, moves the new app beside the
 *   old one (`.Claudock.app.new`), swaps them (`.Claudock.app.old`, put back if the swap fails), clears quarantine and
 *   opens it (the approach of github.com/ShalomPrinz/fast-study, electron/macUpdate.js). Refused for a read-only,
 *   translocated or unwritable location: the popover offers the download then.
 * - `npm`: `npx claudock`. Update installs the new version into npx's cache in the background; Restart quits and a
 *   helper starts `npx claudock@<version>` once this process is gone. A failure turns the popover back to the command.
 * - `win`: the NSIS setup from latest.yml, checked the same way, run silently (`/S --updated --force-run`) on Restart.
 * - `appimage`: the AppImage from latest-linux[-arm64].yml, checked, put in place of the running one on Restart.
 * - The .deb and a git clone: no Update (null).
 *
 * Everything is logged to <userData>/logs/update.log, the helper's lines too.
 */

export type Method = 'mac' | 'npm' | 'win' | 'appimage'

const NPM_TIMEOUT_MS = 10 * 60_000
const FEED_TIMEOUT_MS = 10_000
const STALL_MS = 60_000

let status: UpdateStatus = { phase: 'idle' }
/** What Restart installs: the checked file or unpacked app, for `version`. */
let staged: { version: string; method: Method; file: string } | null = null
let running: Promise<void> | null = null
/** An npm install failed this run: the popover offers the command instead. */
let npmFailed = false

const logFile = (): string => path.join(userDataDir(), 'logs', 'update.log')
/** Where the Mac helper says why a swap failed; the app it reopens shows it once (takeUpdateFailure). */
const resultFile = (): string => path.join(userDataDir(), 'update-failed.txt')

/** Why the last Restart to update didn't install, once, or null. */
export async function takeUpdateFailure(): Promise<string | null> {
  try {
    const text = (await fsp.readFile(resultFile(), 'utf8')).trim()
    await fsp.rm(resultFile(), { force: true })
    return text || null
  } catch {
    return null
  }
}

function log(line: string): void {
  try {
    fs.mkdirSync(path.dirname(logFile()), { recursive: true })
    fs.appendFileSync(logFile(), `${new Date().toISOString()} [main ${__APP_VERSION__}] ${line}\n`)
  } catch {
    /* a log that can't be written stops nothing */
  }
}

function setStatus(next: UpdateStatus): void {
  status = next
  emit('system:updateStatus', next)
}

export const updateStatus = (): UpdateStatus => status

/** Screenshot mode only: show a phase without downloading (src/main/shot.ts). */
export const showStatusForShot = (next: UpdateStatus): void => setStatus(next)

/** The running .app bundle when it can be swapped in place, else null. */
function macBundle(): string | null {
  const bundle = path.resolve(process.execPath, '..', '..', '..')
  if (!bundle.endsWith('.app')) return null
  // Gatekeeper runs a quarantined app from a read-only random path until it is moved
  if (bundle.includes('/AppTranslocation/')) return null
  try {
    // a read-only volume (run from the dmg) answers EROFS here
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK)
    fs.accessSync(bundle, fs.constants.W_OK)
  } catch {
    return null
  }
  return bundle
}

function appImage(): string | null {
  const file = process.env.APPIMAGE
  if (!file || !fs.existsSync(file)) return null
  try {
    fs.accessSync(path.dirname(file), fs.constants.W_OK)
  } catch {
    return null
  }
  return file
}

/** The npx that started this copy (npm passes its own path down), else the first on PATH. */
function npx(): { cmd: string; args: string[]; shell: boolean } | null {
  const cli = process.env.npm_execpath
  const node = process.env.npm_node_execpath
  if (cli && node) {
    const npxCli = path.join(path.dirname(cli), 'npx-cli.js')
    if (fs.existsSync(npxCli) && fs.existsSync(node)) return { cmd: node, args: [npxCli], shell: false }
  }
  const name = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return { cmd: path.join(dir, name), args: [], shell: process.platform === 'win32' }
  }
  return null
}

/** The environment for npx and the relaunched app: npm's own per-run settings (npm_config_call…) left behind. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!/^npm_/i.test(k) && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'INIT_CWD') env[k] = v
  return env
}

/** How Update works for this copy, or null when it can't (the popover offers the command or the download). */
export function installMethod(): Method | null {
  if (process.env.CLAUDOCK_SHOT === '1') return null
  const kind = installKind()
  if (kind === 'dev') return null
  if (kind === 'npm') return !npmFailed && npx() ? 'npm' : null
  if (process.platform === 'darwin') return macBundle() ? 'mac' : null
  if (process.platform === 'win32') return 'win'
  if (process.platform === 'linux') return appImage() ? 'appimage' : null
  return null
}

const feeds = new Map<string, Promise<FeedFile | null>>()

/** The file this copy updates from in release `version`'s feed, or null when the release has none (made before 0.6.0). */
export function feedFile(version: string): Promise<FeedFile | null> {
  const name = feedName()
  if (!name) return Promise.resolve(null)
  let p = feeds.get(version)
  if (!p) {
    p = (async () => {
      const res = await net.fetch(new URL(name, feedBase(version)).toString(), { signal: AbortSignal.timeout(FEED_TIMEOUT_MS), cache: 'no-store' })
      if (res.status === 404) return null
      if (!res.ok) throw new Error(`the update feed answered HTTP ${res.status}`)
      const feed = parseFeed(await res.text())
      if (feed.version !== version) throw new Error(`the update feed is for ${feed.version}, not ${version}`)
      return pickFile(feed)
    })()
    // only a file is remembered: a failure, or a release whose feed isn't up yet (a draft), is asked again next time
    p.then((f) => f ?? feeds.delete(version), () => feeds.delete(version))
    feeds.set(version, p)
  }
  return p
}

const run = promisify(execFile)

/** Download `url` to `dest`, hashing as it streams; a body that isn't `sha512` (base64, as the yml spells it) is deleted. */
async function download(url: string, sha512: string, dest: string, version: string, size: number | null): Promise<void> {
  // a connection that goes quiet ends the download, so the footer never hangs on "Downloading"
  const abort = new AbortController()
  let idle: NodeJS.Timeout | undefined
  const quiet = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => abort.abort(new Error(`the download stalled for ${STALL_MS / 1000} seconds`)), STALL_MS)
  }
  quiet()
  try {
    await fetchTo(url, sha512, dest, version, size, abort.signal, quiet)
  } catch (e) {
    await fsp.rm(dest, { force: true })
    throw abort.signal.aborted ? (abort.signal.reason as Error) : e
  } finally {
    clearTimeout(idle)
  }
}

async function fetchTo(url: string, sha512: string, dest: string, version: string, size: number | null, signal: AbortSignal, onData: () => void): Promise<void> {
  const res = await net.fetch(url, { cache: 'no-store', signal })
  if (!res.ok || !res.body) throw new Error(`the download answered HTTP ${res.status}`)
  const total = size ?? (Number(res.headers.get('content-length')) || null)
  const hash = createHash('sha512')
  let received = 0
  let shown = 0
  setStatus({ phase: 'downloading', version, received, total })
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      onData()
      hash.update(chunk)
      received += chunk.length
      if (Date.now() - shown > 120) {
        shown = Date.now()
        setStatus({ phase: 'downloading', version, received, total })
      }
      done(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), count, fs.createWriteStream(dest), { signal })
  setStatus({ phase: 'downloading', version, received, total })
  const actual = hash.digest('base64')
  if (actual !== sha512) {
    await fsp.rm(dest, { force: true })
    log(`sha512 mismatch for ${url}: the feed says ${sha512}, the download is ${actual}`)
    throw new Error("the download doesn't match the release's checksum, so nothing was installed")
  }
  log(`downloaded ${url} (${received} bytes), sha512 matches`)
}

/** Unpack the mac zip and check what is in it: one .app, at `version`, with a valid signature. */
async function unpackMac(zip: string, dir: string, version: string): Promise<string> {
  const out = path.join(dir, 'staged')
  await run('/usr/bin/ditto', ['-x', '-k', zip, out])
  await fsp.rm(zip, { force: true })
  const name = (await fsp.readdir(out)).find((n) => n.endsWith('.app'))
  if (!name) throw new Error('the update zip holds no app')
  const appPath = path.join(out, name)
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')])
  if (stdout.trim() !== version) throw new Error(`the update zip holds ${stdout.trim()}, not ${version}`)
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  } catch (e) {
    throw new Error(`the new app's signature doesn't verify (${String((e as { stderr?: string }).stderr ?? e).trim().split('\n')[0]})`, { cause: e })
  }
  log(`unpacked ${appPath}, version ${version}, codesign --verify passed`)
  return appPath
}

/** `npx --yes --package=claudock@<version>` with `rest` after it. */
function npxArgs(version: string, rest: string[]): { cmd: string; args: string[]; shell: boolean } {
  const n = npx()
  if (!n) throw new Error('npx was not found')
  return { cmd: n.cmd, args: [...n.args, '--yes', `--package=claudock@${version}`, ...rest], shell: n.shell }
}

/** Install `version` into npx's cache (Electron's download with it) without starting it. */
function npmInstall(version: string): Promise<void> {
  const { cmd, args, shell } = npxArgs(version, ['-c', 'exit 0'])
  log(`npm: ${cmd} ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: cleanEnv(), stdio: ['ignore', 'ignore', 'pipe'], shell, windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)))
    const timer = setTimeout(() => child.kill(), NPM_TIMEOUT_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve()
      const last = err.trim().split('\n').filter(Boolean).pop() ?? ''
      log(`npm install of ${version} exited ${code}: ${err.trim()}`)
      reject(new Error(`npm couldn't install ${version}${last ? ` (${last.replace(/^npm (error|ERR!)\s*/, '')})` : ''}`))
    })
  })
}

/**
 * Get `version` ready to restart into. Resolves once Restart can run; throws with the cause (the footer goes back to
 * "vX available"). A second call while one runs joins it.
 */
export function prepareUpdate(version: string): Promise<void> {
  if (staged?.version === version) return Promise.resolve()
  running ??= prepare(version).finally(() => (running = null))
  return running
}

async function prepare(version: string): Promise<void> {
  const method = installMethod()
  if (!method) throw new Error("this copy can't update itself")
  log(`preparing ${version} (${method}) from ${__APP_VERSION__}`)
  const dir = path.join(userDataDir(), 'update')
  try {
    staged = null
    if (method === 'npm') {
      setStatus({ phase: 'downloading', version, received: 0, total: null })
      try {
        await npmInstall(version)
      } catch (e) {
        npmFailed = true
        throw e
      }
      staged = { version, method, file: '' }
    } else {
      const file = await feedFile(version)
      if (!file) throw new Error(`release ${version} has no download for this computer`)
      await fsp.rm(dir, { recursive: true, force: true })
      await fsp.mkdir(dir, { recursive: true })
      const dest = path.join(dir, path.basename(decodeURIComponent(file.url.split('/').pop() ?? '')) || 'update')
      await download(fileUrl(file, version), file.sha512, dest, version, file.size)
      staged = { version, method, file: method === 'mac' ? await unpackMac(dest, dir, version) : dest }
    }
    log(`ready: ${version} (${method}) ${staged.file}`)
    setStatus({ phase: 'ready', version })
  } catch (e) {
    const msg = (e as Error).message
    log(`failed: ${msg}`)
    if (method !== 'npm') await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    staged = null
    setStatus({ phase: 'idle' })
    throw new Error(msg.charAt(0).toUpperCase() + msg.slice(1), { cause: e })
  }
}

/**
 * The swap, run by /bin/sh once this process is gone. Args: pid, app, staged app, version, then `--env NAME=VALUE` pairs
 * for `open`. The old app is kept until the new one is in place and put back if the swap fails; either way an app is
 * opened at the end, with the folder and settings this one was started with.
 */
const MAC_HELPER = `
pid=$1; app=$2; staged=$3; version=$4; result=$5; shift 5
dir=$(dirname "$app"); name=$(basename "$app")
incoming="$dir/.$name.new"; previous="$dir/.$name.old"
say() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [helper] $*"; }
fail() { say "$1"; printf '%s\n' "$2" > "$result"; }
say "waiting for pid $pid to exit"
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then fail "gave up: pid $pid is still running, nothing swapped" "Claudock didn't quit in time, so $version wasn't installed"; rm -rf "$staged"; exit 1; fi
  sleep 0.2
done
say "pid $pid exited"
rm -rf "$incoming" "$previous"
code=0
if ! mv "$staged" "$incoming"; then
  fail "swap failed: could not move the new app beside $app; the installed app is untouched" "macOS didn't let Claudock put $version in $dir"; rm -rf "$incoming" "$staged"; code=1
elif ! mv "$app" "$previous"; then
  fail "swap failed: could not move $app aside; the installed app is untouched" "macOS didn't let Claudock replace itself in $dir"; rm -rf "$incoming"; code=1
elif ! mv "$incoming" "$app"; then
  if mv "$previous" "$app"; then fail "swap failed: restored the previous app" "$version couldn't be put in place, so the version you had is back"; else fail "swap failed: the previous app is left at $previous" "$version couldn't be put in place; the version you had is at $previous"; fi
  rm -rf "$incoming"; code=1
else
  xattr -dr com.apple.quarantine "$app" 2>/dev/null
  rm -rf "$previous"
  say "swapped: $app is $version"
fi
say "opening $app"
open "$@" "$app" || say "open failed"
exit $code
`

/** CLAUDE_CONFIG_DIR and Claudock's own variables, for `open --env`: the new app opens the folder this one had. */
function passEnv(): string[] {
  return Object.entries(process.env)
    .filter(([k, v]) => v !== undefined && (k === 'CLAUDE_CONFIG_DIR' || k.startsWith('CLAUDOCK_')))
    .flatMap(([k, v]) => ['--env', `${k}=${v}`])
}

/** Waits for pid, then runs the command after it (npm relaunch on macOS and Linux). */
const WAIT_THEN_RUN = `
pid=$1; shift
say() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [helper] $*"; }
say "waiting for pid $pid to exit"
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then say "gave up: pid $pid is still running"; exit 1; fi
  sleep 0.2
done
say "pid $pid exited; running $*"
exec "$@"
`

/** The same wait for Windows, run by this Electron as plain Node. */
const WAIT_THEN_RUN_JS = `
const [pid, cmd, ...args] = process.argv.slice(1)
const alive = () => { try { process.kill(Number(pid), 0); return true } catch { return false } }
let tries = 0
const tick = () => {
  if (alive() && ++tries <= 300) return setTimeout(tick, 200)
  require('node:child_process').spawn(cmd, args, { detached: true, stdio: 'ignore', shell: /\\.cmd$/i.test(cmd), windowsHide: false }).unref()
}
tick()
`

function helperLog(): number {
  fs.mkdirSync(path.dirname(logFile()), { recursive: true })
  return fs.openSync(logFile(), 'a')
}

/** Start the update that is ready and quit. Throws (nothing changes) when none is ready. */
export async function restartToUpdate(): Promise<void> {
  const s = staged
  if (!s) throw new Error('No update is ready')
  log(`restarting into ${s.version} (${s.method})`)
  if (s.method === 'mac') {
    const bundle = macBundle()
    if (!bundle) throw new Error("Claudock's folder can't be written to, so it can't be replaced")
    const out = helperLog()
    try {
      fs.rmSync(resultFile(), { force: true })
      spawn('/bin/sh', ['-c', MAC_HELPER, 'claudock-update', String(process.pid), bundle, s.file, s.version, resultFile(), ...passEnv()], {
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...cleanEnv(), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
      }).unref()
    } finally {
      fs.closeSync(out)
    }
  } else if (s.method === 'npm') {
    const { cmd, args } = npxArgs(s.version, ['--', 'claudock'])
    const out = helperLog()
    try {
      if (process.platform === 'win32') {
        spawn(process.execPath, ['-e', WAIT_THEN_RUN_JS, String(process.pid), cmd, ...args], {
          detached: true,
          stdio: ['ignore', out, out],
          env: { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1' },
          windowsHide: true
        }).unref()
      } else {
        spawn('/bin/sh', ['-c', WAIT_THEN_RUN, 'claudock-update', String(process.pid), cmd, ...args], { detached: true, stdio: ['ignore', out, out], env: cleanEnv() }).unref()
      }
    } finally {
      fs.closeSync(out)
    }
  } else if (s.method === 'win') {
    spawn(s.file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
  } else {
    const target = appImage()
    if (!target) throw new Error("the AppImage's folder can't be written to")
    // the new file takes the old one's name, or the new version's where the old name carried the version
    const base = path.basename(target)
    const next = path.join(path.dirname(target), base.includes(__APP_VERSION__) ? base.replace(__APP_VERSION__, s.version) : base)
    const tmp = path.join(path.dirname(target), `.${path.basename(next)}.new`)
    fs.copyFileSync(s.file, tmp)
    fs.chmodSync(tmp, 0o755)
    fs.renameSync(tmp, next)
    if (next !== target) fs.rmSync(target, { force: true })
    // started once this process is gone, or the single-instance lock hands it straight back to this one
    const out = helperLog()
    try {
      spawn('/bin/sh', ['-c', WAIT_THEN_RUN, 'claudock-update', String(process.pid), next], { detached: true, stdio: ['ignore', out, out], env: { ...cleanEnv(), APPIMAGE: next } }).unref()
    } finally {
      fs.closeSync(out)
    }
  }
  app.quit()
}
