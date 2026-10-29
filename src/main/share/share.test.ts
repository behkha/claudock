import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { friendlyModel } from '../../shared/models.ts'
import { MODEL_PRICES, formatUsd, isPlanChoice, messageUsd, priceOf, ratesFor, type MessageUsage } from '../../shared/prices.ts'
import { emptyScans, scanSince } from './scan.ts'
import { addLocalDays, isMonday, localDate, longestRun, midnightOf, mondayOf, msgOf, promptOf, recapDue, sumWeek, type Msg } from './week.ts'

const usage = (u: Partial<MessageUsage>): MessageUsage => ({ input: 0, output: 0, write5m: 0, write1h: 0, read: 0, fast: false, usOnly: false, webSearches: 0, ...u })
const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`)

test('prices: every model in the table has a name friendlyModel gives, and cache writes are 1.25x and 2x of input', () => {
  for (const p of MODEL_PRICES) {
    close(p.write5m, p.input * 1.25)
    close(p.write1h, p.input * 2)
  }
  assert.equal(priceOf(friendlyModel('claude-opus-5-5'))?.name, 'Opus 5.5')
  assert.equal(priceOf(friendlyModel('claude-fable-5-1'))?.name, 'Fable 5.1')
  assert.equal(priceOf(friendlyModel('claude-opus-4-20250514'))?.name, 'Opus 4')
  assert.equal(priceOf(friendlyModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0'))?.name, 'Sonnet 4.5')
  assert.equal(priceOf(friendlyModel('claude-haiku-4-5-20251001[1m]'))?.name, 'Haiku 4.5')
  assert.equal(priceOf(friendlyModel('claude-sonnet-4-5@20250929'))?.name, 'Sonnet 4.5')
  assert.equal(priceOf(friendlyModel('claude-opus-4-0'))?.name, 'Opus 4')
  assert.equal(priceOf(friendlyModel('deepseek/deepseek-v4-flash:free')), null)
  assert.equal(priceOf(friendlyModel('claude-3-5-sonnet-20241022')), null, 'a model the page no longer lists has no price')
})

test('messageUsd: every token kind at its rate, fast mode, US-only inference, the long-prompt tier and web searches', () => {
  const opus = priceOf('Opus 5.5')!
  const u = usage({ input: 100, output: 2000, write1h: 10_000, read: 150_000 })
  // 100 x $4 + 2,000 x $20 + 10,000 x $8 + 150,000 x $0.20, per million
  close(messageUsd(opus, u), 0.1504)
  close(messageUsd(opus, usage({ write5m: 1e6 })), 5)
  // fast mode: $8 / $40, cache writes 1.25x and 2x of $8, reads 0.05x of $8
  close(messageUsd(opus, { ...u, fast: true }), 0.3008)
  close(messageUsd(opus, { ...u, usOnly: true }), 0.1504 * 1.1)
  // no fast mode and no US premium on Opus 4.5
  const old = priceOf('Opus 4.5')!
  close(messageUsd(old, usage({ output: 1e6, fast: true, usOnly: true })), 25)
  const haiku = priceOf('Haiku 5.5')!
  close(messageUsd(haiku, usage({ input: 100_000 })), 0.01)
  // over 100,000 tokens of prompt, counting cache reads: every token at the higher rates
  close(messageUsd(haiku, usage({ input: 1000, read: 100_000, output: 1000 })), (1000 * 0.5 + 100_000 * 0.05 + 1000 * 2.5) / 1e6)
  close(messageUsd(opus, usage({ webSearches: 3 })), 0.03)
  assert.deepEqual(
    [usage({}), usage({ fast: true }), usage({ fast: true, usOnly: true })].map((u) => ratesFor(opus, u).name),
    ['Opus 5.5', 'Opus 5.5 fast', 'Opus 5.5 fast US-only']
  )
  assert.equal(ratesFor(haiku, usage({ read: 100_001 })).name, 'Haiku 5.5 over 100k')
  close(ratesFor(opus, usage({ fast: true })).rates.read, 0.4)
})

test('formatUsd and plan choices', () => {
  assert.deepEqual([0, 0.003, 4.2, 842.17, 1011.83, 9_999.4, 12_400, 1_240_000].map(formatUsd), ['$0.00', '< $0.01', '$4.20', '$842', '$1,012', '$9,999', '$12.4k', '$1.2M'])
  assert.ok(isPlanChoice('max20') && isPlanChoice('value') && isPlanChoice('hide'))
  assert.ok(!isPlanChoice('max') && !isPlanChoice(undefined))
})

const line = (o: Record<string, unknown>): Record<string, unknown> => ({ sessionId: 's1', uuid: Math.random().toString(36), ...o })
const assistant = (ts: string, model: string, u: Record<string, unknown>, id = 'msg_1', req = 'req_1'): Record<string, unknown> =>
  line({ type: 'assistant', timestamp: ts, requestId: req, message: { id, model, role: 'assistant', content: [], usage: u } })

test('msgOf: Claude Code usage lines, with the cache split, fast mode and US-only inference', () => {
  const m = msgOf(
    assistant('2026-10-26T10:00:00Z', 'claude-opus-5-5', {
      input_tokens: 10,
      output_tokens: 500,
      cache_creation_input_tokens: 3000,
      cache_read_input_tokens: 90_000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
      speed: 'fast',
      inference_geo: 'us'
    })
  )
  assert.deepEqual(
    { ...m, t: undefined },
    {
      t: undefined,
      key: 'msg_1:req_1',
      model: 'claude-opus-5-5',
      session: 's1',
      input: 10,
      output: 500,
      write5m: 1000,
      write1h: 2000,
      read: 90_000,
      fast: true,
      usOnly: true,
      webSearches: 1
    }
  )
  // no split recorded: every write is a 5-minute one
  assert.equal(msgOf(assistant('2026-10-26T10:00:00Z', 'claude-sonnet-5-5', { input_tokens: 1, cache_creation_input_tokens: 400 }))?.write5m, 400)
  assert.equal(msgOf(assistant('2026-10-26T10:00:00Z', '<synthetic>', { input_tokens: 5 })), null)
  assert.equal(msgOf(assistant('2026-10-26T10:00:00Z', 'claude-opus-5-5', { input_tokens: 0, output_tokens: 0 })), null)
})

test('promptOf: what you typed, and slash commands; never tool results, reminders, sub-agents or summaries', () => {
  const user = (content: unknown, more: Record<string, unknown> = {}): Record<string, unknown> =>
    line({ type: 'user', timestamp: '2026-10-26T10:00:00Z', message: { role: 'user', content }, ...more })
  assert.ok(promptOf(user('Fix the login bug')))
  assert.ok(promptOf(user('<command-name>/review</command-name><command-args>auth</command-args>')))
  assert.ok(
    promptOf(
      user([
        { type: 'text', text: 'Look at this' },
        { type: 'image', source: {} }
      ])
    )
  )
  assert.equal(promptOf(user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }])), null)
  assert.equal(promptOf(user('<system-reminder>x</system-reminder>')), null)
  assert.equal(promptOf(user('Find the callers', { isSidechain: true })), null)
  assert.equal(promptOf(user('This session is being continued…', { isCompactSummary: true })), null)
  assert.equal(promptOf(user('x', { isMeta: true })), null)
})

test('local weeks run Monday to Sunday', () => {
  const wed = new Date(2026, 9, 28, 15).getTime()
  assert.equal(mondayOf(wed), '2026-10-26')
  assert.equal(mondayOf(new Date(2026, 10, 1, 23, 59).getTime()), '2026-10-26', 'Sunday belongs to the week before')
  assert.equal(mondayOf(new Date(2026, 10, 2, 0, 0).getTime()), '2026-11-02')
  assert.ok(isMonday('2026-10-26') && !isMonday('2026-10-27') && !isMonday('2026-13-01') && !isMonday(42))
  assert.equal(addLocalDays('2026-10-26', 7), '2026-11-02')
  assert.equal(localDate(midnightOf('2026-03-29')), '2026-03-29')
})

const msg = (date: string, hour: number, model: string, u: Partial<MessageUsage>, key: string, session = 's1'): Msg => ({
  ...usage(u),
  t: new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour).getTime(),
  key,
  model,
  session
})

test('sumWeek: each message once across files, the week only, prices per model, unpriced models left out of the value', () => {
  const now = new Date(2026, 9, 28, 18).getTime() // Wednesday
  const a = msg('2026-10-26', 10, 'claude-opus-5-5', { output: 1e6 }, 'm1') // $20
  const files = [
    {
      msgs: [a, msg('2026-10-26', 12, 'claude-sonnet-5-5', { input: 1e6 }, 'm2'), msg('2026-10-25', 23, 'claude-opus-5-5', { output: 1e6 }, 'm0')],
      prompts: [{ t: a.t - 60_000, key: 'p1', session: 's1' }]
    },
    // a resumed session repeats m1 and the prompt; a second session runs on a model with no price
    {
      msgs: [a, msg('2026-10-28', 9, 'deepseek/deepseek-v4', { input: 5e5 }, 'm3', 's2'), msg('2026-10-28', 11, 'claude-sonnet-5-5', { output: 1e5 }, 'm4', 's2')],
      prompts: [
        { t: a.t - 60_000, key: 'p1', session: 's1' },
        { t: a.t + 3 * 3_600_000, key: 'p2', session: 's1' }
      ]
    }
  ]
  const w = sumWeek(files, '2026-10-26', now, '2026-09-28')
  assert.equal(w.end, '2026-11-01')
  assert.equal(w.current, true)
  assert.equal(w.earliest, '2026-09-28')
  assert.deepEqual(
    w.days.map((d) => d.future),
    [false, false, false, true, true, true, true]
  )
  assert.equal(w.tokens, 1e6 + 1e6 + 5e5 + 1e5)
  close(w.usd!, 20 + 2 + 1)
  close(w.days[0].usd, 22)
  close(w.days[2].usd, 1)
  assert.equal(w.days[2].tokens, 6e5)
  assert.equal(w.sessions, 2)
  assert.equal(w.prompts, 2)
  // s1 runs from its first prompt (09:59) to its last (13:00)
  assert.equal(w.longestSessionMs, 3 * 3_600_000 + 60_000)
  assert.deepEqual(
    w.models.map((m) => [m.name, m.tokens, m.usd === null ? null : Math.round(m.usd)]),
    [
      ['Opus 5.5', 1e6, 20],
      ['Sonnet 5.5', 1.1e6, 3],
      ['deepseek/deepseek-v4', 5e5, null]
    ].sort((x, y) => (y[1] as number) - (x[1] as number))
  )
  assert.equal(w.topModel, 'Sonnet 5.5')
  assert.deepEqual(
    w.prices.rows.map((r) => r.name),
    ['Sonnet 5.5', 'Opus 5.5']
  )
  const empty = sumWeek([], '2026-10-19', now, '2026-10-19')
  assert.equal(empty.usd, null)
  assert.equal(empty.sessions, 0)
  assert.equal(empty.longestSessionMs, null)
  assert.equal(empty.current, false)
})

test('sumWeek: the Prices rows are the rates messages paid, and web searches are counted', () => {
  const now = new Date(2026, 9, 28, 18).getTime()
  const files = [
    {
      msgs: [msg('2026-10-27', 10, 'claude-opus-5-5', { output: 1e6 }, 'a'), msg('2026-10-27', 11, 'claude-opus-5-5', { output: 1e6, fast: true, webSearches: 2 }, 'b')],
      prompts: []
    }
  ]
  const w = sumWeek(files, '2026-10-26', now, '2026-10-26')
  assert.deepEqual(
    w.prices.rows.map((r) => [r.name, r.output]),
    [
      ['Opus 5.5', 20],
      ['Opus 5.5 fast', 40]
    ]
  )
  assert.equal(w.prices.searches, 2)
  close(w.usd!, 20 + 40 + 0.02)
})

test('longestRun: the most days in a row, across months, duplicates ignored', () => {
  assert.equal(longestRun([]), null)
  assert.equal(longestRun(['2026-10-01']), 1)
  assert.equal(longestRun(['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-05']), 3)
  assert.equal(longestRun(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-03']), 3)
})

test('recapDue: Mondays from 09:00, last week, once', () => {
  const mon = (h: number, m = 0): number => new Date(2026, 10, 2, h, m).getTime()
  assert.equal(recapDue(mon(8, 59), null), null)
  assert.equal(recapDue(mon(9), null), '2026-10-26')
  assert.equal(recapDue(mon(17), '2026-10-26'), null)
  assert.equal(recapDue(mon(17), '2026-10-19'), '2026-10-26')
  assert.equal(recapDue(new Date(2026, 10, 3, 10).getTime(), null), null, 'not on Tuesday')
})

test('scanSince: reads once, then what was appended; a linked copy once; a line still being written later', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudock-share-'))
  try {
    const live = path.join(tmp, 'live')
    const archive = path.join(tmp, 'archive')
    const proj = path.join(live, 'projects', '-p')
    await fsp.mkdir(path.join(proj, 's1', 'subagents'), { recursive: true })
    await fsp.mkdir(path.join(archive, 'projects', '-p'), { recursive: true })
    const file = path.join(proj, 's1.jsonl')
    const j = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n'
    const ts = '2026-10-26T10:00:00Z'
    await fsp.writeFile(
      file,
      j({ type: 'user', timestamp: ts, uuid: 'u1', sessionId: 's1', message: { role: 'user', content: 'Hello' } }) +
        j(assistant(ts, 'claude-opus-5-5', { output_tokens: 10 }, 'm1'))
    )
    await fsp.writeFile(
      path.join(proj, 's1', 'subagents', 'agent-a.jsonl'),
      j({ type: 'user', timestamp: ts, uuid: 'u9', sessionId: 's1', message: { role: 'user', content: 'Sub prompt' } }) +
        j(assistant(ts, 'claude-haiku-5-5', { output_tokens: 3 }, 'm9', 'r9'))
    )
    fs.linkSync(file, path.join(archive, 'projects', '-p', 's1.jsonl'))

    const s = emptyScans()
    await scanSince(s, [live, archive], 0)
    assert.equal(s.files.size, 2, 'the archive link is the same file')
    const all = (): { msgs: number; prompts: number } =>
      [...s.files.values()].reduce((a, f) => ({ msgs: a.msgs + f.msgs.length, prompts: a.prompts + f.prompts.length }), { msgs: 0, prompts: 0 })
    assert.deepEqual(all(), { msgs: 2, prompts: 1 }, "a sub-agent's prompt is not yours")

    const half = JSON.stringify(assistant(ts, 'claude-opus-5-5', { output_tokens: 20 }, 'm2', 'r2'))
    await fsp.appendFile(file, half.slice(0, 40))
    await scanSince(s, [live, archive], 0)
    assert.deepEqual(all(), { msgs: 2, prompts: 1 })
    await fsp.appendFile(file, half.slice(40) + '\n')
    await scanSince(s, [live, archive], 0)
    assert.deepEqual(all(), { msgs: 3, prompts: 1 })
    assert.equal(s.files.get(file)?.offset, fs.statSync(file).size)

    // another file renamed over this one, no smaller: read from the start, not from the old offset
    const next = path.join(proj, 'next.tmp')
    const three = [1, 2, 3].map(() => j(assistant(ts, 'claude-opus-5-5', { output_tokens: 7 }, 'm5', 'r5'))).join('')
    await fsp.writeFile(next, three + j(assistant(ts, 'claude-opus-5-5', { output_tokens: 8 }, 'm6', 'r6')) + 'x'.repeat(2000) + '\n')
    await fsp.rename(next, file)
    await scanSince(s, [live, archive], 0)
    assert.deepEqual(
      s.files.get(file)?.msgs.map((m) => m.key),
      ['m5:r5', 'm6:r6'],
      'a message written as three lines is kept once'
    )

    // the archive's copy (not a link) of a file Claude Code still has is not read again
    await fsp.rm(path.join(archive, 'projects', '-p', 's1.jsonl'))
    await fsp.copyFile(file, path.join(archive, 'projects', '-p', 's1.jsonl'))
    await scanSince(s, [live, archive], 0)
    assert.equal(s.files.size, 2)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})
