import { net } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { MODEL_CATALOG_SOURCES, type BuiltModelCatalog, type ModelCatalog } from '@shared/modelCatalog'
import { buildModelCatalog, validateModelCatalog } from '@shared/modelCatalogBuild'
import { emit } from './ipcx'
import { userDataDir } from './paths'
import bundledJson from './modelCatalog.bundled.json'

/**
 * The model catalogue (models, prices, aliases), read the way the settings docs are (src/main/settingsDocs.ts): every
 * launch downloads Anthropic's public pricing page and Claude Code's model configuration page (main process only),
 * builds and checks them, and caches the result in <userData>/model-catalog.json. When a page is unreachable or no
 * longer reads right, the newer of the cache and the copy bundled with the app answers (`npm run model-catalog`
 * rebuilds the bundled one). A failed fetch is tried again when the catalogue is asked for more than five minutes
 * later. CLAUDOCK_OFFLINE=1 skips the fetch. Two plain GETs: nothing about the user or their config is sent.
 */

const FETCH_TIMEOUT_MS = 10_000
const RETRY_AFTER_MS = 5 * 60_000
/** Larger pages are refused: the real ones are well under 1 MB. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

let live: ModelCatalog | undefined
let fetchError: string | undefined
let inflight: Promise<void> | undefined
let lastAttempt = 0
let cached: Promise<ModelCatalog | undefined> | undefined

const cacheFile = (): string => path.join(userDataDir(), 'model-catalog.json')

/** A failure whose message is fit to show the user: a clause that reads right after "because". */
class FetchProblem extends Error {}

async function get(url: string): Promise<string> {
  const h = new URL(url).host
  try {
    const res = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), credentials: 'omit' })
    if (!res.ok) throw new FetchProblem(`${h} answered HTTP ${res.status}`)
    const text = await res.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new FetchProblem(`${h} sent a page over 4 MB`)
    return text
  } catch (e) {
    if (e instanceof FetchProblem) throw e
    const timedOut = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError'
    throw new FetchProblem(timedOut ? `${h} did not answer within ${FETCH_TIMEOUT_MS / 1000} s` : `${h} could not be reached`, { cause: e })
  }
}

const LAYOUT_PROBLEM = "Anthropic's pricing page has a layout Claudock can't read yet"

async function fetchLive(): Promise<ModelCatalog> {
  const [pricing, aliases] = await Promise.all([get(MODEL_CATALOG_SOURCES.pricing), get(MODEL_CATALOG_SOURCES.aliases)])
  let built: BuiltModelCatalog
  try {
    built = buildModelCatalog({ pricing, aliases, builtAt: new Date().toISOString(), sources: [MODEL_CATALOG_SOURCES.pricing, MODEL_CATALOG_SOURCES.aliases] })
  } catch (e) {
    console.warn(`model catalogue: ${(e as Error).message}`)
    throw new FetchProblem(LAYOUT_PROBLEM, { cause: e })
  }
  const problem = validateModelCatalog(built)
  if (problem) {
    console.warn(`model catalogue: ${problem}`)
    throw new FetchProblem(LAYOUT_PROBLEM)
  }
  return { ...built, origin: 'live' }
}

async function writeCache(c: ModelCatalog): Promise<void> {
  const { origin: _origin, fetchError: _error, ...data } = c
  await fsp.mkdir(path.dirname(cacheFile()), { recursive: true })
  const tmp = cacheFile() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(data))
  await fsp.rename(tmp, cacheFile())
}

async function run(): Promise<void> {
  try {
    live = await fetchLive()
    fetchError = undefined
    await writeCache(live).catch(() => undefined)
    emit('settings:models', live)
  } catch (e) {
    const m = e instanceof FetchProblem ? e.message : 'the pages could not be loaded'
    fetchError = m.charAt(0).toLowerCase() + m.slice(1)
  } finally {
    inflight = undefined
  }
}

/** Download the pages in the background. Call once at startup; `getModelCatalog` picks the result up. */
export function startModelCatalogFetch(): void {
  if (process.env.CLAUDOCK_SHOT === '1' || process.env.CLAUDOCK_OFFLINE === '1' || inflight) return
  lastAttempt = Date.now()
  inflight = run()
}

async function readCache(): Promise<ModelCatalog | undefined> {
  try {
    const data = JSON.parse(await fsp.readFile(cacheFile(), 'utf8')) as BuiltModelCatalog
    return validateModelCatalog(data) ? undefined : { ...data, origin: 'cache' }
  } catch {
    return undefined
  }
}

/** The saved copy or the one bundled with the app, whichever was built later (an app update can ship a newer one). */
async function fallback(): Promise<ModelCatalog> {
  cached ??= readCache()
  const saved = await cached
  const bundled: ModelCatalog = { ...(bundledJson as unknown as BuiltModelCatalog), origin: 'bundled' }
  return saved && Date.parse(saved.builtAt) >= Date.parse(bundled.builtAt) ? saved : bundled
}

/**
 * This launch's catalogue once fetched, else the newer of the cached and bundled copies, at once: nothing waits on the
 * network. The fetched one follows as `settings:models`.
 */
export async function getModelCatalog(): Promise<ModelCatalog> {
  if (live) return live
  if (fetchError && !inflight && Date.now() - lastAttempt > RETRY_AFTER_MS) startModelCatalogFetch()
  const older = await fallback()
  if (live) return live
  return fetchError ? { ...older, fetchError } : older
}
