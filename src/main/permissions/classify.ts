import { maskText, secretsInText, type Span } from '../../shared/secrets.ts'

/**
 * What a saved permission rule is, from its text alone: whether it holds a secret (src/shared/secrets.ts finds it; the
 * rule is shown with it covered) and whether it lets Claude run any script. Pure, so `npm test` loads it as is.
 */

/** Interpreters and runners: a Bash rule for one of these followed by a wildcard runs anything. */
const RUNNERS = ['python', 'python3', 'node', 'sh', 'bash', 'zsh', 'ruby', 'perl', 'deno', 'bun', 'npx', 'uvx', 'sudo', 'env', 'xargs', 'eval']
const RUNNER_RULE = new RegExp(`^Bash\\((?:\\S*/)?(?:${RUNNERS.join('|')})(?::\\*| \\*)\\)$`)

/**
 * The rule lets Claude run any script: `Bash`, `Bash(*)`, or a Bash rule whose command is an interpreter or runner
 * followed by a wildcard (`Bash(python3:*)`, `Bash(node *)`). A choice the user made, so it is found by a filter and
 * never flagged.
 */
export function isBroad(rule: string): boolean {
  const r = rule.trim()
  return r === 'Bash' || r === 'Bash(*)' || r === 'Bash(:*)' || RUNNER_RULE.test(r)
}

export interface RuleClass {
  /** The rule with every secret covered: what may leave the main process. */
  text: string
  secret: boolean
  /** The covered parts, in `text`. */
  secretSpans: Span[]
  broad: boolean
}

/** A rule as it may be shown, and what it is. The secret itself is in nothing this returns. */
export function classifyRule(rule: string): RuleClass {
  const secrets = secretsInText(rule)
  const masked = maskText(rule, secrets)
  return { text: masked.text, secret: secrets.length > 0, secretSpans: masked.spans, broad: isBroad(rule) }
}
