'use strict'
/**
 * macOS only: the Claudock.app that `npx claudock` runs, so alerts, the Dock, the app menu and ⌘Tab say "Claudock"
 * instead of "Electron", and so Open at login has a path that doesn't change between runs (npx's cache folder does).
 *
 * <userData>/Claudock.app is npm's Electron.app copied as an APFS clone (no extra disk; a plain copy on other volumes),
 * with Claudock's name, bundle id and icon in its Info.plist, this package's app folder in Contents/Resources/app, and
 * an ad-hoc signature (npm's Electron is signed ad hoc too; files made on this Mac carry no quarantine flag). It is
 * rebuilt only when Electron, Claudock or the built app changes. `claudock-npm-copy.json` in the app folder records
 * that and tells the app it is still the npm copy (installKind() in src/main/paths.ts).
 *
 * Every failure returns null and bin/claudock.js runs plain Electron, as before. CLAUDOCK_PLAIN_ELECTRON=1 skips this.
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MARKER = 'claudock-npm-copy.json'
// not the installer's app.claudock: two bundles with one id confuse LaunchServices and Notification Center
const BUNDLE_ID = 'app.claudock.npm'
const PLIST_BUDDY = '/usr/libexec/PlistBuddy'

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })

/** Clone (APFS) or, across volumes, copy. */
function copy(from, to) {
  try {
    run('/bin/cp', ['-cR', from, to])
  } catch {
    fs.rmSync(to, { recursive: true, force: true })
    run('/bin/cp', ['-R', from, to])
  }
}

function setPlist(plist, key, value) {
  try {
    run(PLIST_BUDDY, ['-c', `Set :${key} ${value}`, plist])
  } catch {
    run(PLIST_BUDDY, ['-c', `Add :${key} string ${value}`, plist])
  }
}

/** A process runs this binary, with or without arguments (a login launch passes --login). */
function running(bin) {
  const pattern = `^${bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`
  try {
    run('/usr/bin/pgrep', ['-f', pattern])
    return true
  } catch {
    return false
  }
}

function build(electronApp, appRoot, target, stamp) {
  const tmp = `${target}.tmp-${process.pid}`
  // what an interrupted build or swap left behind
  const base = path.basename(target)
  for (const name of fs.readdirSync(path.dirname(target))) {
    if (name.startsWith(`${base}.tmp-`) || name.startsWith(`${base}.old-`)) fs.rmSync(path.join(path.dirname(target), name), { recursive: true, force: true })
  }
  console.error('claudock: preparing Claudock.app (once per version)…')
  try {
    copy(electronApp, tmp)
    const res = path.join(tmp, 'Contents', 'Resources')
    const plist = path.join(tmp, 'Contents', 'Info.plist')
    setPlist(plist, 'CFBundleIdentifier', BUNDLE_ID)
    setPlist(plist, 'CFBundleName', 'Claudock')
    setPlist(plist, 'CFBundleDisplayName', 'Claudock')
    fs.copyFileSync(path.join(appRoot, 'resources', 'icon.icns'), path.join(res, 'electron.icns'))
    fs.rmSync(path.join(res, 'default_app.asar'), { force: true })
    const app = path.join(res, 'app')
    fs.mkdirSync(app)
    for (const name of ['package.json', 'out', 'resources']) copy(path.join(appRoot, name), path.join(app, name))
    fs.writeFileSync(path.join(app, MARKER), JSON.stringify(stamp) + '\n')
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', tmp])
    // swap in one rename; the old copy goes after
    const old = `${target}.old-${process.pid}`
    const had = fs.existsSync(target)
    if (had) fs.renameSync(target, old)
    try {
      fs.renameSync(tmp, target)
    } catch (e) {
      if (had) fs.renameSync(old, target)
      throw e
    }
    if (had) fs.rmSync(old, { recursive: true, force: true })
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

/**
 * The binary to run instead of npm's Electron, or null to run that. `electron` is the path npm's electron package
 * exports (…/Electron.app/Contents/MacOS/Electron).
 */
function macApp(electron, appRoot) {
  if (process.platform !== 'darwin' || process.env.CLAUDOCK_PLAIN_ELECTRON === '1') return null
  // only an npm install: a git clone run through bin/ (node bin/claudock.js, npm link) stays a development copy,
  // whose writes to the real ~/.claude are refused (installKind() in src/main/paths.ts)
  if (path.basename(path.dirname(path.resolve(appRoot))) !== 'node_modules') return null
  try {
    const electronApp = path.resolve(electron, '..', '..', '..')
    if (!electronApp.endsWith('.app')) return null
    const userData = process.env.CLAUDOCK_USER_DATA || path.join(os.homedir(), 'Library', 'Application Support', 'Claudock')
    const target = path.join(userData, 'Claudock.app')
    const bin = path.join(target, 'Contents', 'MacOS', path.basename(electron))
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'))
    const electronVersion = JSON.parse(fs.readFileSync(path.join(electronApp, '..', '..', 'package.json'), 'utf8')).version
    const stamp = { version: pkg.version, electron: electronVersion, built: Math.round(fs.statSync(path.join(appRoot, 'out', 'main', 'index.js')).mtimeMs) }
    let have = null
    try {
      have = JSON.parse(fs.readFileSync(path.join(target, 'Contents', 'Resources', 'app', MARKER), 'utf8'))
    } catch {
      /* not built yet */
    }
    const current = have && have.version === stamp.version && have.electron === stamp.electron && have.built === stamp.built && fs.existsSync(bin)
    if (!current) {
      if (fs.existsSync(bin) && running(bin)) {
        // replacing a running app under it would break it: the running copy comes forward instead
        console.error(`claudock: Claudock ${have ? have.version : ''} is running. Quit it, then run npx claudock again to start ${stamp.version}.`)
        return bin
      }
      fs.mkdirSync(userData, { recursive: true })
      build(electronApp, appRoot, target, stamp)
    }
    return bin
  } catch (e) {
    console.error(`claudock: running as Electron (${String(e instanceof Error ? e.message : e).split('\n')[0]}).`)
    return null
  }
}

module.exports = { macApp, MARKER }
