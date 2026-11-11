import test from 'node:test'
import assert from 'node:assert/strict'
import { marketplaceNameProblem, pluginNameProblem, slugName, type Fix } from '../../shared/api/team.ts'
import {
  buildOut,
  buildPlan,
  commitMessage,
  emptyRepo,
  findSecrets,
  findingsFor,
  hookScriptToken,
  isOpen,
  isPointed,
  joinCommands,
  jsonText,
  namesHome,
  parseManifest,
  parseRemote,
  planToken,
  pointerText,
  sendCommand,
  sha256,
  stateOf,
  suggestKey,
  tilde,
  unpointerText,
  type ItemOut,
  type JsonObj,
  type Plan,
  type RepoView,
  type Source
} from './model.ts'

const HOME = '/Users/sam'
const FAKE = 'ghp_FAKEDONOTUSE0123456789abcdefghij'
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (d: Uint8Array | undefined): string => new TextDecoder().decode(d)
const SETUP = { marketplace: 'acme-setup', plugin: 'team', owner: 'Acme' }

const skill = (name: string, body = 'Draft release notes.'): Source => ({
  kind: 'skill',
  id: `skill:${name}`,
  name,
  files: [{ rel: 'SKILL.md', data: bytes(`---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`) }],
  link: false,
  bytes: 100
})
const agent: Source = { kind: 'agent', id: 'agent:code-reviewer', name: 'code-reviewer', rel: 'code-reviewer.md', data: bytes('---\nname: code-reviewer\n---\nReview the diff.\n') }
const command: Source = { kind: 'command', id: 'command:review:pr', name: 'review:pr', rel: 'review/pr.md', data: bytes('Review this PR.\n') }
const hook = (cmd = '~/bin/fmt.sh --write', file = true): Source => {
  const s = hookScriptToken(cmd, HOME)
  return {
    kind: 'hook',
    id: 'hook:PostToolUse:Edit|Write:abcd1234',
    name: 'fmt.sh',
    event: 'PostToolUse',
    matcher: 'Edit|Write',
    entry: { type: 'command', command: cmd, timeout: 10 },
    commandKey: 'command',
    script: s ? { token: s.token, abs: s.abs, file, data: file ? bytes('#!/bin/sh\nexit 0\n') : null } : null
  }
}
const github: Source = {
  kind: 'mcp',
  id: 'mcp:github',
  name: 'github',
  config: { type: 'http', url: 'https://api.example.com/mcp/', headers: { Authorization: `Bearer ${FAKE}`, 'X-Team': 'acme' } }
}

/** The repo as it is right after `plan` was written to an empty folder (or over `before`). */
function written(plan: Plan, plugin = 'team', before: RepoView = emptyRepo()): RepoView {
  const root = `plugins/${plugin}/`
  const files = new Map(before.files)
  for (const rel of plan.removes) files.delete(rel.slice(root.length))
  const view: RepoView = { files, manifest: plan.manifest, readme: true }
  for (const [rel, data] of plan.writes) {
    if (rel === '.claude-plugin/marketplace.json') view.marketplace = JSON.parse(text(data))
    if (!rel.startsWith(root)) continue
    const r = rel.slice(root.length)
    if (r !== '.claudock.json') files.set(r, sha256(data))
    if (r === 'hooks/hooks.json') view.hooks = JSON.parse(text(data))
    if (r === '.mcp.json') view.mcp = JSON.parse(text(data))
    if (r === '.claude-plugin/plugin.json') view.pluginJson = JSON.parse(text(data))
  }
  return view
}
const write = (outs: ItemOut[], view: RepoView = emptyRepo()): Plan =>
  buildPlan(
    SETUP,
    outs.map((out) => ({ out, mode: 'write' as const })),
    view
  )

test('names', () => {
  assert.equal(marketplaceNameProblem('acme-setup'), null)
  assert.ok(marketplaceNameProblem('claude-plugins-official'))
  assert.ok(marketplaceNameProblem('has space'))
  assert.equal(pluginNameProblem('team'), null)
  assert.ok(pluginNameProblem('claude-team'))
  assert.ok(pluginNameProblem('Team'))
  assert.ok(pluginNameProblem('a--b'))
  assert.equal(slugName('Acme Inc. Setup!', 'team'), 'acme-inc-setup')
  assert.equal(slugName('***', 'team'), 'team')
})

test('home paths', () => {
  assert.equal(tilde('/Users/sam/bin/x', HOME), '~/bin/x')
  assert.equal(tilde('/Users/samantha/x', HOME), '/Users/samantha/x')
  assert.deepEqual(hookScriptToken('~/bin/fmt.sh --write', HOME), { token: '~/bin/fmt.sh', abs: '/Users/sam/bin/fmt.sh' })
  assert.deepEqual(hookScriptToken('bash "$HOME/my hooks/run.sh"', HOME), { token: '"$HOME/my hooks/run.sh"', abs: '/Users/sam/my hooks/run.sh' })
  assert.deepEqual(hookScriptToken('node /Users/sam/x.js', HOME), { token: '/Users/sam/x.js', abs: '/Users/sam/x.js' })
  assert.equal(hookScriptToken('npx prettier --write .', HOME), null)
  assert.equal(hookScriptToken('node /Users/samantha/x.js', HOME), null)
  assert.ok(namesHome('see /Users/sam/notes.md', HOME))
  assert.ok(!namesHome('see /Users/samantha/notes.md and ~/notes.md', HOME))
})

test('secrets: found by shape and by name, never inside a variable', () => {
  assert.deepEqual(
    findSecrets(github.config as JsonObj).map((h) => h.where),
    ['headers.Authorization']
  )
  const cfg: JsonObj = {
    command: 'npx',
    args: ['-y', 'server', '--token=sk-abcdefghijklmnopqrstuvwxyz', 'https://user:hunter2pass@host/x?api_key=abcdef123456'],
    env: { API_KEY: 'plainvalue123', REGION: 'eu-west-1', TOKEN: '${MY_TOKEN}', DEBUG: 'true' }
  }
  assert.deepEqual(
    findSecrets(cfg).map((h) => h.where),
    ['env.API_KEY', 'args.2', 'args.3']
  )
  assert.deepEqual(findSecrets({ url: 'https://x.example/mcp?token=abcdef0123456789' }).map((h) => h.where), ['url'])
  assert.deepEqual(findSecrets({ headers: { Authorization: 'Bearer ${user_config.github_token}' }, env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } }), [])
  assert.equal(suggestKey('github', 'headers.Authorization'), 'github_token')
  assert.equal(suggestKey('docs', 'env.API_KEY'), 'api_key')
  assert.equal(suggestKey('my server', 'args.2'), 'my_server_secret')
})

test('findings: each problem, and the fix that settles it', () => {
  // a token blocks until it becomes a question or a variable
  let f = findingsFor(github, [], HOME)
  assert.equal(f.length, 1)
  assert.equal(f[0].code, 'secret')
  assert.ok(isOpen(f[0]))
  assert.ok(!JSON.stringify(f).includes(FAKE))
  f = findingsFor(github, [{ kind: 'ask', where: 'headers.Authorization', key: 'github_token' }], HOME)
  assert.ok(!isOpen(f[0]))

  // a hook's script
  f = findingsFor(hook(), [], HOME)
  assert.deepEqual(
    f.map((x) => [x.code, x.text, isOpen(x)]),
    [['script', 'Runs ~/bin/fmt.sh, which only you have', true]]
  )
  assert.ok(!isOpen(findingsFor(hook(), [{ kind: 'copy-script', where: 'command', as: 'fmt.sh' }], HOME)[0]))
  // a folder cannot be copied in, and a second home path stays a blocker after the copy
  assert.deepEqual(findingsFor(hook('~/tools --x', false), [], HOME).map((x) => x.code), ['home-command'])
  assert.deepEqual(findingsFor(hook('~/bin/fmt.sh --config ~/.fmtrc'), [{ kind: 'copy-script', where: 'command', as: 'fmt.sh' }], HOME).map((x) => [x.code, isOpen(x)]), [
    ['script', false],
    ['home-command', true]
  ])
  // a hook that runs nothing of yours has nothing to fix
  assert.deepEqual(findingsFor(hook('npx prettier --write .'), [], HOME), [])

  // a server started from the home folder
  const local: Source = { kind: 'mcp', id: 'mcp:local', name: 'local', config: { command: 'node', args: ['/Users/sam/tools/server.js'] } }
  assert.deepEqual(findingsFor(local, [], HOME).map((x) => [x.code, x.blocks]), [['home-command', true]])

  // warnings: a path in the text, a big folder; a link blocks
  const s = skill('notes', 'Read /Users/sam/notes first.')
  assert.deepEqual(findingsFor(s, [], HOME).map((x) => [x.code, x.blocks]), [['home-mention', false]])
  assert.ok(findingsFor(s, [{ kind: 'keep', where: 'text' }], HOME)[0].fix)
  assert.deepEqual(findingsFor({ ...skill('big'), bytes: 6 * 1024 * 1024 } as Source, [], HOME).map((x) => x.code), ['big'])
  assert.deepEqual(findingsFor({ ...skill('linked'), link: true } as Source, [], HOME).map((x) => [x.code, x.blocks]), [['link', true]])
  assert.deepEqual(findingsFor(skill('clean'), [], HOME), [])
})

test('an item as written: fixes applied, no secret left', () => {
  const ask: Fix = { kind: 'ask', where: 'headers.Authorization', key: 'github_token' }
  const o = buildOut(github, [ask])
  assert.deepEqual(o.mcp?.config.headers, { Authorization: 'Bearer ${user_config.github_token}', 'X-Team': 'acme' })
  assert.deepEqual(o.userConfig, { github_token: { type: 'string', title: 'github token', description: 'Used by the github MCP server.', sensitive: true, required: true } })
  assert.equal((buildOut(github, [{ kind: 'env', where: 'headers.Authorization', name: 'GITHUB_TOKEN' }]).mcp?.config.headers as JsonObj).Authorization, 'Bearer ${GITHUB_TOKEN}')

  const h = buildOut(hook(), [{ kind: 'copy-script', where: 'command', as: 'fmt.sh' }])
  assert.deepEqual(h.hook?.group, { matcher: 'Edit|Write', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/bin/fmt.sh" --write', timeout: 10 }] })
  assert.deepEqual(h.files.map((f) => f.rel), ['bin/fmt.sh'])
  assert.equal(h.hook?.key, 'PostToolUse|Edit|Write|bin/fmt.sh')

  assert.deepEqual(buildOut(skill('release-notes'), []).files.map((f) => f.rel), ['skills/release-notes/SKILL.md'])
  assert.deepEqual(buildOut(command, []).files.map((f) => f.rel), ['commands/review/pr.md'])
  // the same content gives the same hash; a change gives another
  assert.equal(buildOut(skill('a'), []).sha, buildOut(skill('a'), []).sha)
  assert.notEqual(buildOut(skill('a'), []).sha, buildOut(skill('a', 'Other.'), []).sha)
})

test('the plan: every kind in its place, hooks wrapped, nothing secret in any byte', () => {
  const outs = [
    buildOut(skill('release-notes'), []),
    buildOut(agent, []),
    buildOut(command, []),
    buildOut(hook(), [{ kind: 'copy-script', where: 'command', as: 'fmt.sh' }]),
    buildOut(github, [{ kind: 'ask', where: 'headers.Authorization', key: 'github_token' }])
  ]
  const plan = write(outs)
  assert.deepEqual([...plan.writes.keys()].sort(), [
    '.claude-plugin/marketplace.json',
    'README.md',
    'plugins/team/.claude-plugin/plugin.json',
    'plugins/team/.claudock.json',
    'plugins/team/.mcp.json',
    'plugins/team/agents/code-reviewer.md',
    'plugins/team/bin/fmt.sh',
    'plugins/team/commands/review/pr.md',
    'plugins/team/hooks/hooks.json',
    'plugins/team/skills/release-notes/SKILL.md'
  ])
  assert.deepEqual(plan.removes, [])
  for (const [rel, data] of plan.writes) assert.ok(!text(data).includes(FAKE), `${rel} holds the token`)
  assert.deepEqual(JSON.parse(text(plan.writes.get('plugins/team/hooks/hooks.json'))), {
    hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/bin/fmt.sh" --write', timeout: 10 }] }] }
  })
  assert.deepEqual(JSON.parse(text(plan.writes.get('.claude-plugin/marketplace.json'))), {
    name: 'acme-setup',
    owner: { name: 'Acme' },
    description: "Acme's shared Claude Code setup",
    plugins: [{ name: 'team', source: './plugins/team', description: "Acme's shared Claude Code setup" }]
  })
  const pj = JSON.parse(text(plan.writes.get('plugins/team/.claude-plugin/plugin.json')))
  assert.equal(pj.name, 'team')
  assert.equal(pj.version, undefined)
  assert.deepEqual(Object.keys(pj.userConfig), ['github_token'])
  assert.deepEqual(parseManifest(JSON.parse(text(plan.writes.get('plugins/team/.claudock.json')))), plan.manifest)
  assert.equal(plan.manifest.items.length, 5)

  // written again with nothing changed: byte for byte the same plan
  const again = write(outs, written(plan))
  assert.equal(planToken({ ...again, writes: new Map([...again.writes].filter(([r]) => r !== 'README.md')) }), planToken({ ...plan, writes: new Map([...plan.writes].filter(([r]) => r !== 'README.md')) }))
  assert.deepEqual(again.removes, [])
})

test('the plan keeps what it did not write, and takes away only its own', () => {
  const view: RepoView = {
    files: new Map([['skills/handmade/SKILL.md', 'x']]),
    manifest: null,
    readme: true,
    hooks: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } },
    mcp: { mcpServers: { theirs: { command: 'npx', args: ['theirs'] } } },
    pluginJson: { name: 'team', description: 'Ours', keywords: ['x'], userConfig: { region: { type: 'string', title: 'Region', description: 'r' } } },
    marketplace: { name: 'acme-setup', owner: { name: 'Acme Corp', email: 'dev@example.com' }, plugins: [{ name: 'other', source: './plugins/other' }] }
  }
  const first = write([buildOut(skill('release-notes'), []), buildOut(hook(), [{ kind: 'copy-script', where: 'command', as: 'fmt.sh' }]), buildOut(github, [{ kind: 'env', where: 'headers.Authorization', name: 'GH' }])], view)
  assert.ok(!first.writes.has('README.md'))
  const hooks = JSON.parse(text(first.writes.get('plugins/team/hooks/hooks.json'))).hooks
  assert.deepEqual(Object.keys(hooks), ['Stop', 'PostToolUse'])
  assert.deepEqual(Object.keys(JSON.parse(text(first.writes.get('plugins/team/.mcp.json'))).mcpServers), ['theirs', 'github'])
  const market = JSON.parse(text(first.writes.get('.claude-plugin/marketplace.json')))
  assert.deepEqual(market.owner, { name: 'Acme Corp', email: 'dev@example.com' })
  assert.deepEqual(market.plugins.map((p: JsonObj) => p.name), ['other', 'team'])
  const pj = JSON.parse(text(first.writes.get('plugins/team/.claude-plugin/plugin.json')))
  assert.equal(pj.description, 'Ours')
  assert.deepEqual(pj.keywords, ['x'])
  assert.deepEqual(Object.keys(pj.userConfig), ['region'])

  // the skill, the hook and the server are left out next time: their files go, the rest stays
  const after = written(first, 'team', view)
  const second = write([], after)
  assert.deepEqual(second.removes, ['plugins/team/bin/fmt.sh', 'plugins/team/skills/release-notes/SKILL.md'])
  assert.deepEqual(JSON.parse(text(second.writes.get('plugins/team/hooks/hooks.json'))).hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] })
  assert.deepEqual(Object.keys(JSON.parse(text(second.writes.get('plugins/team/.mcp.json'))).mcpServers), ['theirs'])
  assert.ok(!second.removes.some((r) => r.includes('handmade')))
})

test('states: here, in the repo, in both', () => {
  const a = buildOut(skill('a'), [])
  const none = emptyRepo()
  assert.equal(stateOf(true, a, null, none), 'new')
  assert.equal(stateOf(false, a, null, none), null)

  const view = written(write([a]))
  const rec = view.manifest?.items[0] ?? null
  assert.equal(stateOf(true, a, rec, view), 'published')
  assert.equal(stateOf(false, a, rec, view), 'removed')
  const a2 = buildOut(skill('a', 'Changed here.'), [])
  assert.equal(stateOf(true, a2, rec, view), 'changed-here')

  // someone changed the file in the repo, or added one to the skill's folder
  const edited: RepoView = { ...view, files: new Map(view.files).set('skills/a/SKILL.md', 'other') }
  assert.equal(stateOf(true, a, rec, edited), 'changed-repo')
  assert.equal(stateOf(true, a2, rec, edited), 'changed-both')
  const added: RepoView = { ...view, files: new Map(view.files).set('skills/a/extra.md', 'x') }
  assert.equal(stateOf(true, a, rec, added), 'changed-repo')
  // both ended the same: nothing to do
  const same: RepoView = { ...view, files: new Map(view.files).set('skills/a/SKILL.md', sha256(a2.files[0].data)) }
  assert.equal(stateOf(true, a2, rec, same), 'published')
  // deleted from the repo
  const gone: RepoView = { ...view, files: new Map() }
  assert.equal(stateOf(true, a, rec, gone), 'changed-repo')
  assert.equal(stateOf(false, a, rec, gone), null)

  // the repo already had a file where a new item goes
  const taken: RepoView = { ...none, files: new Map([['skills/a/SKILL.md', 'other']]) }
  assert.equal(stateOf(true, a, null, taken), 'changed-both')
  assert.equal(stateOf(true, a, null, { ...none, files: new Map([['skills/a/SKILL.md', sha256(a.files[0].data)]]) }), 'published')

  // a hook and a server changed in the repo are seen too
  const h = buildOut(hook(), [{ kind: 'copy-script', where: 'command', as: 'fmt.sh' }])
  const g = buildOut(github, [{ kind: 'ask', where: 'headers.Authorization', key: 'github_token' }])
  const v2 = written(write([h, g]))
  const recOf = (id: string) => v2.manifest?.items.find((r) => r.id === id) ?? null
  assert.equal(stateOf(true, h, recOf(h.id), v2), 'published')
  assert.equal(stateOf(true, g, recOf(g.id), v2), 'published')
  const hooks2 = JSON.parse(JSON.stringify(v2.hooks))
  hooks2.hooks.PostToolUse[0].hooks[0].timeout = 30
  assert.equal(stateOf(true, h, recOf(h.id), { ...v2, hooks: hooks2 }), 'changed-repo')
  const mcp2 = JSON.parse(JSON.stringify(v2.mcp))
  mcp2.mcpServers.github.url = 'https://other.example/mcp/'
  assert.equal(stateOf(true, g, recOf(g.id), { ...v2, mcp: mcp2 }), 'changed-repo')
})

test('an item changed in the repo is kept as the repo has it', () => {
  const a = buildOut(skill('a'), [])
  const b = buildOut(skill('b'), [])
  const view = written(write([a, b]))
  const edited: RepoView = { ...view, files: new Map(view.files).set('skills/a/SKILL.md', 'theirs') }
  const plan = buildPlan(SETUP, [{ out: a, mode: 'keep' }, { out: buildOut(skill('b', 'Mine now.'), []), mode: 'write' }], edited)
  assert.ok(!plan.writes.has('plugins/team/skills/a/SKILL.md'))
  assert.ok(plan.writes.has('plugins/team/skills/b/SKILL.md'))
  assert.deepEqual(plan.removes, [])
  // its record is carried over, so it still reads as changed in the repo afterwards
  assert.equal(plan.manifest.items.find((r) => r.id === 'skill:a')?.sha, a.sha)
  assert.ok('skills/a/SKILL.md' in plan.manifest.files)
})

test('the repo address', () => {
  const cfg = (url: string): string => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[remote "fork"]\n\turl = https://github.com/x/y.git\n`
  assert.deepEqual(parseRemote(cfg('https://github.com/acme/claude-setup.git')), { kind: 'github', text: 'acme/claude-setup' })
  assert.deepEqual(parseRemote(cfg('git@github.com:acme/claude-setup.git')), { kind: 'github', text: 'acme/claude-setup' })
  assert.deepEqual(parseRemote(cfg('ssh://git@github.com/acme/claude-setup')), { kind: 'github', text: 'acme/claude-setup' })
  assert.deepEqual(parseRemote(cfg('https://git.example.com/acme/setup.git')), { kind: 'git', text: 'https://git.example.com/acme/setup.git' })
  // a login in the URL never leaves the folder
  assert.deepEqual(parseRemote(cfg(`https://sam:${FAKE}@git.example.com/acme/setup.git`)), { kind: 'git', text: 'https://git.example.com/acme/setup.git' })
  assert.deepEqual(parseRemote(cfg(`https://${FAKE}@github.com/acme/claude-setup.git`)), { kind: 'github', text: 'acme/claude-setup' })
  assert.equal(parseRemote('[core]\n\tbare = false\n'), null)
})

test('a connected project: two keys in, two keys out, the rest untouched', () => {
  const remote = { kind: 'github' as const, text: 'acme/claude-setup' }
  const before = jsonText({ permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'x@y': true } })
  const p = pointerText(before, SETUP, remote)
  assert.deepEqual(JSON.parse(p.text), {
    permissions: { allow: ['Bash(npm test)'] },
    enabledPlugins: { 'x@y': true, 'team@acme-setup': true },
    extraKnownMarketplaces: { 'acme-setup': { source: { source: 'github', repo: 'acme/claude-setup' }, autoUpdate: true } }
  })
  assert.ok(isPointed(p.text, SETUP))
  assert.ok(!isPointed(before, SETUP))
  assert.equal(unpointerText(p.text, SETUP).text, before)
  // a project without the file, and one whose file is not an object
  assert.deepEqual(JSON.parse(pointerText(null, SETUP, { kind: 'git', text: 'https://git.example.com/a.git' }).text).extraKnownMarketplaces['acme-setup'].source, { source: 'git', url: 'https://git.example.com/a.git' })
  assert.equal(unpointerText(pointerText(null, SETUP, remote).text, SETUP).text, '{}\n')
  assert.ok(pointerText('[1]', SETUP, remote).problem)
  assert.equal(pointerText('[1]', SETUP, remote).text, '[1]')
})

test('commands to copy', () => {
  const remote = { kind: 'github' as const, text: 'acme/claude-setup' }
  assert.deepEqual(joinCommands(SETUP, remote, true), {
    user: 'claude plugin marketplace add acme/claude-setup && claude plugin install team@acme-setup',
    project: 'claude plugin install team@acme-setup --scope project',
    configure: '/plugin configure team@acme-setup'
  })
  assert.equal(joinCommands(SETUP, remote, false).configure, null)
  assert.equal(commitMessage({ added: 2, changed: 1, removed: 0 }), 'Team setup: 2 added, 1 changed')
  assert.equal(commitMessage({ added: 0, changed: 0, removed: 0 }), 'Team setup')
  assert.equal(sendCommand(SETUP, { added: 2, changed: 0, removed: 1 }, true), 'git add -A .claude-plugin plugins/team README.md && git commit -m "Team setup: 2 added, 1 removed" && git push')
})
