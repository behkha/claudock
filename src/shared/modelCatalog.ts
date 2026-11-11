import type { ModelPrice } from './prices.ts'
import { friendlyModel } from './models.ts'

/**
 * The model catalogue: which Claude models exist, what they cost and which aliases Claude Code takes, built from
 * Anthropic's public pages (never from a list in this repo). The main process fetches it at launch
 * (src/main/modelCatalog.ts), keeps the last good copy, and falls back to the copy bundled with the app. Shared by
 * main (builds it, prices the share card) and renderer (the Model field in Settings).
 */

/**
 * The pages it is built from, as Markdown. `pricing` is the one page that lists every priced model with all five
 * rates, the fast mode prices, the long-prompt tier, the US-only multiplier and the web search price. `aliases` is
 * Claude Code's own list of the short names settings.json takes.
 */
export const MODEL_CATALOG_SOURCES = {
  pricing: 'https://platform.claude.com/docs/en/about-claude/pricing.md',
  aliases: 'https://code.claude.com/docs/en/model-config.md'
} as const

/** The price page people can open. */
export const MODEL_CATALOG_PAGE = 'https://platform.claude.com/docs/en/about-claude/pricing'

/** Version of the built data's shape. A cached copy with another format is ignored. */
export const MODEL_CATALOG_FORMAT = 1

export interface CatalogModel {
  /** As `friendlyModel()` names its ids: "Opus 5.5". */
  name: string
  /** The id settings.json takes, from the name: `claude-opus-5-5`. */
  id: string
  /** The page marks it retired: still priced (old transcripts), not offered in Settings. */
  retired: boolean
  /** The page marks it limited availability. */
  limited: boolean
  price: ModelPrice
}

export interface BuiltModelCatalog {
  format: number
  /** ISO time the pages were read. */
  builtAt: string
  sources: string[]
  /** In the page's order (newest first within a family). */
  models: CatalogModel[]
  /** `best`, `opus`, `opus[1m]`, ...: Claude Code's order. */
  aliases: string[]
  /** USD per web search, on top of tokens. */
  webSearchUsd: number
}

export interface ModelCatalog extends BuiltModelCatalog {
  /** `live`: read this launch. `cache`: the last good read. `bundled`: the copy shipped with the app. */
  origin: 'live' | 'cache' | 'bundled'
  /** Why this launch's read failed (a clause that reads after "because"), when it did. */
  fetchError?: string
}

/** The price of a model by its friendly name; null when the catalogue has none. */
export const priceIn = (c: BuiltModelCatalog, name: string): ModelPrice | null => c.models.find((m) => m.name === name)?.price ?? null

export interface ModelChoice {
  value: string
  label: string
  group: 'Aliases' | 'Models' | 'From your sessions'
}

/**
 * The Model field's choices: Claude Code's aliases, the catalogue's models that aren't retired, then the ids found in
 * this profile's own transcripts that the catalogue doesn't cover (a model newer than the page, another provider's).
 */
export function modelChoices(c: BuiltModelCatalog, used: readonly string[]): ModelChoice[] {
  const out: ModelChoice[] = c.aliases.map((v) => ({ value: v, label: v, group: 'Aliases' }))
  const listed = c.models.filter((m) => !m.retired)
  for (const m of listed) out.push({ value: m.id, label: `${m.name} · ${m.id}`, group: 'Models' })
  const have = new Set([...out.map((o) => o.value), ...c.models.map((m) => m.name)])
  for (const id of [...new Set(used)].sort()) {
    const name = friendlyModel(id)
    // a dated or provider-prefixed id of a model the catalogue lists is that model
    if (!id || id.startsWith('<') || have.has(id) || (name !== id && have.has(name))) continue
    out.push({ value: id, label: name === id ? id : `${name} · ${id}`, group: 'From your sessions' })
  }
  return out
}
