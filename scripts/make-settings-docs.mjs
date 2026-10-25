#!/usr/bin/env node
/**
 * Rebuilds src/main/settingsDocs.bundled.json: the copy of Anthropic's settings docs that ships with the app and is the
 * last fallback when a launch is offline and has no cache. Run with `npm run settings-docs` (needs network and Node 22.12+;
 * the npm script passes --experimental-strip-types so Node can run the shared TypeScript directly).
 * Fetches the settings reference, the env-vars page and the JSON schema (the same URLs the app fetches at launch, from
 * SETTINGS_DOCS_SOURCES in src/shared/settingsDocs.ts), builds them with src/shared/settingsDocsBuild.ts, refuses a result
 * that looks broken, and writes the JSON. Refresh it before a release.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS_DOCS_FORMAT, SETTINGS_DOCS_PAGE, SETTINGS_DOCS_SOURCES } from '../src/shared/settingsDocs.ts'
import { buildSettingsDocs, validateSettingsDocs } from '../src/shared/settingsDocsBuild.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'src', 'main', 'settingsDocs.bundled.json')
/** Pretty-print (1-space indent) unless that is bigger than this; then minify. */
const PRETTY_LIMIT = 700 * 1024

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

/** The first URL that answers. */
async function getFirst(urls) {
  const errors = []
  for (const url of urls) {
    try {
      return { url, text: await get(url) }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }
  throw new Error(errors.join('; '))
}

const [reference, envVars, schema] = await Promise.all([get(SETTINGS_DOCS_SOURCES.reference), get(SETTINGS_DOCS_SOURCES.envVars), getFirst(SETTINGS_DOCS_SOURCES.schema)])

const docs = buildSettingsDocs({
  reference,
  envVars,
  schema: JSON.parse(schema.text),
  docsPage: SETTINGS_DOCS_PAGE,
  format: SETTINGS_DOCS_FORMAT,
  builtAt: new Date().toISOString(),
  sources: [SETTINGS_DOCS_SOURCES.reference, SETTINGS_DOCS_SOURCES.envVars, schema.url]
})
const problem = validateSettingsDocs(docs)
if (problem) {
  console.error(`Refusing to write: ${problem}`)
  process.exit(1)
}

let json = JSON.stringify(docs, null, 1) + '\n'
if (Buffer.byteLength(json) > PRETTY_LIMIT) json = JSON.stringify(docs) + '\n'
fs.writeFileSync(out, json)

const keys = Object.keys(docs.root.properties ?? {}).length
console.log(`${path.relative(root, out)}: ${keys} keys, ${docs.env.length} env vars, ${docs.tools.length} tools, ${Buffer.byteLength(json)} bytes`)
console.log(`schema from ${schema.url}`)
