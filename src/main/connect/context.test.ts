import test from 'node:test'
import assert from 'node:assert/strict'
import { contextIn, readingOf, readings, startedIn } from './context.ts'

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
