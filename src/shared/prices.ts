/**
 * Anthropic's API list prices, for the share card's "≈ $N at API prices" (src/main/share/week.ts). Copied by hand from
 * the source page on the date below: when Anthropic changes a price or adds a model, add or change its row here and
 * move the date. A model missing from the table has no price and is left out of the value. Plans are the monthly-billing
 * list prices of the same day; Claudock never reads which plan an account has, the user picks it.
 */

export const PRICES_AS_OF = '2026-10-29'
export const PRICES_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing'

/** USD per million tokens, as the price page lists them. */
export interface Rates {
  input: number
  /** Writing to the 5-minute and the 1-hour prompt cache. */
  write5m: number
  write1h: number
  /** Cache hits and refreshes. */
  read: number
  output: number
}

export interface ModelPrice extends Rates {
  /** The name `friendlyModel()` gives the model's ids ("Opus 5.5"). */
  name: string
  /** Fast mode's input and output; the cache multipliers apply on top (writes 1.25x and 2x, reads as `read / input`). */
  fast?: { input: number; output: number }
  /** A request whose prompt (input, cache writes and cache reads) is over `over` tokens pays these instead. */
  long?: Rates & { over: number }
  /** `inference_geo: "us"` costs 1.1x on every rate (Claude 4.6 and later). */
  usOnly: boolean
}

const row = (name: string, input: number, write5m: number, write1h: number, read: number, output: number, more: Partial<ModelPrice> = {}): ModelPrice => ({
  name,
  input,
  write5m,
  write1h,
  read,
  output,
  usOnly: true,
  ...more
})

export const MODEL_PRICES: readonly ModelPrice[] = [
  row('Fable 5.1', 10, 12.5, 20, 0.25, 50),
  row('Mythos 5.1', 10, 12.5, 20, 0.25, 50),
  row('Fable 5', 10, 12.5, 20, 1, 50),
  row('Mythos 5', 10, 12.5, 20, 1, 50),
  row('Opus 5.5', 4, 5, 8, 0.2, 20, { fast: { input: 8, output: 40 } }),
  row('Opus 5', 5, 6.25, 10, 0.5, 25, { fast: { input: 10, output: 50 } }),
  row('Opus 4.8', 5, 6.25, 10, 0.5, 25, { fast: { input: 10, output: 50 } }),
  row('Opus 4.7', 5, 6.25, 10, 0.5, 25),
  row('Opus 4.6', 5, 6.25, 10, 0.5, 25),
  row('Opus 4.5', 5, 6.25, 10, 0.5, 25, { usOnly: false }),
  row('Opus 4.1', 15, 18.75, 30, 1.5, 75, { usOnly: false }),
  row('Opus 4', 15, 18.75, 30, 1.5, 75, { usOnly: false }),
  row('Sonnet 5.5', 2, 2.5, 4, 0.1, 10),
  row('Sonnet 5', 2, 2.5, 4, 0.2, 10),
  row('Sonnet 4.6', 3, 3.75, 6, 0.3, 15),
  row('Sonnet 4.5', 3, 3.75, 6, 0.3, 15, { usOnly: false }),
  row('Sonnet 4', 3, 3.75, 6, 0.3, 15, { usOnly: false }),
  row('Haiku 5.5', 0.1, 0.125, 0.2, 0.01, 0.5, { long: { over: 100_000, input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 } }),
  row('Haiku 4.5', 1, 1.25, 2, 0.1, 5, { usOnly: false }),
  row('Haiku 3.5', 0.8, 1, 1.6, 0.08, 4, { usOnly: false })
]

/** USD per web search (server tool), on top of tokens. */
export const WEB_SEARCH_USD = 10 / 1000

const byName = new Map(MODEL_PRICES.map((p) => [p.name, p]))

/** The price of a model by its friendly name; null when the table has none. */
export const priceOf = (name: string): ModelPrice | null => byName.get(name) ?? null

/** What one assistant message's usage line says, in tokens. */
export interface MessageUsage {
  input: number
  output: number
  /** Cache writes by lifetime; a write Claude Code didn't split counts as 5-minute. */
  write5m: number
  write1h: number
  read: number
  /** `usage.speed === 'fast'`. */
  fast: boolean
  /** `usage.inference_geo === 'us'`. */
  usOnly: boolean
  webSearches: number
}

/**
 * The rates one message pays at `p`'s list prices, named as the Prices table shows them: "Opus 5.5", "Opus 5.5 fast",
 * "Haiku 5.5 over 100k", "Sonnet 5.5 US-only".
 */
export function ratesFor(p: ModelPrice, u: MessageUsage): { name: string; rates: Rates } {
  let name = p.name
  let r: Rates = p
  if (p.long && u.input + u.write5m + u.write1h + u.read > p.long.over) {
    r = p.long
    name += ` over ${p.long.over / 1000}k`
  }
  if (u.fast && p.fast) {
    r = { input: p.fast.input, write5m: p.fast.input * 1.25, write1h: p.fast.input * 2, read: p.fast.input * (p.read / p.input), output: p.fast.output }
    name += ' fast'
  }
  if (u.usOnly && p.usOnly) {
    r = { input: r.input * 1.1, write5m: r.write5m * 1.1, write1h: r.write1h * 1.1, read: r.read * 1.1, output: r.output * 1.1 }
    name += ' US-only'
  }
  return { name, rates: r }
}

/** USD for one message at `r`, its web searches included. */
export const usdAt = (r: Rates, u: MessageUsage): number =>
  (u.input * r.input + u.write5m * r.write5m + u.write1h * r.write1h + u.read * r.read + u.output * r.output) / 1e6 + u.webSearches * WEB_SEARCH_USD

/** USD for one message at `p`'s list prices. */
export const messageUsd = (p: ModelPrice, u: MessageUsage): number => usdAt(ratesFor(p, u).rates, u)

export type PlanId = 'pro' | 'max5' | 'max20' | 'team'

export interface Plan {
  id: PlanId
  name: string
  /** USD a month, billed monthly. */
  usd: number
}

export const PLANS: readonly Plan[] = [
  { id: 'pro', name: 'Pro', usd: 20 },
  { id: 'max5', name: 'Max 5x', usd: 100 },
  { id: 'max20', name: 'Max 20x', usd: 200 },
  { id: 'team', name: 'Team premium', usd: 125 }
]

/** What goes beside the value on the week card: a plan, the value alone, or no value at all. */
export type PlanChoice = PlanId | 'value' | 'hide'

export const isPlanChoice = (v: unknown): v is PlanChoice => v === 'value' || v === 'hide' || PLANS.some((p) => p.id === v)

export const planOf = (c: PlanChoice): Plan | null => PLANS.find((p) => p.id === c) ?? null

/** "< $0.01", "$4.20", "$842", "$1,012", "$12.4k", "$1.2M". */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '–'
  if (usd > 0 && usd < 0.005) return '< $0.01'
  if (usd < 10) return `$${usd.toFixed(2)}`
  if (usd < 9_999.5) return `$${new Intl.NumberFormat('en').format(Math.round(usd))}`
  if (usd < 999_950) return `$${Number((usd / 1e3).toFixed(1))}k`
  return `$${Number((usd / 1e6).toFixed(1))}M`
}
