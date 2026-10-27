import { net } from 'electron'
import type { UpdateInfo } from '@shared/types'
import { installKind } from './paths'
import { isPrerelease, pickUpdate, type Channel, type Pick } from './updateChannel'

declare const __APP_VERSION__: string

/**
 * New-version check. Squirrel.Mac can't update an ad-hoc signed app, so instead the app asks for the newest release and
 * the renderer shows a notice. A stable build asks GitHub for the latest published release (drafts and pre-releases are
 * never "latest") and suggests `npx claudock@latest`. A beta build asks npm for the `latest` and `beta` dist-tags, the
 * same tags `npx claudock@…` installs from, and suggests whichever is newer (see pickUpdate). One request per launch,
 * repeated at most every six hours; nothing about the user or their config is sent. Skipped with CLAUDOCK_OFFLINE=1, in
 * screenshot mode and in a git clone. CLAUDOCK_LATEST_VERSION=0.9.0 answers as if that were the newest release (a
 * pre-release value as the newest beta), without a request, in any build (to see the notice in `npm run dev`).
 */

const LATEST_URL = 'https://api.github.com/repos/behkha/claudock/releases/latest'
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/claudock/dist-tags'
const RELEASES_URL = 'https://github.com/behkha/claudock/releases'
const FETCH_TIMEOUT_MS = 10_000
const RECHECK_MS = 6 * 60 * 60_000

let last: { at: number; result: Promise<UpdateInfo | null> } | undefined

function info(pick: Pick | null, url: string): UpdateInfo | null {
  if (!pick) return null
  return { version: pick.version, url, command: installKind() === 'installer' ? null : `npx claudock@${pick.channel}` }
}

async function getJson(url: string, accept: string): Promise<Record<string, unknown>> {
  const res = await net.fetch(url, {
    headers: { Accept: accept, 'User-Agent': `Claudock/${__APP_VERSION__}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

async function fetchLatest(): Promise<UpdateInfo | null> {
  const body = await getJson(LATEST_URL, 'application/vnd.github+json')
  if (typeof body.tag_name !== 'string') throw new Error('the release has no tag')
  const url = typeof body.html_url === 'string' && body.html_url.startsWith(RELEASES_URL + '/') ? body.html_url : `${RELEASES_URL}/latest`
  return info(pickUpdate(__APP_VERSION__, { latest: body.tag_name }), url)
}

/** GitHub's /releases/latest never shows a pre-release, so the release page is linked by tag. */
async function fetchDistTags(): Promise<UpdateInfo | null> {
  const body = await getJson(DIST_TAGS_URL, 'application/json')
  const tag = (name: Channel): string | undefined => (typeof body[name] === 'string' ? body[name] : undefined)
  const pick = pickUpdate(__APP_VERSION__, { latest: tag('latest'), beta: tag('beta') })
  return pick && info(pick, `${RELEASES_URL}/tag/v${pick.version}`)
}

async function fetchUpdate(): Promise<UpdateInfo | null> {
  try {
    return await (isPrerelease(__APP_VERSION__) ? fetchDistTags() : fetchLatest())
  } catch (e) {
    console.warn(`Update check failed: ${(e as Error).message}`)
    return null
  }
}

export function checkUpdate(): Promise<UpdateInfo | null> {
  const fake = process.env.CLAUDOCK_LATEST_VERSION?.trim()
  if (fake) return Promise.resolve(info(pickUpdate(__APP_VERSION__, { [isPrerelease(fake) ? 'beta' : 'latest']: fake }), `${RELEASES_URL}/latest`))
  if (process.env.CLAUDOCK_OFFLINE === '1' || process.env.CLAUDOCK_SHOT === '1' || installKind() === 'dev') return Promise.resolve(null)
  if (!last || Date.now() - last.at > RECHECK_MS) last = { at: Date.now(), result: fetchUpdate() }
  return last.result
}
