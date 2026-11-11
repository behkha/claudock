#!/usr/bin/env node
/**
 * Rebuilds src/main/modelCatalog.bundled.json: the copy of Anthropic's model list and prices that ships with the app
 * and is the last fallback when a launch is offline and has no cache. Run with `npm run model-catalog` (needs network
 * and Node 22.12+). Fetches the same pages the app fetches at launch (MODEL_CATALOG_SOURCES in
 * src/shared/modelCatalog.ts), builds them with src/shared/modelCatalogBuild.ts, refuses a result that looks broken,
 * and writes the JSON. Refresh it before a release.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODEL_CATALOG_SOURCES } from '../src/shared/modelCatalog.ts'
import { buildModelCatalog, validateModelCatalog } from '../src/shared/modelCatalogBuild.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'src', 'main', 'modelCatalog.bundled.json')

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

const [pricing, aliases] = await Promise.all([get(MODEL_CATALOG_SOURCES.pricing), get(MODEL_CATALOG_SOURCES.aliases)])
const built = buildModelCatalog({ pricing, aliases, builtAt: new Date().toISOString(), sources: [MODEL_CATALOG_SOURCES.pricing, MODEL_CATALOG_SOURCES.aliases] })
const problem = validateModelCatalog(built)
if (problem) {
  console.error(`model catalogue: ${problem}; ${path.relative(root, out)} left as it was`)
  process.exit(1)
}
fs.writeFileSync(out, JSON.stringify(built, null, 1) + '\n')
console.log(`${path.relative(root, out)}: ${built.models.length} models, ${built.aliases.length} aliases, built ${built.builtAt}`)
