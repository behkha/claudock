#!/usr/bin/env node
/**
 * Screenshot every screen (light then dark) on the synthetic fixture, headlessly.
 *
 *   npm run shot                       all screens + palette -> ./.shots/<theme>-<screen>.png
 *   npm run shot -- --only skills,agents   only those screens (use "palette" for the command palette, "settings-json" for the Settings JSON view with the completion popup, "share" for the Overview share dialog and its card.png; "mods" also shoots mods-draft, the draft selected)
 *   npm run shot -- --out ./.shots/mine    other output folder (parallel workers: use your own)
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
const outDir = path.resolve(argVal('--out') ?? path.join(root, '.shots'))
const fixture = path.join(root, '.fixture', 'claude')
const tmp = path.join(root, '.shots', `.tmp-${process.pid}`)
const buildDir = path.join(tmp, 'build')

if (!real && !fs.existsSync(fixture)) {
  console.log('fixture missing, creating it')
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'make-fixture.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

fs.mkdirSync(outDir, { recursive: true })
if (!only) for (const f of fs.readdirSync(outDir)) if (f.endsWith('.png')) fs.rmSync(path.join(outDir, f))
fs.mkdirSync(tmp, { recursive: true })

// Fixture shots: a copy of the fixture as HOME/.claude, so the app shows "~/.claude" (USERPROFILE is home on Windows).
// A copy, not a link, so the plugin records below can point at it without touching the fixture. File times and the
// fixture's own links are kept.
const home = path.join(tmp, 'home')
if (!real) {
  const copy = path.join(home, '.claude')
  fs.cpSync(fixture, copy, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE })
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
    CLAUDOCK_SHOT_DIR: outDir,
    CLAUDOCK_SHOT_ONLY: only,
    CLAUDOCK_USER_DATA: path.join(tmp, 'userData')
  }
})

let errors = 0
const relay = (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue
    // Chromium/macOS noise that is not from our renderer
    if (/ERROR:|Autofill|DevTools listening|IMKCFRunLoopWakeUpReliable|CoreText|TSM|GetVSyncParametersIfAvailable/.test(line) && !line.startsWith('CONSOLE_ERROR')) continue
    if (line.startsWith('CONSOLE_ERROR') || line.startsWith('SHOT_FAILED') || line.startsWith('RENDERER_GONE')) errors++
    console.log(line)
  }
}
child.stdout.on('data', relay)
child.stderr.on('data', relay)

const timer = setTimeout(() => {
  console.log('SHOT_FAILED timeout after 180 s')
  errors++
  child.kill('SIGKILL')
}, 180_000)

child.on('exit', (code) => {
  clearTimeout(timer)
  fs.rmSync(tmp, { recursive: true, force: true })
  const pngs = fs.readdirSync(outDir).filter((f) => f.endsWith('.png')).length
  console.log(`${pngs} image(s) in ${path.relative(root, outDir) || '.'}`)
  process.exit(code === 0 && errors === 0 ? 0 : 1)
})
