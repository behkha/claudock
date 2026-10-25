#!/usr/bin/env node
/**
 * `npm run dev`: electron-vite dev server pointed at the synthetic fixture (never the real ~/.claude).
 * Set CLAUDE_CONFIG_DIR yourself to override. For a read-only look at your real folder use `npm run dev:real`.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, '.fixture', 'claude')
if (!process.env.CLAUDE_CONFIG_DIR) {
  if (!fs.existsSync(fixture)) spawnSync(process.execPath, [path.join(root, 'scripts', 'make-fixture.mjs')], { stdio: 'inherit' })
  process.env.CLAUDE_CONFIG_DIR = fixture
}
console.log(`config dir: ${process.env.CLAUDE_CONFIG_DIR}`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(process.execPath, [path.join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', env })
child.on('exit', (c) => process.exit(c ?? 0))
