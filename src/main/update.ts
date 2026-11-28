import { net } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { UpdateInfo, WhatsNew, WhatsNewNote } from '@shared/types'
import { installKind, userDataDir } from './paths'
import { loadPrefs, ranBefore, savePrefs } from './prefs'
import { noteScreen, parseNotes } from './releaseNotes'
import { feedName, feedOverride, parseFeed } from './updateFeed'
import { feedFile, installMethod, takeUpdateFailure } from './updateInstall'
import { compareVersions, isPrerelease, pickUpdate, type Channel, type Pick } from './updateChannel'

declare const __APP_VERSION__: string

/**
 * New-version check. A stable build asks GitHub for the latest published release (drafts and pre-releases are never
 * "latest"); a beta build asks npm for the `latest` and `beta` dist-tags, the same tags `npx claudock@…` installs from,
 * and takes whichever is newer (see pickUpdate). The release's body gives the popover's highlights (its "What's new"
 * notes, src/main/releaseNotes.ts), and its update feed the download's size (src/main/updateInstall.ts). One check per
 * launch, repeated at most every six hours; nothing about the user or their config is sent. Skipped with
 * CLAUDOCK_OFFLINE=1, in screenshot mode and in a git clone.
 *
 * CLAUDOCK_LATEST_VERSION=0.9.0 answers as if that were the newest release (a pre-release value as the newest beta),
 * without a request, in any build (to see the notice in `npm run dev`). CLAUDOCK_UPDATE_FEED=<folder URL> reads the
 * release from that folder instead (src/main/updateFeed.ts), so a fake release served on this computer can be installed.
 *
 * What's new (W1): the running version's notes, from its release body, cached in <userData>/release-notes.json. They
 * show by themselves on the first open of a newer version than the one last seen (prefs `seenVersion`), never on a first
 * install.
 */

const API = 'https://api.github.com/repos/behkha/claudock'
const LATEST_URL = `${API}/releases/latest`
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/claudock/dist-tags'
const RELEASES_URL = 'https://github.com/behkha/claudock/releases'
const FETCH_TIMEOUT_MS = 10_000
const RECHECK_MS = 6 * 60 * 60_000
const FEED_RECHECK_MS = 5 * 60_000

/** A newer release as checked, before it is matched against what this copy can do. */
interface Found {
  version: string
  url: string
  channel: Channel
  highlights: string[]
  size: number | null
  /** The feed names a file this copy can update from. */
  file: boolean
}

let last: { at: number; result: Promise<Found | null> } | undefined
let feedFailed = false
/** Screenshot mode: the release the footer shows (src/main/shot.ts). */
let shotFound: Found | null = null

const offline = (): boolean => process.env.CLAUDOCK_OFFLINE === '1' || process.env.CLAUDOCK_SHOT === '1'

function toInfo(f: Found | null): UpdateInfo | null {
  if (!f) return null
  const method = installMethod()
  const npm = installKind() !== 'installer'
  return {
    version: f.version,
    url: f.url,
    command: npm ? `npx claudock@${f.channel}` : null,
    installable: method === 'npm' || (method !== null && f.file),
    size: method === 'npm' ? null : f.size,
    highlights: f.highlights
  }
}

async function get(url: string, accept: string): Promise<Response> {
  const res = await net.fetch(url, {
    headers: { Accept: accept, 'User-Agent': `Claudock/${__APP_VERSION__}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: 'no-store'
  })
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`)
  return res
}

const getJson = async (url: string, accept: string): Promise<Record<string, unknown>> => (await get(url, accept)).json() as Promise<Record<string, unknown>>

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const releaseUrl = (v: unknown, version: string): string => {
  const u = str(v)
  return u && (u.startsWith(RELEASES_URL + '/') || feedOverride()) ? u : `${RELEASES_URL}/tag/v${version}`
}

// ---------- release notes cache ----------

type NotesCache = Record<string, { url: string; notes: WhatsNewNote[] }>
const notesFile = (): string => path.join(userDataDir(), 'release-notes.json')

async function readNotes(): Promise<NotesCache> {
  try {
    return JSON.parse(await fsp.readFile(notesFile(), 'utf8')) as NotesCache
  } catch {
    return {}
  }
}

/** Keep `version`'s notes (and the five newest others), so What's new has them after the restart, offline too. */
export async function cacheNotes(version: string, url: string, notes: WhatsNewNote[]): Promise<void> {
  if (!notes.length) return
  const all = await readNotes()
  all[version] = { url, notes }
  const keep = Object.keys(all)
    .sort((a, b) => compareVersions(b, a))
    .slice(0, 6)
  const next = Object.fromEntries(keep.map((v) => [v, all[v]]))
  try {
    await fsp.mkdir(userDataDir(), { recursive: true })
    const tmp = `${notesFile()}.${process.pid}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2) + '\n')
    await fsp.rename(tmp, notesFile())
  } catch (e) {
    console.warn(`Release notes not cached: ${(e as Error).message}`)
  }
}

/** A release's body and page: from the feed folder's release.json, or GitHub's release for the tag. */
async function fetchRelease(version: string): Promise<{ body: string; url: string } | null> {
  const feed = feedOverride()
  try {
    const r = feed ? await getJson(new URL('release.json', feed).toString(), 'application/json') : await getJson(`${API}/releases/tags/v${version}`, 'application/vnd.github+json')
    if (feed && str(r.tag_name)?.replace(/^v/, '') !== version) return null
    return { body: str(r.body) ?? '', url: releaseUrl(r.html_url, version) }
  } catch (e) {
    console.warn(`Release notes for ${version} not fetched: ${(e as Error).message}`)
    return null
  }
}

// ---------- the check ----------

async function found(pick: Pick | null, url: string, body: string | null): Promise<Found | null> {
  if (!pick) return null
  const notes = body ? parseNotes(body) : []
  await cacheNotes(pick.version, url, notes)
  let size: number | null = null
  let file = false
  const method = installMethod()
  if (method && method !== 'npm') {
    try {
      const f = await feedFile(pick.version)
      file = f !== null
      size = f?.size ?? null
    } catch (e) {
      console.warn(`Update feed for ${pick.version} not read: ${(e as Error).message}`)
      feedFailed = true
    }
  }
  return { version: pick.version, url, channel: pick.channel, highlights: notes.slice(0, 3).map((n) => n.title), size, file }
}

async function fetchLatest(): Promise<Found | null> {
  const body = await getJson(LATEST_URL, 'application/vnd.github+json')
  if (typeof body.tag_name !== 'string') throw new Error('the release has no tag')
  const pick = pickUpdate(__APP_VERSION__, { latest: body.tag_name })
  return found(pick, releaseUrl(body.html_url, pick?.version ?? ''), str(body.body))
}

/** GitHub's /releases/latest never shows a pre-release, so the release is read by its tag. */
async function fetchDistTags(): Promise<Found | null> {
  const body = await getJson(DIST_TAGS_URL, 'application/json')
  const tag = (name: Channel): string | undefined => (typeof body[name] === 'string' ? body[name] : undefined)
  const pick = pickUpdate(__APP_VERSION__, { latest: tag('latest'), beta: tag('beta') })
  if (!pick) return null
  const rel = await fetchRelease(pick.version)
  return found(pick, rel?.url ?? `${RELEASES_URL}/tag/v${pick.version}`, rel?.body ?? null)
}

/** CLAUDOCK_UPDATE_FEED: the folder's yml names the version, its release.json the notes. */
async function fetchFeed(feed: string): Promise<Found | null> {
  const name = feedName()
  if (!name) return null
  const { version } = parseFeed(await (await get(new URL(name, feed).toString(), 'text/yaml, */*')).text())
  const pick = pickUpdate(__APP_VERSION__, { [isPrerelease(version) ? 'beta' : 'latest']: version })
  if (!pick) return null
  const rel = await fetchRelease(pick.version)
  return found(pick, rel?.url ?? feed, rel?.body ?? null)
}

async function fetchUpdate(): Promise<Found | null> {
  try {
    const feed = feedOverride()
    if (feed) return await fetchFeed(feed)
    return await (isPrerelease(__APP_VERSION__) ? fetchDistTags() : fetchLatest())
  } catch (e) {
    console.warn(`Update check failed: ${(e as Error).message}`)
    return null
  }
}

export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (shotFound) return { ...(toInfo(shotFound) as UpdateInfo), installable: true, size: shotFound.size }
  const fake = process.env.CLAUDOCK_LATEST_VERSION?.trim()
  if (fake) {
    const pick = pickUpdate(__APP_VERSION__, { [isPrerelease(fake) ? 'beta' : 'latest']: fake })
    return toInfo(pick && { version: pick.version, url: `${RELEASES_URL}/latest`, channel: pick.channel, highlights: [], size: null, file: false })
  }
  if (offline()) return null
  // a git clone never asks GitHub; CLAUDOCK_UPDATE_FEED is asked anywhere, being on purpose
  if (installKind() === 'dev' && !feedOverride()) return null
  // a feed that couldn't be read offers Download for now, so it is asked again sooner
  if (!last || Date.now() - last.at > (feedFailed ? FEED_RECHECK_MS : RECHECK_MS)) {
    feedFailed = false
    last = { at: Date.now(), result: fetchUpdate() }
  }
  return toInfo(await last.result)
}

/** Screenshot mode: the footer offers this release (installable, `size` bytes) with these notes. */
export async function showUpdateForShot(version: string, notes: WhatsNewNote[], size: number): Promise<UpdateInfo | null> {
  await cacheNotes(version, `${RELEASES_URL}/tag/v${version}`, notes)
  shotFound = { version, url: `${RELEASES_URL}/tag/v${version}`, channel: 'latest', highlights: notes.slice(0, 3).map((n) => n.title), size, file: true }
  return checkUpdate()
}

export function clearUpdateForShot(): void {
  shotFound = null
}

// ---------- What's new ----------

/**
 * The running version's notes, and whether they show by themselves: the first open of a version newer than the last
 * one seen. A first install records its version without showing; so does a downgrade. Screenshot mode and a git clone
 * never show them by themselves (CLAUDOCK_WHATS_NEW=1 does, in any build).
 */
export async function whatsNew(): Promise<WhatsNew> {
  const version = __APP_VERSION__
  const forced = process.env.CLAUDOCK_WHATS_NEW === '1'
  let first = false
  if (forced) first = true
  else if (process.env.CLAUDOCK_SHOT !== '1' && installKind() !== 'dev') {
    const seen = (await loadPrefs()).seenVersion
    if (seen === null && !(await ranBefore())) await savePrefs({ seenVersion: version })
    else if (seen === null || compareVersions(version, seen) > 0) first = true
    else if (seen !== version) await savePrefs({ seenVersion: version })
  }
  let cached = (await readNotes())[version]
  // asked once per run: a release with no "What's new" isn't asked again on every click of the footer
  if (!cached && !askedRelease && !offline() && (installKind() !== 'dev' || feedOverride())) {
    askedRelease = true
    const rel = await fetchRelease(version)
    const notes = rel ? parseNotes(rel.body) : []
    if (rel && notes.length) {
      cached = { url: rel.url, notes }
      await cacheNotes(version, rel.url, notes)
    }
  }
  // the cache was written by the version that checked; this one's screens decide where a note links
  const notes = (cached?.notes ?? []).map((n) => ({ ...n, screen: noteScreen(`${n.title} ${n.text}`) }))
  return { version, url: cached?.url ?? `${RELEASES_URL}/tag/v${version}`, notes, first, failure: await takeUpdateFailure() }
}

let askedRelease = false

/** The sheet was closed: it doesn't show by itself again for this version. */
export async function seenWhatsNew(): Promise<void> {
  if (process.env.CLAUDOCK_WHATS_NEW === '1' || process.env.CLAUDOCK_SHOT === '1') return
  await savePrefs({ seenVersion: __APP_VERSION__ })
}
