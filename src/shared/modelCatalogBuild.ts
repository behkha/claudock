import { friendlyModel } from './models.ts'
import { MODEL_CATALOG_FORMAT, type BuiltModelCatalog, type CatalogModel } from './modelCatalog.ts'
import type { Rates } from './prices.ts'

/**
 * Builds the model catalogue from Anthropic's pages as Markdown (src/shared/modelCatalog.ts names them). Pure: the app
 * (src/main/modelCatalog.ts), `npm run model-catalog` and the tests run the same code. It reads tables by their column
 * headings, never by position or by a list of model names, so a model Anthropic adds tomorrow comes out with its price
 * and nothing here changes. `validateModelCatalog` refuses a result that looks wrong; the caller then keeps its last
 * good copy.
 */

interface Table {
  /** The nearest heading above the table. */
  heading: string
  headers: string[]
  rows: string[][]
}

/** A cell as text: links keep their text, footnote marks and emphasis go. */
const plain = (cell: string): string =>
  cell
    .replace(/<sup>.*?<\/sup>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** A table row's cells. A `|` inside a link's text or code (`a \| b`) is not expected in these pages. */
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

function tables(md: string): Table[] {
  const out: Table[] = []
  let heading = ''
  let open: Table | null = null
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const h = /^#{1,6}\s+(.*)$/.exec(line)
    if (h) heading = plain(h[1])
    if (!line.trim().startsWith('|')) {
      open = null
      continue
    }
    if (!open) {
      // a header row is followed by | --- | --- |
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) continue
      open = { heading, headers: cells(line).map(plain), rows: [] }
      out.push(open)
      i++
      continue
    }
    open.rows.push(cells(line))
  }
  return out
}

/** "$0.125 / MTok" as 0.125; NaN when the cell holds no dollar amount. */
const usd = (cell: string): number => {
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(plain(cell))
  return m ? Number(m[1].replace(/,/g, '')) : NaN
}

const column = (t: Table, re: RegExp): number => t.headers.findIndex((h) => re.test(h))

/** "Claude Opus 4.1 (retired, except ...)" as { name: "Opus 4.1", note: "retired, except ..." }. */
function modelCell(cell: string): { name: string; note: string } {
  const text = plain(cell)
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(text)
  return { name: (m ? m[1] : text).replace(/^Claude\s+/i, '').trim(), note: m ? m[2] : '' }
}

/** `claude-opus-5-5` from "Opus 5.5": the id scheme since Claude 4. */
const idOf = (name: string): string => `claude-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

const version = (name: string): number => Number(/(\d+(?:\.\d+)?)\s*$/.exec(name)?.[1] ?? NaN)

export interface CatalogPages {
  /** MODEL_CATALOG_SOURCES.pricing */
  pricing: string
  /** MODEL_CATALOG_SOURCES.aliases */
  aliases: string
  builtAt: string
  sources: string[]
}

/** Throws (with what was missing) when a page doesn't hold what the catalogue needs. */
export function buildModelCatalog(pages: CatalogPages): BuiltModelCatalog {
  const all = tables(pages.pricing)

  // the model table: the one with all five rate columns
  const want = { input: /^base input|^input/i, write5m: /5\s*m.*cache write/i, write1h: /1\s*h.*cache write/i, read: /cache hit|cache read/i, output: /^output/i }
  const main = all.find((t) => /^model/i.test(t.headers[0] ?? '') && Object.values(want).every((re) => column(t, re) > 0))
  if (!main) throw new Error('the pricing page has no table with input, cache write, cache read and output columns')
  const col = Object.fromEntries(Object.entries(want).map(([k, re]) => [k, column(main, re)])) as Record<keyof Rates, number>
  const ratesOf = (row: string[]): Rates => ({ input: usd(row[col.input]), write5m: usd(row[col.write5m]), write1h: usd(row[col.write1h]), read: usd(row[col.read]), output: usd(row[col.output]) })

  // US-only inference: "For Claude 4.6 and later models, specifying US-only inference ... incurs a 1.1x multiplier"
  const geo = /Claude (\d+(?:\.\d+)?) and later models, specifying US-only inference[^.]*?(\d+(?:\.\d+)?)x multiplier/.exec(pages.pricing)
  if (!geo) throw new Error('the pricing page no longer says which models pay more for US-only inference')
  const [geoFrom, geoTimes] = [Number(geo[1]), Number(geo[2])]

  const models = new Map<string, CatalogModel>()
  for (const row of main.rows) {
    const { name, note } = modelCell(row[0] ?? '')
    const rates = ratesOf(row)
    if (!name) continue
    const over = /over ([\d,]+) tokens/i.exec(note)
    if (over) {
      // the long-prompt tier of a model listed in two rows
      const base = models.get(name)
      if (!base) throw new Error(`the pricing page lists ${name}'s long-prompt prices before its standard ones`)
      base.price.long = { ...rates, over: Number(over[1].replace(/,/g, '')) }
      continue
    }
    if (models.has(name)) throw new Error(`the pricing page lists ${name} twice`)
    const v = version(name)
    models.set(name, {
      name,
      id: idOf(name),
      retired: /\bretired\b/i.test(note),
      limited: /limited (availability|access)/i.test(note),
      price: { name, ...rates, usOnly: Number.isFinite(v) && v >= geoFrom ? geoTimes : null }
    })
  }

  // fast mode: Model | Input | Output under a "Fast mode" heading; one row may name several models ("A / B")
  const fast = all.find((t) => /fast mode/i.test(t.heading) && t.headers.length === 3 && /^model/i.test(t.headers[0]) && /^input/i.test(t.headers[1]) && /^output/i.test(t.headers[2]))
  for (const row of fast?.rows ?? []) {
    for (const part of plain(row[0] ?? '').split(' / ')) {
      const m = models.get(modelCell(part).name)
      if (m) m.price.fast = { input: usd(row[1]), output: usd(row[2]) }
    }
  }

  const search = /\$\s*([\d,]+(?:\.\d+)?)(?: USD)? per ([\d,]+) searches/i.exec(pages.pricing)
  if (!search) throw new Error('the pricing page no longer gives the web search price')
  const webSearchUsd = Number(search[1].replace(/,/g, '')) / Number(search[2].replace(/,/g, ''))

  // Claude Code's aliases: the table whose first column is "Model alias"
  const aliasTable = tables(pages.aliases).find((t) => /^model alias/i.test(t.headers[0] ?? ''))
  if (!aliasTable) throw new Error('the model configuration page has no alias table')
  // `default` clears the setting; Settings has its own "not set" choice
  const aliases = aliasTable.rows.map((r) => plain(r[0] ?? '')).filter((a) => a && a !== 'default')

  return { format: MODEL_CATALOG_FORMAT, builtAt: pages.builtAt, sources: pages.sources, models: [...models.values()], aliases, webSearchUsd }
}

const money = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

function ratesProblem(who: string, r: Rates): string | null {
  for (const k of ['input', 'write5m', 'write1h', 'read', 'output'] as const) if (!money(r[k])) return `${who} has no ${k} price`
  // how Anthropic prices the cache: writes cost more than input, reads less; output costs more than input
  if (!(r.read < r.input && r.input < r.write5m && r.write5m < r.write1h && r.input < r.output)) return `${who}'s prices are out of order`
  return null
}

/** Null when `c` is fit to use; else what is wrong, for the log. A cached or bundled copy is checked the same way. */
export function validateModelCatalog(c: BuiltModelCatalog): string | null {
  if (c?.format !== MODEL_CATALOG_FORMAT) return 'another format'
  if (typeof c.builtAt !== 'string' || Number.isNaN(Date.parse(c.builtAt))) return 'no build time'
  if (!Array.isArray(c.models) || c.models.length < 5) return 'fewer than 5 models'
  if (!Array.isArray(c.aliases) || c.aliases.length < 3 || c.aliases.some((a) => typeof a !== 'string' || !/^[a-z][a-z0-9[\]-]*$/.test(a))) return 'the aliases do not look like aliases'
  if (!money(c.webSearchUsd) || c.webSearchUsd > 1) return 'no web search price'
  const names = new Set<string>()
  for (const m of c.models) {
    if (typeof m?.name !== 'string' || !/^[A-Z][A-Za-z]* \d+(\.\d+)?$/.test(m.name)) return `"${String(m?.name)}" is not a model name`
    if (names.has(m.name)) return `${m.name} is listed twice`
    names.add(m.name)
    // the id must be one this app would read back as the same model, or prices would attach to the wrong rows
    if (typeof m.id !== 'string' || friendlyModel(m.id) !== m.name) return `${m.name}'s id does not read back as ${m.name}`
    const p = m.price
    if (!p || p.name !== m.name) return `${m.name} has no price`
    const bad = ratesProblem(m.name, p) ?? (p.long ? ratesProblem(`${m.name} over ${p.long.over}`, p.long) : null)
    if (bad) return bad
    if (p.long && !(money(p.long.over) && p.long.input > p.input)) return `${m.name}'s long-prompt tier is not dearer`
    if (p.fast && !(money(p.fast.input) && money(p.fast.output) && p.fast.input > p.input && p.fast.output > p.output)) return `${m.name}'s fast mode is not dearer`
    if (p.usOnly !== null && !(money(p.usOnly) && p.usOnly > 1 && p.usOnly < 2)) return `${m.name}'s US-only multiplier is off`
  }
  return null
}
