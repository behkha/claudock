#!/usr/bin/env node
/**
 * Builds ./.fixture/claude with the synthetic config from src/main/demo/fixture.ts (nothing is copied from the real ~/.claude),
 * and ./.fixture/claude-work beside it (src/main/demo/workFixture.ts), the second profile Add profile finds.
 * Run with `npm run fixture`; then point the app at it with CLAUDE_CONFIG_DIR=./.fixture/claude (`npm run dev` does).
 * Node runs the TypeScript directly, so callers pass --experimental-strip-types (the default from Node 22.18).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFixture } from '../src/main/demo/fixture.ts'
import { buildWorkFixture } from '../src/main/demo/workFixture.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = path.join(root, '.fixture')
const dir = path.join(base, 'claude')
if (path.basename(dir) !== 'claude' || path.basename(path.dirname(dir)) !== '.fixture') throw new Error('refusing odd fixture path')
fs.rmSync(base, { recursive: true, force: true })
buildFixture(dir)
buildWorkFixture(path.join(base, 'claude-work'))

// sanity: the fixture must not contain anything from a real home folder
const fixtureSize = (function size(p) {
  const s = fs.lstatSync(p)
  if (!s.isDirectory()) return s.size
  return fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0)
})(dir)
console.log(`fixture ready: ${dir} (${(fixtureSize / 1024 / 1024).toFixed(1)} MB)`)
console.log('use it with: CLAUDE_CONFIG_DIR=./.fixture/claude npm run dev')
