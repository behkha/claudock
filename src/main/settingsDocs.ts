import { net } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { SETTINGS_DOCS_FORMAT, SETTINGS_DOCS_PAGE, SETTINGS_DOCS_SOURCES, type SettingsDocs } from '@shared/settingsDocs'
import { buildSettingsDocs, validateSettingsDocs, type BuiltSettingsDocs } from '@shared/settingsDocsBuild'
import { emit } from './ipcx'
import { userDataDir } from './paths'
import bundledJson from './settingsDocs.bundled.json'

/**
 * Key docs for the Settings JSON editor. Every launch downloads Anthropic's public settings reference, env-vars page
 * and JSON schema (main process only; the renderer's CSP blocks network), builds them and caches the result in
 * <userData>/settings-docs.json. Offline, the newer of the cache and the copy bundled with the app answers
 * (`npm run settings-docs` rebuilds the bundled one). A failed fetch is tried again, in the background, when the editor
 * asks more than five minutes later. CLAUDOCK_OFFLINE=1 skips the fetch. Nothing about the user's config is sent.
 */

const FETCH_TIMEOUT_MS = 10_000
/** How long `getSettingsDocs` waits for a fetch still in flight before answering with the cache. */
const WAIT_MS = 4_000
/** A failed fetch is started again by the next `getSettingsDocs` once the last attempt is older than this. */
const RETRY_AFTER_MS = 5 * 60_000
/** Larger pages are refused: the real ones are well under 1 MB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

let live: SettingsDocs | undefined
let fetchError: string | undefined
let pending = false
let inflight: Promise<void> | undefined
let lastAttempt = 0
/** `getSettingsDocs` answered with an older copy while the fetch was running: tell the renderer when it ends. */
let answeredOlder = false
let cached: Promise<SettingsDocs | undefined> | undefined

const cacheFile = (): string => path.join(userDataDir(), 'settings-docs.json')

const host = (url: string): string => new URL(url).host

/** A failure whose message is fit to show the user: a clause that reads right after "because". */
class FetchProblem extends Error {}

async function get(url: string): Promise<string> {
  const h = host(url)
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new FetchProblem(`${h} answered HTTP ${res.status}`)
    if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) throw new FetchProblem(`${h} sent a page over 8 MB`)
    // inside the try: the timeout also covers the body, and its error should name the host too
    const text = await res.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new FetchProblem(`${h} sent a page over 8 MB`)
    return text
  } catch (e) {
    if (e instanceof FetchProblem) throw e
    const timedOut = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError'
    throw new FetchProblem(timedOut ? `${h} did not answer within ${FETCH_TIMEOUT_MS / 1000} s` : `${h} could not be reached`, { cause: e })
  }
}

/**
 * Whichever URL answers first (asked in parallel: json.schemastore.org can hang until the timeout while its mirror
 * answers at once). The error names every host that failed.
 */
async function getFirst(urls: readonly string[]): Promise<{ url: string; text: string }> {
  try {
    return await Promise.any(urls.map(async (url) => ({ url, text: await get(url) })))
  } catch (e) {
    throw new FetchProblem((e as AggregateError).errors.map((x: Error) => x.message).join('; '), { cause: e })
  }
}

const LAYOUT_PROBLEM = "the docs page has a layout Claudock can't read yet"

async function fetchLive(): Promise<SettingsDocs> {
  const [reference, envVars, schema] = await Promise.all([get(SETTINGS_DOCS_SOURCES.reference), get(SETTINGS_DOCS_SOURCES.envVars), getFirst(SETTINGS_DOCS_SOURCES.schema)])
  let built: BuiltSettingsDocs
  try {
    built = buildSettingsDocs({
      reference,
      envVars,
      schema: JSON.parse(schema.text),
      docsPage: SETTINGS_DOCS_PAGE,
      format: SETTINGS_DOCS_FORMAT,
      builtAt: new Date().toISOString(),
      sources: [SETTINGS_DOCS_SOURCES.reference, SETTINGS_DOCS_SOURCES.envVars, schema.url]
    })
  } catch (e) {
    console.warn(`settings docs: could not build them: ${(e as Error).message}`)
    throw new FetchProblem(LAYOUT_PROBLEM, { cause: e })
  }
  const problem = validateSettingsDocs(built)
  if (problem) {
    console.warn(`settings docs: ${problem}`)
    throw new FetchProblem(LAYOUT_PROBLEM)
  }
  return { ...built, origin: 'live' }
}

async function writeCache(docs: SettingsDocs): Promise<void> {
  const { origin: _origin, fetchError: _error, ...data } = docs
  await fsp.mkdir(path.dirname(cacheFile()), { recursive: true })
  const tmp = cacheFile() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(data))
  await fsp.rename(tmp, cacheFile())
}

/** What `fetchError` shows after "because": a clause of ours, lower-case first, never a raw internal message. */
function describeError(e: unknown): string {
  const m = e instanceof FetchProblem ? e.message : 'the docs could not be loaded'
  return m.charAt(0).toLowerCase() + m.slice(1)
}

async function run(): Promise<void> {
  try {
    const docs = await fetchLive()
    live = docs
    fetchError = undefined
    await writeCache(docs).catch(() => undefined)
    if (answeredOlder) emit('settings:docs', docs)
  } catch (e) {
    fetchError = describeError(e)
    // the editor already got the fallback copy without any error: tell it why it stays on that copy
    if (answeredOlder) emit('settings:docs', { ...(await fallback()), fetchError })
  } finally {
    pending = false
    answeredOlder = false
    inflight = undefined
  }
}

/** Download the docs in the background. Call once at startup; `getSettingsDocs` picks the result up. */
export function startSettingsDocsFetch(): void {
  if (process.env.CLAUDOCK_SHOT === '1' || process.env.CLAUDOCK_OFFLINE === '1' || inflight) return
  pending = true
  lastAttempt = Date.now()
  inflight = run()
}

async function readCache(): Promise<SettingsDocs | undefined> {
  try {
    const data = JSON.parse(await fsp.readFile(cacheFile(), 'utf8')) as BuiltSettingsDocs
    if (data.format !== SETTINGS_DOCS_FORMAT || typeof data.builtAt !== 'string' || Number.isNaN(Date.parse(data.builtAt)) || validateSettingsDocs(data)) return undefined
    return { ...data, origin: 'cache' }
  } catch {
    return undefined
  }
}

/** The saved copy or the one bundled with the app, whichever was built later (an app update can ship a newer one). */
async function fallback(): Promise<SettingsDocs> {
  cached ??= readCache()
  const saved = await cached
  const bundled: SettingsDocs = { ...(bundledJson as unknown as BuiltSettingsDocs), origin: 'bundled' }
  return saved && Date.parse(saved.builtAt) >= Date.parse(bundled.builtAt) ? saved : bundled
}

/** This launch's docs when fetched, else the newer of the cached and bundled copies. Waits briefly for a fetch in flight. */
export async function getSettingsDocs(): Promise<SettingsDocs> {
  if (!live && inflight && pending) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([inflight, new Promise<void>((resolve) => (timer = setTimeout(resolve, WAIT_MS)))])
    clearTimeout(timer)
  }
  if (live) return live
  // the last fetch failed: the editor is asking again, so try once more in the background (not more than every few minutes)
  if (fetchError && !inflight && Date.now() - lastAttempt > RETRY_AFTER_MS) startSettingsDocsFetch()
  answeredOlder = pending
  const older = await fallback()
  if (live) return live
  return fetchError ? { ...older, fetchError } : older
}
