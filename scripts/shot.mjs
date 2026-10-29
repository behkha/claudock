#!/usr/bin/env node
/**
 * Screenshot every screen (light then dark) on the synthetic fixture, headlessly.
 *
 *   npm run shot                       all screens + palette -> ./.shots/<theme>-<screen>.png
 *   npm run shot -- --only skills,agents   only those screens (use "palette" for the command palette, "settings-json" for the Settings JSON view with the completion popup, "share" for the Today share dialog and its card.png; "connect" connects to Claude Code from the Today card, plays one status line run and three sessions through the hooks, shoots connect (the sheet), connected (the card), connected-hooks (the Hooks screen, Claudock's hooks as one row and out of the counts) and disconnect (the dialog that row opens), checks exactly one alert was posted, disconnects and fails unless settings.json is byte for byte as before; "menubar" connects, plays the same sessions and limits, shoots menubar (the popover) and menubar-settings (its settings view), checks the limit alert posts once at 85% and not again at 90%, then disconnects; "profiles" connects, adds ~/.claude-work from the Add profile sheet (profiles-add), shoots the title bar menu with both (profiles-menu) and the popover (profiles-menubar), switches back, disconnects and removes the profile, failing unless settings.json is byte for byte as before; "archive" (the Sessions screen) plays Claude Code deleting the oldest session's transcript, finds it by a word of its title (archive-search, opened at the line that matched) and resumes it (archive-resume), failing unless it was hard-linked before, shows as Archived after, comes back byte for byte dated now, and exports to Markdown with its title; "mods" also shoots mods-draft, the draft selected; "reveal" shoots the first-run reveal (reveal), the Connect sheet over it (reveal-connect), Today after Connect (reveal-connected) and, in light, the version with no stats (reveal-empty), then disconnects and fails unless settings.json is byte for byte as before)
 *   npm run shot -- --out ./.shots/mine    other output folder (parallel workers: use your own)
 *   npm run record                     the launch film's takes (src/main/record.ts) on a freshly made fixture, into
 *                                      ./.shots/record: each take as <theme>-<take>.mp4 (60 fps) with <theme>-<take>.json
 *                                      (frame times, clicks and cues), the screenshots in stills/ and, scaled to
 *                                      1920x1080, in stills/1080/, and strings.json
 *
 * Builds into a private temp folder (so parallel runs never overwrite each other's ./out), launches Electron with
 * CLAUDOCK_SHOT=1 and a temp HOME holding a copy of ./.fixture/claude as .claude (so shots show "~/.claude", like a
 * real install, instead of the fixture path), prints "SHOT <file>" per image and "CONSOLE_ERROR ..." for
 * renderer console errors. Exit code 0 = clean, 1 = console errors or failure.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const argVal = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const only = argVal('--only') ?? ''
// --real: look at the real config folder with every write refused (CLAUDOCK_READONLY), for checking real data
const real = args.includes('--real')
const record = args.includes('--record')
const outDir = path.resolve(argVal('--out') ?? path.join(root, '.shots', record ? 'record' : ''))
const fixture = path.join(root, '.fixture', 'claude')
const tmp = path.join(root, '.shots', `.tmp-${process.pid}`)
const buildDir = path.join(tmp, 'build')

// a recording needs today's sessions to be from today: always a fresh fixture
if (!real && (record || !fs.existsSync(fixture))) {
  console.log(record ? 'making a fresh fixture' : 'fixture missing, creating it')
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(root, 'scripts', 'make-fixture.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

fs.mkdirSync(outDir, { recursive: true })
if (!only && !record) for (const f of fs.readdirSync(outDir)) if (f.endsWith('.png')) fs.rmSync(path.join(outDir, f))
fs.mkdirSync(tmp, { recursive: true })

// A recording shows paths on screen (the Connect sheet's hook commands, the plugin records in settings.json): on macOS
// its HOME and userData go in a neutral shared folder, so nothing from this machine's own paths is in the film. Never a
// folder that isn't a recording's.
const shared = record && process.platform === 'darwin' ? '/Users/Shared/Claudock' : null
if (shared) {
  if (fs.existsSync(shared) && !fs.existsSync(path.join(shared, '.claudock-record'))) {
    console.error(`refusing to use ${shared}: it exists and isn't a recording's`)
    process.exit(1)
  }
  fs.rmSync(shared, { recursive: true, force: true })
  fs.mkdirSync(shared, { recursive: true })
  fs.writeFileSync(path.join(shared, '.claudock-record'), '')
}
const userData = shared ?? path.join(tmp, 'userData')

// Fixture shots: a copy of the fixture as HOME/.claude, so the app shows "~/.claude" (USERPROFILE is home on Windows).
// A copy, not a link, so the plugin records below can point at it without touching the fixture. File times and the
// fixture's own links are kept.
const home = path.join(shared ?? tmp, 'home')
if (!real) {
  const copy = path.join(home, '.claude')
  fs.cpSync(fixture, copy, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE })
  // the second profile, where Add profile finds it: ~/.claude-work
  const work = path.join(root, '.fixture', 'claude-work')
  if (fs.existsSync(work)) fs.cpSync(work, path.join(home, '.claude-work'), { recursive: true, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE })
  // Plugin and marketplace records hold absolute paths (as Claude Code writes them); point them at the copy.
  const [from, to] = [fixture, copy].map((p) => JSON.stringify(p).slice(1, -1))
  for (const rel of fs.readdirSync(copy, { recursive: true })) {
    const f = path.join(copy, String(rel))
    if (!f.endsWith('.json') || !fs.statSync(f).isFile()) continue
    const text = fs.readFileSync(f, 'utf8')
    if (!text.includes(from)) continue
    const { atime, mtime } = fs.statSync(f)
    fs.writeFileSync(f, text.replaceAll(from, to))
    fs.utimesSync(f, atime, mtime)
  }
}

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE // would turn Electron into plain Node
if (real) delete cleanEnv.CLAUDE_CONFIG_DIR

console.log('building…')
const build = spawnSync(process.execPath, [path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: { ...cleanEnv, CLAUDOCK_OUT_DIR: path.relative(root, buildDir) }
})
if (build.status !== 0) {
  fs.rmSync(tmp, { recursive: true, force: true })
  console.error('build failed')
  process.exit(build.status ?? 1)
}

console.log('capturing…')
const child = spawn(electronPath, [path.join(buildDir, 'main', 'index.js')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...cleanEnv,
    ...(real ? { CLAUDOCK_READONLY: '1' } : { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }),
    CLAUDOCK_SHOT: '1',
    ...(record ? { CLAUDOCK_RECORD: '1' } : {}),
    CLAUDOCK_SHOT_DIR: outDir,
    CLAUDOCK_SHOT_ONLY: only,
    CLAUDOCK_USER_DATA: userData
  }
})

let errors = 0
const relay = (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue
    // Chromium/macOS noise that is not from our renderer
    if (/ERROR:|Autofill|DevTools listening|IMKCFRunLoopWakeUpReliable|CoreText|TSM|GetVSyncParametersIfAvailable/.test(line) && !line.startsWith('CONSOLE_ERROR')) continue
    if (line.startsWith('CONSOLE_ERROR') || line.startsWith('SHOT_FAILED') || line.startsWith('RENDERER_GONE') || line.startsWith('RECORD_FAILED')) errors++
    console.log(line)
  }
}
// stopped from outside: take Electron down too, or it keeps running (and holds the single-instance lock) on its own
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill('SIGKILL'); process.exit(1) })
child.stdout.on('data', relay)
child.stderr.on('data', relay)

const limit = record ? 30 * 60 : 180
const timer = setTimeout(() => {
  console.log(`SHOT_FAILED timeout after ${limit} s`)
  errors++
  child.kill('SIGKILL')
}, limit * 1000)

child.on('exit', (code) => {
  clearTimeout(timer)
  fs.rmSync(tmp, { recursive: true, force: true })
  if (record) {
    if (shared) fs.rmSync(shared, { recursive: true, force: true })
    if (code === 0 && errors === 0) encode()
    process.exit(code === 0 && errors === 0 ? 0 : 1)
  }
  const pngs = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).length
  console.log(`${pngs} image(s) in ${path.relative(root, outDir) || '.'}`)
  process.exit(code === 0 && errors === 0 ? 0 : 1)
})

/** Each take's frames -> <take>.mp4 at a constant 60 fps (each frame held until the next one's time), and the stills at 1920x1080. */
function encode() {
  const ffmpeg = (a) => {
    const r = spawnSync('nice', ['-n', '19', 'ffmpeg', '-v', 'error', '-y', ...a], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${a.join(' ')}`)
  }
  for (const name of fs.readdirSync(outDir)) {
    const dir = path.join(outDir, name)
    if (!fs.existsSync(path.join(dir, 'take.json'))) continue
    const take = JSON.parse(fs.readFileSync(path.join(dir, 'take.json'), 'utf8'))
    const list = take.frames.map((fr, i) => `file '${fr.f}'\nduration ${((take.frames[i + 1]?.t ?? fr.t + 1000 / 60) - fr.t) / 1000}`)
    // the concat demuxer drops the last frame's duration unless the file is listed once more
    fs.writeFileSync(path.join(dir, 'list.txt'), `${list.join('\n')}\nfile '${take.frames.at(-1).f}'\n`)
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', 'fps=60,scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', '-pix_fmt', 'yuv420p', `${dir}.mp4`])
    fs.renameSync(path.join(dir, 'take.json'), `${dir}.json`)
    fs.rmSync(dir, { recursive: true, force: true })
    console.log(`TAKE ${path.relative(root, dir)}.mp4`)
  }
  const stills = path.join(outDir, 'stills')
  if (!fs.existsSync(stills)) return
  fs.mkdirSync(path.join(stills, '1080'), { recursive: true })
  for (const f of fs.readdirSync(stills).filter((n) => n.endsWith('.png'))) {
    // the window (2560x1440 on a 2x display) to 1920x1080; the popover keeps its size
    if (f.includes('menubar')) continue
    ffmpeg(['-i', path.join(stills, f), '-vf', 'scale=1920:1080:flags=lanczos', path.join(stills, '1080', f)])
  }
}
