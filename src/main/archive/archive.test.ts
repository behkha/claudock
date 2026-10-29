import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { hold, holdTree, unhold } from './hold.ts'
import { emptyFacts, foldLine, matchSession, queryTerms, resumeCommand, snippetOf, splitKey, titleOf, toMarkdown } from './model.ts'
import { entriesFromLine, NO_CAPS } from '../transcripts/parse.ts'

const user = (text: string, ts = '2026-10-29T14:02:00.000Z', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user',
  timestamp: ts,
  cwd: '/Users/me/code/app',
  message: { role: 'user', content: text },
  ...extra
})
const claude = (blocks: unknown[], ts = '2026-10-29T14:03:00.000Z'): Record<string, unknown> => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: blocks } })

test('foldLine: facts and search lines from prompts and replies only', () => {
  const f = emptyFacts()
  const a = foldLine(f, user('<system-reminder>noise</system-reminder>Two tabs log out at   once'), 0)
  const b = foldLine(f, claude([{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'The refresh token\nexpires first.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]), 120)
  const c = foldLine(f, user('', '2026-10-29T15:40:00.000Z', { message: { role: 'user', content: [{ type: 'tool_result', content: 'refresh token in output' }] } }), 300)
  const d = foldLine(f, user('<command-name>/compact</command-name>'), 400)
  foldLine(f, { type: 'custom-title', customTitle: 'Auth token refresh race' }, 500)
  assert.deepEqual(a, ['0\tu\tTwo tabs log out at once'])
  assert.deepEqual(b, ['120\ta\tThe refresh token expires first.'])
  assert.deepEqual(c, [])
  assert.deepEqual(d, [])
  assert.equal(f.prompt, 'Two tabs log out at once')
  assert.equal(f.cwd, '/Users/me/code/app')
  assert.equal(f.messages, 2)
  assert.equal(f.startMs, Date.parse('2026-10-29T14:02:00.000Z'))
  // the tool result's line still counts for the session's last message time
  assert.equal(f.endMs, Date.parse('2026-10-29T15:40:00.000Z'))
  assert.equal(titleOf(f), 'Auth token refresh race')
})

test('foldLine: the newest custom title wins, agent names only without one', () => {
  const f = emptyFacts()
  foldLine(f, { type: 'agent-name', agentName: 'reviewer' }, 0)
  assert.equal(titleOf(f), 'reviewer')
  foldLine(f, { type: 'custom-title', customTitle: 'First' }, 10)
  foldLine(f, { type: 'custom-title', customTitle: 'Second' }, 20)
  assert.equal(titleOf(f), 'Second')
})

test('queryTerms: lower-cased words, quoted phrases together, no repeats, at most 8', () => {
  assert.deepEqual(queryTerms('Refresh  "Token Race" refresh'), ['refresh', 'token race'])
  assert.equal(queryTerms('a b c d e f g h i j').length, 8)
  assert.deepEqual(queryTerms('   '), [])
})

test('matchSession: every word somewhere, snippet from the line with the most words', () => {
  const text = ['0\tu\tWhy do two tabs log out', '120\ta\tThe refresh token expires before the access token is renewed', '300\tu\tfix the refresh'].join('\n')
  const hit = matchSession('Auth race', text, ['refresh', 'token'])
  assert.ok(hit)
  assert.equal(hit.offset, 120)
  assert.equal(hit.count, 2)
  assert.ok(hit.snippet.startsWith('The refresh token'))
  assert.deepEqual(hit.marks[0], [4, 11])
  // a word only in the title still counts; a missing word means no hit
  assert.ok(matchSession('Auth race', text, ['race', 'tabs']))
  assert.equal(matchSession('Auth race', text, ['refresh', 'websocket']), null)
  assert.deepEqual(matchSession('Auth race', '', ['race'])?.offset, -1)
})

test('snippetOf: cut around the first match at a word boundary, with ellipses', () => {
  const long = `${'lorem ipsum '.repeat(20)}the refresh token ${'dolor sit '.repeat(30)}`
  const { snippet, marks } = snippetOf(long, ['refresh'])
  assert.ok(snippet.startsWith('…'))
  assert.ok(snippet.endsWith('…'))
  assert.ok(snippet.length <= 162)
  const [s, e] = marks[0]
  assert.equal(snippet.slice(s, e), 'refresh')
})

test('toMarkdown: prompts and replies in full, tool calls and commands as list lines', () => {
  const lines = [
    user('Two tabs log out'),
    claude([{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/auth.ts' } }, { type: 'tool_use', name: 'Bash', input: { command: 'npm `test`' } }]),
    user('<command-name>/compact</command-name>'),
    claude([{ type: 'text', text: 'x'.repeat(50_000) }])
  ]
  const entries = lines.flatMap((o, i) => entriesFromLine(o, String(i), NO_CAPS)).filter((e) => e.kind !== 'tool_result' && e.kind !== 'thinking')
  const md = toMarkdown({ title: 'Auth race', cwd: '/Users/me/code/app', id: 'abc', when: 'Oct 29, 2026' }, entries, () => '14:02')
  assert.ok(md.startsWith('# Auth race\n\n`/Users/me/code/app` · Oct 29, 2026 · session `abc`\n'))
  assert.match(md, /## You · 14:02\n\nTwo tabs log out\n/)
  assert.match(md, /- Read: `src\/auth.ts`\n- Bash: `npm 'test'`\n/)
  assert.match(md, /- `\/compact`/)
  assert.ok(md.includes('x'.repeat(50_000)))
  assert.ok(md.endsWith('\n') && !md.includes('\n\n\n'))
})

test('resumeCommand: cd into the folder, the profile start command, --resume', () => {
  const home = '/Users/me'
  const id = '7c1e9a42-5b0d-4f7e-9a1c-2d3e4f5a6b7c'
  assert.equal(resumeCommand(path.posix.join(home, 'code', 'app'), id, 'claude', { home, windows: false }), `cd ~/code/app && claude --resume ${id}`)
  assert.equal(
    resumeCommand(path.posix.join(home, 'my code'), id, 'CLAUDE_CONFIG_DIR=~/.claude-work claude', { home, windows: false }),
    `cd "$HOME/my code" && CLAUDE_CONFIG_DIR=~/.claude-work claude --resume ${id}`
  )
  assert.equal(resumeCommand(home, id, 'claude', { home, windows: false }), `cd ~ && claude --resume ${id}`)
  assert.equal(resumeCommand("/srv/it's", id, 'claude', { home, windows: false }), `cd '/srv/it'\\''s' && claude --resume ${id}`)
  assert.equal(resumeCommand(null, id, 'claude', { home, windows: false }), `claude --resume ${id}`)
  assert.equal(
    resumeCommand("C:\\Users\\me\\o'neil", id, '$env:CLAUDE_CONFIG_DIR="C:\\x"; claude', { home: 'C:\\Users\\me', windows: true }),
    `cd 'C:\\Users\\me\\o''neil'; $env:CLAUDE_CONFIG_DIR="C:\\x"; claude --resume ${id}`
  )
})

test('splitKey: project folder and session id', () => {
  assert.deepEqual(splitKey('-Users-me-app/abc-1'), { projectId: '-Users-me-app', sessionId: 'abc-1' })
  assert.equal(splitKey('nokey'), null)
  assert.equal(splitKey('/abc'), null)
  assert.equal(splitKey('abc/'), null)
  assert.equal(splitKey(42), null)
})

/* ------------------------------------------------------------------ hold, on real files */

async function tmpDir(t: { after: (fn: () => void) => void }): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claudock-archive-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('hold: a hard link outlives Claude Code deleting its file and sees what it appends', async (t) => {
  const dir = await tmpDir(t)
  const live = path.join(dir, 'claude', 'projects', 'p', 's.jsonl')
  const held = path.join(dir, 'archive', 'projects', 'p', 's.jsonl')
  await fsp.mkdir(path.dirname(live), { recursive: true })
  await fsp.writeFile(live, 'one\n')
  assert.equal(await hold(live, held, null), 'link')
  await fsp.appendFile(live, 'two\n')
  assert.equal(await fsp.readFile(held, 'utf8'), 'one\ntwo\n')
  // already the same file: nothing to do
  assert.equal(await hold(live, held, 'link'), 'link')
  await fsp.rm(live)
  assert.equal(await fsp.readFile(held, 'utf8'), 'one\ntwo\n')
})

test('hold: Claude Code writing a new file under the old name gets a new link', async (t) => {
  const dir = await tmpDir(t)
  const live = path.join(dir, 'live.jsonl')
  const held = path.join(dir, 'held', 'held.jsonl')
  await fsp.writeFile(live, 'old\n')
  await hold(live, held, null)
  await fsp.writeFile(`${live}.new`, 'old\nnew\n')
  await fsp.rename(`${live}.new`, live)
  assert.equal(await hold(live, held, 'link'), 'link')
  assert.equal((await fsp.stat(held)).ino, (await fsp.stat(live)).ino)
})

test('hold: without hard links it copies, then appends only what was added', async (t) => {
  const dir = await tmpDir(t)
  const live = path.join(dir, 'live.jsonl')
  const held = path.join(dir, 'held', 'held.jsonl')
  const noLinks = async (): Promise<void> => {
    throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
  }
  await fsp.writeFile(live, 'one\n')
  assert.equal(await hold(live, held, null, noLinks), 'copy')
  assert.notEqual((await fsp.stat(held)).ino, (await fsp.stat(live)).ino)
  await fsp.appendFile(live, 'two\n')
  const before = (await fsp.stat(held)).ino
  assert.equal(await hold(live, held, 'copy', noLinks), 'copy')
  assert.equal(await fsp.readFile(held, 'utf8'), 'one\ntwo\n')
  assert.equal((await fsp.stat(held)).ino, before, 'appended in place, not copied again')
  // rewritten (not an append): copied again
  await fsp.writeFile(live, 'other\n')
  await hold(live, held, 'copy', noLinks)
  assert.equal(await fsp.readFile(held, 'utf8'), 'other\n')
})

test('hold: other errors are not taken for "no links here"', async (t) => {
  const dir = await tmpDir(t)
  const live = path.join(dir, 'live.jsonl')
  await fsp.writeFile(live, 'x\n')
  const broken = async (): Promise<void> => {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  }
  await assert.rejects(hold(live, path.join(dir, 'held.jsonl'), null, broken), /disk full/)
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [])
})

test('holdTree: every file below, symlinks and skipped names left out', async (t) => {
  const dir = await tmpDir(t)
  const side = path.join(dir, 'live', 'sid')
  await fsp.mkdir(path.join(side, 'subagents'), { recursive: true })
  await fsp.writeFile(path.join(side, 'subagents', 'agent-1.jsonl'), 'a\n')
  await fsp.writeFile(path.join(side, 'tool-results.txt'), 'b\n')
  await fsp.writeFile(path.join(side, 'secret.key'), 'k\n')
  fs.symlinkSync(path.join(side, 'tool-results.txt'), path.join(side, 'link.txt'))
  const heldSide = path.join(dir, 'held', 'sid')
  assert.equal(await holdTree(side, heldSide, null, (abs) => abs.endsWith('.key')), 'link')
  assert.equal(await fsp.readFile(path.join(heldSide, 'subagents', 'agent-1.jsonl'), 'utf8'), 'a\n')
  assert.ok(fs.existsSync(path.join(heldSide, 'tool-results.txt')))
  assert.ok(!fs.existsSync(path.join(heldSide, 'secret.key')))
  assert.ok(!fs.existsSync(path.join(heldSide, 'link.txt')))
})

test('hold: a version only the archive has is kept aside when an older file comes back under its name', async (t) => {
  const dir = await tmpDir(t)
  const live = path.join(dir, 'live', 's.jsonl')
  const held = path.join(dir, 'held', 's.jsonl')
  await fsp.mkdir(path.dirname(live), { recursive: true })
  await fsp.writeFile(live, 'one\ntwo\n')
  await hold(live, held, null)
  await fsp.rm(live) // Claude Code's cleanup
  await fsp.writeFile(live, 'one\n') // an older copy put back (Time Machine, a sync tool)
  assert.equal(await hold(live, held, 'link'), 'link')
  assert.equal((await fsp.stat(held)).ino, (await fsp.stat(live)).ino)
  const kept = fs.readdirSync(path.dirname(held)).filter((n) => /^s\.\d+\.jsonl$/.test(n))
  assert.equal(kept.length, 1)
  assert.equal(await fsp.readFile(path.join(path.dirname(held), kept[0]), 'utf8'), 'one\ntwo\n')
})

test('unhold: links and copies Claude Code still has go, what only the archive has is returned', async (t) => {
  const dir = await tmpDir(t)
  const liveDir = path.join(dir, 'live')
  const heldDir = path.join(dir, 'held')
  await fsp.mkdir(path.join(liveDir, 'sub'), { recursive: true })
  await fsp.writeFile(path.join(liveDir, 'linked.jsonl'), 'a\n')
  await fsp.writeFile(path.join(liveDir, 'sub', 'copied.jsonl'), 'b\nmore\n')
  await holdTree(liveDir, heldDir, null)
  // a copy whose live file still starts with it, and a file Claude Code no longer has
  await fsp.rm(path.join(heldDir, 'sub', 'copied.jsonl'))
  await fsp.writeFile(path.join(heldDir, 'sub', 'copied.jsonl'), 'b\n')
  await fsp.writeFile(path.join(heldDir, 'sub', 'only.jsonl'), 'c\n')
  const liveOf = (h: string): string => path.join(liveDir, path.relative(heldDir, h))
  const only = await unhold(heldDir, liveOf)
  assert.deepEqual(only, [path.join(heldDir, 'sub', 'only.jsonl')])
  assert.ok(!fs.existsSync(path.join(heldDir, 'linked.jsonl')))
  assert.ok(!fs.existsSync(path.join(heldDir, 'sub', 'copied.jsonl')))
  assert.ok(fs.existsSync(path.join(heldDir, 'sub', 'only.jsonl')))
  // Claude Code's files are untouched
  assert.equal(await fsp.readFile(path.join(liveDir, 'linked.jsonl'), 'utf8'), 'a\n')
})

test('unhold: after a delete, a link whose other name is in the Trash goes; a copy is returned', async (t) => {
  const dir = await tmpDir(t)
  const live = path.join(dir, 'live.jsonl')
  const held = path.join(dir, 'held.jsonl')
  const trash = path.join(dir, 'Trash', 'live.jsonl')
  await fsp.writeFile(live, 'x\n')
  await hold(live, held, null)
  await fsp.mkdir(path.dirname(trash))
  await fsp.rename(live, trash) // what the Trash does on the same disk
  assert.deepEqual(await unhold(held), [])
  assert.ok(!fs.existsSync(held))
  const copy = path.join(dir, 'copy.jsonl')
  await fsp.writeFile(copy, 'y\n')
  assert.deepEqual(await unhold(copy), [copy])
  assert.ok(fs.existsSync(copy))
})
