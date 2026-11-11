/**
 * The arithmetic of Anthropic's API list prices, for the share card's "≈ $N at API prices" (src/main/share/week.ts).
 * The prices themselves are not in here: they come from the model catalogue (src/shared/modelCatalog.ts), read from
 * Anthropic's pricing page. A model the catalogue has no row for has no price. Plans are the monthly-billing list
 * prices, copied by hand on 29 Oct 2026; Claudock never reads which plan an account has, the user picks it.
 */

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
  /** What `inference_geo: "us"` multiplies every rate by (1.1 on Claude 4.6 and later); null where it doesn't apply. */
  usOnly: number | null
}

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
    const x = p.usOnly
    r = { input: r.input * x, write5m: r.write5m * x, write1h: r.write1h * x, read: r.read * x, output: r.output * x }
    name += ' US-only'
  }
  return { name, rates: r }
}

/** USD for one message at `r`, its web searches included at `searchUsd` each. */
export const usdAt = (r: Rates, u: MessageUsage, searchUsd: number): number =>
  (u.input * r.input + u.write5m * r.write5m + u.write1h * r.write1h + u.read * r.read + u.output * r.output) / 1e6 + u.webSearches * searchUsd

/** USD for one message at `p`'s list prices. */
export const messageUsd = (p: ModelPrice, u: MessageUsage, searchUsd: number): number => usdAt(ratesFor(p, u).rates, u, searchUsd)

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
