import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, formatEstimate } from '../../shared/api/context.ts'
import {
  buildItems,
  deniedNames,
  emptyMemo,
  emptyRecords,
  foldRecord,
  mcpCalls,
  memoOf,
  modeOf,
  serverOfTool,
  serverSource,
  skillLine,
  switchServer,
  switchSkill,
  totalTokens,
  withDenied,
  type BuildInput,
  type Records
} from './model.ts'

const att = (attachment: Record<string, unknown>): Record<string, unknown> => ({ type: 'attachment', attachment })

function recordsOf(...lines: Record<string, unknown>[]): Records {
  const r = emptyRecords()
  for (const l of lines) foldRecord(r, l)
  return r
}

const listing = att({
  type: 'skill_listing',
  isInitial: true,
  content: '- release-notes: Draft release notes from the git log.\n- demo-tools:changelog-writer: Turn merged PR titles into a changelog.\n- bare',
  names: ['release-notes', 'demo-tools:changelog-writer', 'bare']
})
const tools = att({
  type: 'deferred_tools_delta',
  addedNames: ['WebFetch', 'mcp__github__create_issue', 'mcp__github__list_prs', 'mcp__docs-search__search'],
  addedLines: [],
  removedNames: [],
  readdedNames: [],
  failedMcpServers: [],
  needsAuthMcpServers: ['plugin:design:figma'],
  pendingMcpServers: []
})
const instructions = att({ type: 'mcp_instructions_delta', addedNames: ['github'], addedBlocks: ['## github\nUse it for issues.'], removedNames: [] })
const memory = att({ type: 'instructions', files: [{ path: '/u/.claude/CLAUDE.md', type: 'User', content: '# Mine\n' }, { path: '/code/app/CLAUDE.md', type: 'Project', content: '# App\n' }] })

test('a session start folds into skills, tools by server, instructions and memory', () => {
  const r = recordsOf({ type: 'user', message: { role: 'user', content: 'hi' } }, listing, tools, instructions, memory)
  assert.deepEqual([...(r.skills?.keys() ?? [])], ['release-notes', 'demo-tools:changelog-writer', 'bare'])
  assert.equal(r.skills?.get('demo-tools:changelog-writer'), '- demo-tools:changelog-writer: Turn merged PR titles into a changelog.')
  assert.deepEqual([...(r.tools?.get('github') ?? [])], ['mcp__github__create_issue', 'mcp__github__list_prs'])
  assert.equal(r.tools?.has('WebFetch'), false, 'built-in deferred tools are not servers')
  assert.equal(r.status.get('plugin_design_figma'), 'needs-auth')
  assert.equal(r.names.get('plugin_design_figma'), 'plugin:design:figma')
  assert.equal(r.instructions.get('github'), '## github\nUse it for issues.')
  assert.equal(r.memory?.length, 2)
})

test('later records add to, take from or replace what the session started with', () => {
  const r = recordsOf(
    listing,
    tools,
    att({ type: 'skill_listing', isInitial: false, content: '- added-later: New.', names: ['added-later'] }),
    att({ type: 'deferred_tools_delta', addedNames: [], removedNames: ['mcp__docs-search__search'], readdedNames: ['mcp__github__merge'] }),
    att({ type: 'mcp_instructions_delta', addedNames: [], addedBlocks: [], removedNames: ['github'] }),
    memory,
    att({ type: 'instructions', changed: true, reason: 'session_start', files: [{ path: '/u/.claude/CLAUDE.md', type: 'User', content: '# Newer\n' }] })
  )
  assert.equal(r.skills?.size, 4)
  assert.equal(r.tools?.has('docs-search'), false)
  assert.equal(r.tools?.get('github')?.size, 3)
  assert.equal(r.status.get('plugin_design_figma'), 'needs-auth', 'a delta without the lists keeps them')
  assert.equal(r.instructions.has('github'), false)
  assert.deepEqual(
    r.memory?.map((f) => [f.path, f.content]),
    [
      ['/u/.claude/CLAUDE.md', '# Newer\n'],
      ['/code/app/CLAUDE.md', '# App\n']
    ],
    'a `changed` record updates the files it lists and keeps the rest'
  )
  const replaced = recordsOf(memory, att({ type: 'instructions', files: [{ path: '/u/.claude/CLAUDE.md', type: 'User', content: '# Only\n' }] }))
  assert.equal(replaced.memory?.length, 1, 'a full record replaces the list')
  const fresh = recordsOf(listing, att({ type: 'skill_listing', isInitial: true, content: '- only: One.', names: ['only'] }))
  assert.deepEqual([...(fresh.skills?.keys() ?? [])], ['only'])
})

test('MCP tool names and calls map to their server', () => {
  assert.equal(serverOfTool('mcp__docs-search__search'), 'docs-search')
  assert.equal(serverOfTool('mcp__claude_ai_Slack__send'), 'claude_ai_Slack')
  assert.equal(serverOfTool('Bash'), null)
  const line = {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'toolu_1', name: 'mcp__github__list_prs' }, { type: 'tool_use', id: 'toolu_2', name: 'Read' }] }
  }
  assert.deepEqual(mcpCalls(line), [{ key: 'github', id: 'toolu_1' }])
  assert.deepEqual(mcpCalls({ type: 'user', message: { content: [] } }), [])
})

test('skillOverrides: what Claude sees, and what a switch here writes', () => {
  assert.equal(modeOf(undefined), 'full')
  assert.equal(modeOf('on'), 'full')
  assert.equal(modeOf('name-only'), 'name')
  assert.equal(modeOf('user-invocable-only'), 'none')
  assert.equal(modeOf('off'), 'none')
  assert.equal(modeOf(undefined, true), 'none')
  assert.equal(skillLine('pdf', '  Extract\n text. ', 'full'), '- pdf: Extract text.')
  assert.equal(skillLine('pdf', 'Extract text.', 'name'), '- pdf')
  assert.equal(skillLine('pdf', '', 'full'), '- pdf')
  assert.equal(skillLine('pdf', 'x'.repeat(2000), 'full').length, '- pdf: '.length + 1536)
})

/** Switch off then on through the model, as the domain does with settings.json, and return what is left. */
function offOn(settings: Record<string, unknown>, field: 'skillOverrides' | 'deniedMcpServers', key: string): Record<string, unknown> {
  const s = structuredClone(settings)
  const memo = memoOf(JSON.parse(JSON.stringify(emptyMemo())))
  for (const on of [false, true]) {
    const { changed, next } = field === 'skillOverrides' ? switchSkill(s[field], key, on, memo) : switchServer(s[field], key, on, memo)
    assert.equal(changed, true, `switching ${key} ${on ? 'on' : 'off'} changes something`)
    if (next === undefined) delete s[field]
    else s[field] = next
    // the memo goes through its JSON file between the two writes
    Object.assign(memo, memoOf(JSON.parse(JSON.stringify(memo))))
  }
  return s
}

test('a skill switched off writes user-invocable-only, and on again puts back exactly what was there', () => {
  const m = emptyMemo()
  assert.deepEqual(switchSkill({ pdf: 'name-only' }, 'pdf', false, m).next, { pdf: 'user-invocable-only' })
  assert.equal(m.skills.pdf, 'name-only')
  assert.deepEqual(switchSkill({ pdf: 'off' }, 'pdf', false, emptyMemo()), { changed: false, next: { pdf: 'off' } }, 'fully off stays fully off')
  assert.deepEqual(switchSkill({ pdf: 'off' }, 'pdf', true, emptyMemo()).next, {}, 'on clears a full off too')
  assert.equal(switchSkill({ pdf: 'name-only' }, 'pdf', true, emptyMemo()).changed, false)
  for (const settings of [{}, { skillOverrides: {} }, { skillOverrides: { pdf: 'name-only' } }, { skillOverrides: { pdf: 'on', other: 'off' } }, { skillOverrides: { other: 'off' } }]) {
    assert.deepEqual(offOn(settings, 'skillOverrides', 'pdf'), settings, JSON.stringify(settings))
  }
  // turned off elsewhere in between: on clears it rather than bringing back the old value
  const memo = emptyMemo()
  const off = switchSkill({ pdf: 'name-only' }, 'pdf', false, memo).next
  assert.deepEqual(switchSkill({ ...off, pdf: 'off' }, 'pdf', true, memo).next, {})
})

test('deniedMcpServers: one { serverName } entry per server turned off, and off then on leaves it as it was', () => {
  const other = { serverUrl: 'https://*.example.com/*' }
  assert.deepEqual(withDenied(undefined, 'github', true), [{ serverName: 'github' }])
  assert.deepEqual(withDenied([other], 'github', true), [other, { serverName: 'github' }])
  const list = [other, { serverName: 'github' }]
  assert.equal(withDenied(list, 'github', true), list, 'already there: the same list')
  assert.deepEqual(withDenied(list, 'github', false), [other])
  assert.deepEqual([...deniedNames([other, { serverName: 'a' }, 'b', { serverName: 3 }])], ['a'])
  assert.equal(switchServer(list, 'github', false, emptyMemo()).changed, false)
  for (const settings of [{}, { deniedMcpServers: [] }, { deniedMcpServers: [other] }]) {
    assert.deepEqual(offOn(settings, 'deniedMcpServers', 'github'), settings, JSON.stringify(settings))
  }
})

test('servers Claudock did not find in .claude.json say where they come from', () => {
  assert.deepEqual(serverSource('plugin_design_figma', 'plugin:design:figma', new Set()), { name: 'figma', source: 'design' })
  assert.deepEqual(serverSource('claude_ai_Slack', undefined, new Set()), { name: 'Slack', source: 'claude.ai' })
  assert.deepEqual(serverSource('claude_ai_Slack', 'claude.ai Slack', new Set()), { name: 'Slack', source: 'claude.ai' })
  assert.deepEqual(serverSource('db', undefined, new Set(['db'])), { name: 'db', source: 'project' })
  assert.deepEqual(serverSource('1a59c906', undefined, new Set()), { name: '1a59c906', source: '' })
})

const base = (over: Partial<BuildInput> = {}): BuildInput => ({
  skills: [
    { id: 'skills/release-notes', key: 'release-notes', name: 'release-notes', source: 'user', description: 'Draft release notes from the git log.', loads: true },
    { id: 'skills/pdf-extract', key: 'pdf-extract', name: 'pdf-extract', source: 'user', description: 'Extract text and tables from PDF files.', loads: true },
    { id: 'skills/legacy', key: 'legacy', name: 'legacy', source: 'user', description: 'Old.', loads: true },
    { id: 'skills/manual', key: 'manual', name: 'manual', source: 'user', description: 'Only by hand.', loads: false },
    { id: 'plugins/x/skills/changelog-writer', key: 'demo-tools:changelog-writer', name: 'changelog-writer', source: 'demo-tools', description: 'Turn PR titles into a changelog.', loads: false }
  ],
  synced: new Set(['docx']),
  overrides: { legacy: 'user-invocable-only' },
  skillUsage: { 'release-notes': { usageCount: 12, lastUsedAt: 1000 } },
  servers: [
    { name: 'github', source: 'user' },
    { name: 'docs-search', source: 'user' },
    { name: 'filesystem', source: 'user' }
  ],
  projectKeys: new Set(),
  denied: new Set(['filesystem']),
  records: recordsOf(listing, tools, instructions, memory),
  mcpUse: new Map([['docs-search', { count: 4, last: 2000 }]]),
  memory: [{ path: '/u/.claude/CLAUDE.md', name: 'CLAUDE.md', text: '# Mine\n', fromSession: false, rulesId: 'CLAUDE.md' }],
  ...over
})
const byId = (items: ReturnType<typeof buildItems>): Record<string, ReturnType<typeof buildItems>[number]> => Object.fromEntries(items.map((i) => [i.id, i]))

test('each row counts the text Claude Code recorded, else what the files would give it', () => {
  const items = buildItems(base())
  const i = byId(items)
  const line = '- release-notes: Draft release notes from the git log.'
  assert.equal(i['skill:release-notes'].chars, line.length + 1)
  assert.equal(i['skill:release-notes'].measured, 'session')
  assert.equal(i['skill:release-notes'].uses, 12)
  assert.equal(i['skill:pdf-extract'].measured, 'files', 'not in the listing yet: its SKILL.md')
  assert.equal(i['skill:pdf-extract'].chars, skillLine('pdf-extract', 'Extract text and tables from PDF files.', 'full').length + 1)
  assert.equal(i['skill:legacy'].on, false)
  assert.equal(i['skill:legacy'].tokens, 0)
  assert.equal(i['skill:manual'], undefined, 'disable-model-invocation is never in context')
  assert.equal(i['skill:demo-tools:changelog-writer'], undefined, 'a plugin turned off since: the old listing does not bring it back')

  const gh = i['mcp:github']
  assert.equal(gh.tools, 2)
  assert.equal(gh.chars, '## github\nUse it for issues.'.length + 2 + 'mcp__github__create_issue'.length + 1 + 'mcp__github__list_prs'.length + 1)
  assert.equal(gh.tokens, estimateTokens(gh.chars ?? 0))
  assert.equal(gh.uses, 0)
  assert.equal(i['mcp:docs-search'].uses, 4)
  assert.equal(i['mcp:filesystem'].on, false)
  assert.equal(i['mcp:filesystem'].tokens, 0)
  assert.equal(i['mcp:filesystem'].switchable, true)
  const figma = i['mcp:plugin:design:figma']
  assert.equal(figma.switchable, false)
  assert.equal(figma.missing, 'needs-auth')
  assert.equal(figma.tokens, null)
  assert.equal(i['memory:/u/.claude/CLAUDE.md'].chars, 7)
  assert.deepEqual(i['memory:/u/.claude/CLAUDE.md'].open, { screen: 'rules', id: 'CLAUDE.md' })
  assert.deepEqual(i['skill:pdf-extract'].open, { screen: 'skills', id: 'skills/pdf-extract' })
  assert.deepEqual(i['mcp:github'].open, { screen: 'mcp', id: 'user:github' })

  // on and measured first, most tokens first; unmeasured next; off last
  const ranks = items.map((x) => (!x.on ? 'off' : x.tokens === null ? 'unmeasured' : 'on'))
  assert.deepEqual(ranks, [...ranks].sort((a, b) => ['on', 'unmeasured', 'off'].indexOf(a) - ['on', 'unmeasured', 'off'].indexOf(b)))
  const measuredOn = items.filter((x) => x.on && x.tokens !== null)
  assert.deepEqual(measuredOn.map((x) => x.tokens), [...measuredOn.map((x) => x.tokens)].sort((a, b) => (b ?? 0) - (a ?? 0)))
  assert.equal(totalTokens(items), measuredOn.reduce((n, x) => n + (x.tokens ?? 0), 0))
})

test('skills only the session listed: their own source, synced ones without a switch, uses by their own key', () => {
  const extra = att({
    type: 'skill_listing',
    isInitial: false,
    content: '- loop: Run a prompt on an interval.\n- anthropic-skills:docx: Word files.\n- vercel:deploy: Deploy to Vercel.',
    names: []
  })
  const i = byId(
    buildItems(
      base({
        records: recordsOf(listing, extra),
        skillUsage: { deploy: { usageCount: 12, lastUsedAt: 1 }, 'vercel:deploy': { usageCount: 3, lastUsedAt: 2 } },
        overrides: { docx: 'off' }
      })
    )
  )
  assert.equal(i['skill:loop'].source, '')
  assert.equal(i['skill:loop'].switchable, true)
  assert.equal(i['skill:vercel:deploy'].source, 'vercel')
  assert.equal(i['skill:vercel:deploy'].uses, 3, 'never the uses of another skill with the same short name')
  assert.equal(i['skill:anthropic-skills:docx'].source, 'synced')
  assert.equal(i['skill:anthropic-skills:docx'].switchable, false)
  assert.equal(i['skill:anthropic-skills:docx'].on, false, 'the Skills screen turned it off by its bare name')
})

test('without a tool list a server has no number; without any session, skills come from their files', () => {
  const i = byId(buildItems(base({ records: recordsOf(listing, instructions) })))
  assert.equal(i['mcp:github'].tokens, null)
  assert.equal(i['mcp:github'].missing, 'not-seen')
  const none = byId(buildItems(base({ records: null, denied: new Set(['gone']) })))
  assert.equal(none['skill:release-notes'].measured, 'files')
  assert.equal(none['mcp:docs-search'].missing, 'not-seen')
  assert.equal(none['mcp:gone'].on, false, 'a server turned off here and since removed can still be turned back on')
  assert.equal(none['mcp:gone'].switchable, true)
  const nameOnly = byId(buildItems(base({ overrides: { 'release-notes': 'name-only' } })))
  assert.equal(nameOnly['skill:release-notes'].chars, '- release-notes'.length + 1)
})

test('estimates read with ≈, and an exact zero without', () => {
  assert.equal(formatEstimate(0), '0')
  assert.equal(formatEstimate(34), '≈ 34')
  assert.equal(formatEstimate(1000), '≈ 1k')
  assert.equal(formatEstimate(1440), '≈ 1.4k')
  assert.equal(formatEstimate(9960), '≈ 10k')
  assert.equal(formatEstimate(123_456), '≈ 123k')
  assert.equal(estimateTokens(35), 10)
})

test('transcripts are read on from where the last read stopped, a line still being written waits, lines cross chunks', async () => {
  const { readCalls, readRecords } = await import('./scan.ts')
  const fs = await import('node:fs/promises')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claudock-context-'))
  try {
    const file = path.join(dir, 's.jsonl')
    const call = (id: string, tool = 'mcp__github__list_prs'): string =>
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-29T10:00:00.000Z', message: { content: [{ type: 'tool_use', id, name: tool, input: {} }] } })
    const filler = JSON.stringify({ type: 'user', cwd: '/code/app', message: { content: 'x'.repeat(5 * 1024 * 1024) } })
    await fs.writeFile(file, [JSON.stringify(listing), filler, call('a'), ''].join('\n') + call('b').slice(0, 20))
    const info = async (): Promise<{ abs: string; size: number; mtimeMs: number }> => {
      const st = await fs.stat(file)
      return { abs: file, size: st.size, mtimeMs: st.mtimeMs }
    }
    const first = await readCalls(await info())
    assert.deepEqual(first.calls.map((c) => c.id), ['a'], 'the half-written call is not read yet')
    const records = await readRecords(await info())
    assert.equal(records.records.skills?.size, 3)
    assert.equal(records.cwd, '/code/app')

    await fs.writeFile(file, [JSON.stringify(listing), filler, call('a'), call('b'), call('c', 'mcp__docs-search__search'), JSON.stringify(tools), ''].join('\n'))
    const next = await readCalls(await info(), first)
    assert.deepEqual(next.calls.map((c) => `${c.key}:${c.id}`), ['github:a', 'github:b', 'docs-search:c'])
    const more = await readRecords(await info(), records)
    assert.equal(more.records.tools?.get('github')?.size, 2, 'the records appended since are folded in')
    assert.equal(more.records.skills?.size, 3, 'and the earlier ones kept')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
