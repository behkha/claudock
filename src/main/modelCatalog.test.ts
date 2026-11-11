import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { friendlyModel } from '../shared/models.ts'
import { MODEL_CATALOG_FORMAT, modelChoices, priceIn, type BuiltModelCatalog } from '../shared/modelCatalog.ts'
import { buildModelCatalog, validateModelCatalog } from '../shared/modelCatalogBuild.ts'
import { sumWeek, type Msg } from './share/week.ts'

/**
 * Pages in the layout Anthropic's pricing and model configuration pages have (10 Nov 2026), with models that do not
 * exist: a new version of a family (Opus 7), a family never heard of (Saga 1.5), a retired one and a two-row tier.
 */
const PRICING = `
# Pricing

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---------------- | :-------------- | :-------------- | :----------------------- | :------------ |
| Claude Saga 1.5 | $12 / MTok | $15 / MTok | $24 / MTok | $0.30 / MTok<sup>1</sup> | $60 / MTok |
| Claude Opus 7 ([limited availability](https://example.com/a)) | $6 / MTok | $7.50 / MTok | $12 / MTok | $0.30 / MTok | $30 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |
| Claude Opus 4 ([retired, except on one cloud](https://example.com/b)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

### Batch processing

| Model | Batch input | Batch output |
| ----- | ----------- | ------------ |
| Claude Opus 7 | $3 / MTok | $15 / MTok |

### Data residency pricing

For Claude 4.6 and later models, specifying US-only inference through the \`inference_geo\` parameter incurs a 1.1x multiplier on all token pricing categories.

### Fast mode pricing

| Model | Input | Output |
| ----- | ----- | ------ |
| Claude Opus 7 / Claude Opus 5.5 | $12 USD / MTok | $60 USD / MTok |

#### Web search tool

Web search is available on the Claude API for **$10 USD per 1,000 searches**, plus standard token costs.
`
const ALIASES = `
### Model aliases

| Model alias | Behavior |
| ----------- | -------- |
| **\`default\`** | Special value that clears any model override |
| **\`best\`** | Uses the same model as \`opus\` |
| **\`saga\`** | Uses the Saga model |
| **\`opus\`** | Uses the latest Opus model |
| **\`opus[1m]\`** | Uses Opus with a 1 million token context window |
`
const build = (pricing = PRICING, aliases = ALIASES): BuiltModelCatalog => buildModelCatalog({ pricing, aliases, builtAt: '2027-03-01T09:00:00.000Z', sources: [] })

const msg = (model: string, over: Partial<Msg> = {}): Msg => ({
  t: new Date(2027, 2, 2, 10).getTime(),
  key: model + JSON.stringify(over),
  model,
  session: 's1',
  input: 0,
  output: 1e6,
  write5m: 0,
  write1h: 0,
  read: 0,
  fast: false,
  usOnly: false,
  webSearches: 0,
  ...over
})

test('a model that does not exist today: listed, offered in Settings and priced on the week, from the page alone', () => {
  const c = build()
  assert.equal(validateModelCatalog(c), null)
  assert.deepEqual(
    c.models.map((m) => [m.name, m.id]),
    [
      ['Saga 1.5', 'claude-saga-1-5'],
      ['Opus 7', 'claude-opus-7'],
      ['Opus 5.5', 'claude-opus-5-5'],
      ['Sonnet 5.5', 'claude-sonnet-5-5'],
      ['Opus 4', 'claude-opus-4'],
      ['Haiku 5.5', 'claude-haiku-5-5']
    ]
  )
  // US-only goes by version number ("Claude 4.6 and later"): a new family that restarts its numbering is read as earlier
  assert.deepEqual(priceIn(c, 'Saga 1.5'), { name: 'Saga 1.5', input: 12, write5m: 15, write1h: 24, read: 0.3, output: 60, usOnly: null })
  assert.equal(priceIn(c, 'Opus 7')?.usOnly, 1.1)
  assert.deepEqual(priceIn(c, 'Opus 7')?.fast, { input: 12, output: 60 }, 'one fast mode row can name two models')
  assert.deepEqual(priceIn(c, 'Opus 5.5')?.fast, { input: 12, output: 60 })
  assert.equal(priceIn(c, 'Opus 4')?.usOnly, null, 'older than the version the page names')
  assert.deepEqual(priceIn(c, 'Haiku 5.5')?.long, { over: 100_000, input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 })
  assert.equal(c.webSearchUsd, 0.01)
  assert.deepEqual(c.aliases, ['best', 'saga', 'opus', 'opus[1m]'])

  // Settings: aliases, the models that aren't retired, then ids from the transcripts the page doesn't cover
  const choices = modelChoices(c, ['claude-opus-7-20270301', 'claude-epic-2', 'kimi-k3', 'claude-opus-4-20250514', '<synthetic>'])
  assert.deepEqual(
    choices.map((x) => `${x.group}: ${x.label}`),
    [
      'Aliases: best',
      'Aliases: saga',
      'Aliases: opus',
      'Aliases: opus[1m]',
      'Models: Saga 1.5 · claude-saga-1-5',
      'Models: Opus 7 · claude-opus-7',
      'Models: Opus 5.5 · claude-opus-5-5',
      'Models: Sonnet 5.5 · claude-sonnet-5-5',
      'Models: Haiku 5.5 · claude-haiku-5-5',
      'From your sessions: Epic 2 · claude-epic-2',
      'From your sessions: kimi-k3'
    ]
  )

  // the week: the new models are priced; one the page has no row for is named with no value, never dropped
  const now = new Date(2027, 2, 3, 12).getTime()
  const w = sumWeek(
    [{ msgs: [msg('claude-saga-1-5-20270215'), msg('claude-opus-7', { fast: true }), msg('claude-epic-2'), msg('kimi-k3', { output: 5e5 })], prompts: [] }],
    '2027-03-01',
    now,
    '2027-03-01',
    c
  )
  assert.deepEqual(
    w.models.map((m) => [m.name, m.usd]),
    [
      ['Epic 2', null],
      ['Opus 7', 60],
      ['Saga 1.5', 60],
      ['kimi-k3', null]
    ]
  )
  assert.equal(w.usd, 120)
  assert.equal(w.tokens, 3.5e6, 'unpriced tokens still count as tokens')
  assert.deepEqual(w.prices.rows.map((r) => r.name).sort(), ['Opus 7 fast', 'Saga 1.5'])
  assert.equal(w.prices.asOf, '2027-03-01')
})

test('friendlyModel reads any claude-<family>-<version> id', () => {
  assert.equal(friendlyModel('claude-saga-1-5-20270215'), 'Saga 1.5')
  assert.equal(friendlyModel('us.anthropic.claude-epic-2-v1:0'), 'Epic 2')
  assert.equal(friendlyModel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(friendlyModel('claude-3-5-sonnet-20241022'), 'Sonnet 3.5')
  assert.equal(friendlyModel('kimi-k3'), 'kimi-k3')
})

test('a page that changed is refused, so the last good copy stays', () => {
  assert.throws(() => build(PRICING.replace('| Model | Base input tokens | 5m cache writes |', '| Model | Price | Writes |')), /no table with input/)
  assert.throws(() => build(PRICING.replace('US-only inference', 'regional inference')), /US-only/)
  assert.throws(() => build(PRICING.replace('per 1,000 searches', 'per thousand')), /web search/)
  assert.throws(() => build(PRICING, ALIASES.replace('| Model alias |', '| Name |')), /alias table/)
  // columns swapped under the same headings: the numbers are out of order
  const swapped = build(PRICING.replace('| Claude Saga 1.5 | $12 / MTok | $15 / MTok | $24 / MTok | $0.30 / MTok<sup>1</sup> | $60 / MTok |', '| Claude Saga 1.5 | $60 / MTok | $15 / MTok | $24 / MTok | $0.30 / MTok | $12 / MTok |'))
  assert.match(validateModelCatalog(swapped) ?? '', /Saga 1.5's prices are out of order/)
  // a price cell with no number
  assert.match(validateModelCatalog(build(PRICING.replace('$30 / MTok |\n| Claude Opus 5.5', 'Contact sales |\n| Claude Opus 5.5'))) ?? '', /Opus 7 has no output price/)
  // most of the table gone
  const short = build(PRICING.split('\n').filter((l) => !/Claude (Opus 5.5|Sonnet|Haiku|Opus 4 )/.test(l)).join('\n'))
  assert.equal(validateModelCatalog(short), 'fewer than 5 models')
  assert.equal(validateModelCatalog({ ...build(), format: MODEL_CATALOG_FORMAT + 1 }), 'another format')
})

test('the bundled copy is a real read of the pages and holds every Claude model in my transcripts', () => {
  const bundled = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'modelCatalog.bundled.json'), 'utf8')) as BuiltModelCatalog
  assert.equal(validateModelCatalog(bundled), null)
  assert.deepEqual(bundled.sources, ['https://platform.claude.com/docs/en/about-claude/pricing.md', 'https://code.claude.com/docs/en/model-config.md'])
  // the ids found in ~/.claude transcripts and stats-cache.json on 10 Nov 2026
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-fable-5', 'claude-sonnet-5'])
    assert.ok(priceIn(bundled, friendlyModel(id)), `${id} has a price`)
  for (const a of ['opus', 'sonnet', 'haiku']) assert.ok(bundled.aliases.includes(a), a)
})
