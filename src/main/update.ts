import { net } from 'electron'
import type { UpdateInfo } from '@shared/types'
import { installKind } from './paths'

declare const __APP_VERSION__: string

/**
 * New-version check. Squirrel.Mac can't update an ad-hoc signed app, so instead the app asks GitHub for the latest
 * published release (drafts and pre-releases are never "latest") and the renderer shows a notice. One request per launch,
 * repeated at most every six hours; nothing about the user or their config is sent. Skipped with CLAUDOCK_OFFLINE=1, in
 * screenshot mode and in a git clone. CLAUDOCK_LATEST_VERSION=0.9.0 answers as if that were the latest, without a request,
 * in any build (to see the notice in `npm run dev`).
 */

const LATEST_URL = 'https://api.github.com/repos/behkha/claudock/releases/latest'
const RELEASES_URL = 'https://github.com/behkha/claudock/releases'
const NPM_COMMAND = 'npx claudock@latest'
const FETCH_TIMEOUT_MS = 10_000
const RECHECK_MS = 6 * 60 * 60_000

let last: { at: number; result: Promise<UpdateInfo | null> } | undefined

type Version = { nums: number[]; pre: string | null }

function parse(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim())
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null
}

/** Positive when `a` is newer than `b` (semver order; pre-release identifiers compared as a whole). */
export function compareVersions(a: string, b: string): number {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  return x.pre.localeCompare(y.pre, 'en', { numeric: true })
}

function info(version: string, url: string): UpdateInfo | null {
  if (compareVersions(version, __APP_VERSION__) <= 0) return null
  return { version: version.replace(/^v/, ''), url, command: installKind() === 'installer' ? null : NPM_COMMAND }
}

async function fetchLatest(): Promise<UpdateInfo | null> {
  try {
    const res = await net.fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Claudock/${__APP_VERSION__}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`api.github.com answered HTTP ${res.status}`)
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
    if (typeof body.tag_name !== 'string') throw new Error('the release has no tag')
    const url = typeof body.html_url === 'string' && body.html_url.startsWith(RELEASES_URL + '/') ? body.html_url : `${RELEASES_URL}/latest`
    return info(body.tag_name, url)
  } catch (e) {
    console.warn(`Update check failed: ${(e as Error).message}`)
    return null
  }
}

export function checkUpdate(): Promise<UpdateInfo | null> {
  const fake = process.env.CLAUDOCK_LATEST_VERSION?.trim()
  if (fake) return Promise.resolve(info(fake, `${RELEASES_URL}/latest`))
  if (process.env.CLAUDOCK_OFFLINE === '1' || process.env.CLAUDOCK_SHOT === '1' || installKind() === 'dev') return Promise.resolve(null)
  if (!last || Date.now() - last.at > RECHECK_MS) last = { at: Date.now(), result: fetchLatest() }
  return last.result
}
