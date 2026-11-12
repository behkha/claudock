import test from 'node:test'
import assert from 'node:assert/strict'
import { contextIn, crossings, crossingsPerDay, dayKey, readingOf, readings, startedIn, transcriptCrossings, type ContextReading, type TranscriptCrossings } from './context.ts'

const usage = (input: number, created: number, read: number, output = 300): Record<string, number> => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: output
})
const assistant = (id: string, u: Record<string, number> | undefined, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5'): string =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-11-12T08:00:00.000Z', uuid: `u-${id}`, message: { id, model, role: 'assistant', content: [], ...(u ? { usage: u } : {}) }, ...extra })
const user = (text: string): string => JSON.stringify({ type: 'user', timestamp: '2026-11-12T07:59:00.000Z', message: { role: 'user', content: text } })

test('context: input, cache writes and cache reads of the last reply; output is not part of it', () => {
  assert.equal(readingOf(assistant('m1', usage(12, 4_000, 503_000, 9_000)))?.context, 507_012)
  const text = [user('hello'), assistant('m1', usage(10, 2_000, 100_000)), user('more'), assistant('m2', usage(20, 6_980, 500_000))].join('\n') + '\n'
  assert.equal(contextIn(text), 507_000)
})

test('context: a message written as several lines counts once', () => {
  const lines = [assistant('m1', usage(10, 2_000, 100_000)), assistant('m1', usage(10, 2_000, 100_000)), assistant('m2', usage(20, 0, 264_980)), assistant('m2', usage(20, 0, 264_980))]
  assert.deepEqual(
    readings(lines).map((r) => [r.key, r.context]),
    [
      ['m1', 102_010],
      ['m2', 265_000]
    ]
  )
})

test('context: a line Claude Code made up itself is skipped, so the reply before it stands', () => {
  const text = [assistant('m1', usage(10, 0, 181_990)), assistant('m2', usage(0, 0, 0), {}, '<synthetic>'), assistant('m3', usage(5, 5, 5), {}, '<synthetic>')].join('\n')
  assert.equal(contextIn(text), 182_000)
})

test('context: no usage, no number', () => {
  assert.equal(contextIn(''), null)
  assert.equal(contextIn([user('hello'), assistant('m1', undefined), '{"type":"assistant","usage" broken'].join('\n')), null)
  // a word in a prompt is not a usage record
  assert.equal(contextIn(user('what does "usage" mean for an "assistant"?')), null)
})

test("context: a sub-agent's line in the same file is not the session's context", () => {
  const text = [assistant('m1', usage(10, 0, 449_990)), assistant('s1', usage(10, 0, 30_000), { isSidechain: true, agentId: 'a1' })].join('\n')
  assert.equal(contextIn(text), 450_000)
})

test('context: the end of a file that starts in the middle of a line', () => {
  const whole = [assistant('m1', usage(10, 0, 99_990)), assistant('m2', usage(10, 0, 725_990))].join('\n') + '\n'
  assert.equal(contextIn(whole.slice(40)), 726_000)
  // only the cut line is left: nothing to read
  assert.equal(contextIn(whole.slice(40, whole.indexOf('\n'))), null)
})

test('context: a session began at its first dated line', () => {
  assert.equal(startedIn([JSON.stringify({ type: 'custom-title', customTitle: 'x' }), user('hello')].join('\n')), Date.parse('2026-11-12T07:59:00.000Z'))
  assert.equal(startedIn('{"type":"summary"}\n'), null)
})

/* ------------------------------------------------------------------ how often a line would have alerted */

const DAY = 86_400_000
/** Noon, local, `back` days before 12 Nov 2026. */
const noon = (back: number): number => new Date(2026, 10, 12 - back, 12, 0, 0).getTime()
const at = (t: number, context: number, key = `${t}:${context}`): ContextReading => ({ t, key, context })

test('context stats: a crossing is the first reply at or over the line, and again only after falling below half', () => {
  const t = noon(0)
  const rs = [at(t, 73_000), at(t + 1, 160_000), at(t + 2, 310_000), at(t + 3, 290_000), at(t + 4, 305_000), at(t + 5, 96_000), at(t + 6, 320_000)]
  // 96k is not under half of 150k, so that line is reached once; it is under half of 300k, which is reached twice
  assert.deepEqual(crossings(rs, 150_000).map((c) => c.t - t), [1])
  assert.deepEqual(crossings(rs, 300_000).map((c) => c.t - t), [2, 6])
  assert.deepEqual(crossings(rs, 500_000), [])
  // a resumed session that starts over the line reached it
  assert.equal(crossings([at(t, 600_000)], 500_000).length, 1)
})

test('context stats: the median crossings a day, over the days that had sessions', () => {
  const lines = [150_000, 500_000]
  const session = (back: number, peak: number, n = 0): TranscriptCrossings => transcriptCrossings([at(noon(back) + n, 73_000), at(noon(back) + n + 1, peak)], lines, noon(13) - DAY / 2)
  // five days with sessions: 150k is reached 3, 1, 1, 2 and 0 times; 500k once on one day
  const files = [session(0, 200_000), session(0, 510_000, 10), session(0, 160_000, 20), session(1, 180_000), session(2, 150_000), session(3, 400_000), session(3, 151_000, 10), session(4, 90_000)]
  assert.deepEqual(crossingsPerDay(files, lines), [
    { line: 150_000, perDay: 1 },
    { line: 500_000, perDay: 0 }
  ])
  // an even number of days: halfway between the two middle days
  assert.equal(crossingsPerDay(files.slice(0, 7), lines)[0].perDay, 1.5)
})

test('context stats: fewer than three days of sessions say nothing; a reply in two files counts once; old replies only set the state', () => {
  const lines = [150_000]
  const since = noon(13) - DAY / 2
  const two = [transcriptCrossings([at(noon(0), 200_000)], lines, since), transcriptCrossings([at(noon(1), 200_000)], lines, since)]
  assert.deepEqual(crossingsPerDay(two, lines), [{ line: 150_000, perDay: null }])
  const same = [at(noon(0), 73_000, 'a'), at(noon(0) + 1, 200_000, 'b')]
  const resumed = [transcriptCrossings(same, lines, since), transcriptCrossings(same, lines, since), transcriptCrossings([at(noon(1), 10_000)], lines, since), transcriptCrossings([at(noon(2), 10_000)], lines, since)]
  assert.deepEqual(crossingsPerDay(resumed, lines), [{ line: 150_000, perDay: 0 }])
  assert.equal(resumed[0].byLine[150_000].length, 1)
  // reached the line 20 days ago and stayed over it: nothing to count in the last 14 days, though it has replies in them
  const old = transcriptCrossings([at(noon(20), 200_000), at(noon(1), 210_000)], lines, since)
  assert.deepEqual(old, { days: [dayKey(noon(1))], byLine: { 150000: [] } })
})
