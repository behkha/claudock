#!/usr/bin/env node
/**
 * `npx claudock`: runs the built app (package.json `main`, out/main/index.js) with the Electron that npm installed beside
 * it as a peer dependency; on macOS through a Claudock.app made from that Electron (bin/macApp.js). Files npm downloads carry no macOS quarantine flag or Windows Mark of the Web, so there is no
 * Gatekeeper or SmartScreen prompt. Arguments go through to the app; its exit code and termination signals come back.
 */
'use strict'
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let electron
try {
  // From Node, the electron package exports the path to its binary (downloading it on first use).
  electron = require('electron')
} catch (e) {
  // Electron is a peer dependency, which npm skips when legacy-peer-deps is on
  const npx = __dirname.includes(`${path.sep}_npx${path.sep}`)
  console.error(`claudock: could not find Electron (${String(e instanceof Error ? e.message : e).split('\n')[0]}).`)
  console.error('npm leaves it out when its legacy-peer-deps setting is on. Run it with that setting off:')
  console.error(npx ? '  npx --legacy-peer-deps=false claudock@latest' : '  npm install -g claudock --legacy-peer-deps=false')
  process.exit(1)
}

const appRoot = path.join(__dirname, '..')
// macOS: a Claudock.app made from this Electron, so the app is named Claudock (bin/macApp.js); else Electron itself
const { macApp } = require('./macApp')
const own = macApp(electron, appRoot)

/**
 * Linux: Chromium's sandbox needs user namespaces or a root-owned chrome-sandbox, and Ubuntu 24.04 blocks the first for
 * apps outside a package. Like the AppImage's own launcher, probe with `unshare -Ur true` and run without the sandbox
 * when it fails, rather than abort.
 */
function sandboxArgs() {
  if (process.platform !== 'linux' || process.argv.includes('--no-sandbox')) return []
  try {
    const helper = fs.statSync(path.join(path.dirname(electron), 'chrome-sandbox'))
    if (helper.uid === 0 && helper.mode & 0o4000) return []
  } catch {
    /* no helper: the probe decides */
  }
  if (spawnSync('unshare', ['-Ur', 'true'], { stdio: 'ignore' }).status === 0) return []
  console.error("claudock: this system blocks Chromium's sandbox for apps outside a package, so Claudock runs without it.")
  return ['--no-sandbox']
}

const env = { ...process.env }
// Set by some editors' terminals; it would make Electron run as plain Node and ignore the app.
delete env.ELECTRON_RUN_AS_NODE

// Claudock.app loads its own copy of the app folder; plain Electron is told where the app is
const child = own
  ? spawn(own, process.argv.slice(2), { stdio: 'inherit', env, windowsHide: false })
  : spawn(electron, [...sandboxArgs(), appRoot, ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false })

child.on('error', (e) => {
  console.error(`claudock: could not start ${own ?? electron}: ${e.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  // a child killed by a signal exits 128 + its number, the shell convention (also on Windows, which has no signals)
  process.exit(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1))
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig)
  })
}
