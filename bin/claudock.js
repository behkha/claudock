#!/usr/bin/env node
/**
 * `npx claudock`: runs the built app (package.json `main`, out/main/index.js) with the Electron that npm installed beside
 * it as a peer dependency. Files npm downloads carry no macOS quarantine flag or Windows Mark of the Web, so there is no
 * Gatekeeper or SmartScreen prompt. Arguments go through to the app; its exit code and termination signals come back.
 */
'use strict'
const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

let electron
try {
  // From Node, the electron package exports the path to its binary (downloading it on first use).
  electron = require('electron')
} catch (e) {
  console.error(`claudock: could not find Electron (${String(e instanceof Error ? e.message : e).split('\n')[0]}).`)
  console.error('Run it with npm 7 or later, which installs Electron with it: npx claudock@latest')
  process.exit(1)
}

const env = { ...process.env }
// Set by some editors' terminals; it would make Electron run as plain Node and ignore the app.
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env, windowsHide: false })

child.on('error', (e) => {
  console.error(`claudock: could not start Electron at ${electron}: ${e.message}`)
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
