import fs from 'node:fs'
import path from 'node:path'
import { buildFixture } from './fixture'
import { buildWorkFixture } from './workFixture'

/**
 * `--demo` (`npx claudock --demo`): Claudock on a made-up config, for filming without showing real projects. It runs as
 * its own copy: app data in "Claudock Demo" beside "Claudock" (so its own snapshots, prefs and single-instance lock, and
 * it can run next to the real one), and CLAUDE_CONFIG_DIR pointed at a fixture rebuilt in that folder on every launch,
 * so the dates always look current and nothing from the last demo is left.
 */
export const demoMode = process.argv.includes('--demo')

export const DEMO_APP_DATA_NAME = 'Claudock Demo'

/** The fixture lives in `<demo userData>/claude`. Set the env var first: everything reads the config dir through it. */
export function startDemo(userData: string): void {
  const dir = path.join(userData, 'claude')
  process.env.CLAUDE_CONFIG_DIR = dir
  fs.rmSync(dir, { recursive: true, force: true })
  buildFixture(dir)
  // a second account beside it, for filming profiles: Add profile finds it there
  const work = path.join(userData, 'claude-work')
  fs.rmSync(work, { recursive: true, force: true })
  buildWorkFixture(work)
}
