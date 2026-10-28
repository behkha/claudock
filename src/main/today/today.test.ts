import test from 'node:test'
import assert from 'node:assert/strict'
import { localDate, sumActivity, type UsageFile } from './activity.ts'

const H = 3_600_000
// Wed 28 Oct 2026, 15:00 local
const NOW = new Date(2026, 9, 28, 15).getTime()
const at = (day: number, hour: number): number => new Date(2026, 9, day, hour).getTime()

const file = (project: string, session: string, entries: [number, number, string?, string?][], cwd: string | null = `/work/${project}`): UsageFile => ({
  project,
  session,
  cwd,
  entries: entries.map(([t, tokens, key, s]) => ({ t, tokens, key: key ?? `${session}:${t}`, session: s ?? session }))
})

test('today: sessions since midnight, latest first, with first and last message and tokens', () => {
  const a = sumActivity(
    [
      file('-work-api', 's1', [
        [at(28, 9), 100],
        [at(28, 11), 50]
      ]),
      file('-work-site', 's2', [[at(28, 13), 70]]),
      file('-work-old', 's3', [[at(27, 22), 999]])
    ],
    NOW
  )
  assert.deepEqual(
    a.sessions.map((s) => [s.id, s.projectId, s.first, s.last, s.tokens]),
    [
      ['s2', '-work-site', at(28, 13), at(28, 13), 70],
      ['s1', '-work-api', at(28, 9), at(28, 11), 150]
    ]
  )
  assert.equal(a.tokens, 220)
})

test("today: a subagent's file counts toward its session, and the session's own file names the folder", () => {
  const a = sumActivity(
    [
      file('-work-api', 's1', [[at(28, 10), 30, 'k1']], '/work/api/sub'),
      file('-work-api', 's1', [[at(28, 9), 100, 'k2']], '/work/api')
    ],
    NOW
  )
  assert.deepEqual(a.sessions.map((s) => [s.id, s.cwd, s.tokens, s.first, s.last]), [['s1', '/work/api', 130, at(28, 9), at(28, 10)]])
})

test('today: a message repeated in a resumed session counts once', () => {
  const a = sumActivity([file('-p', 'old', [[at(28, 9), 100, 'same']]), file('-p', 'new', [[at(28, 9), 100, 'same', 'new']])], NOW)
  assert.equal(a.tokens, 100)
  assert.equal(a.sessions.length, 1)
})

test('week: 7 local days, oldest first, ending today; older lines and future ones are left out', () => {
  const a = sumActivity(
    [
      file('-p', 's', [
        [at(21, 23), 5],
        [at(22, 0), 7],
        [at(25, 12), 11],
        [at(28, 1), 13],
        [NOW + H, 17]
      ])
    ],
    NOW
  )
  assert.deepEqual(a.days.map((d) => d.date), ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'])
  assert.deepEqual(a.days.map((d) => d.tokens), [7, 0, 0, 11, 0, 0, 13])
  assert.equal(localDate(NOW), '2026-10-28')
})
