import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildOut, buildPlan, hookScriptToken, jsonText, pointerText, stateOf, type Source } from './model.ts'
import { existingNames, readRemote, readRepo } from './repo.ts'
import { checkRel, devAllowed, readText, writeFiles, writeOne, type WriteGuard } from './write.ts'

const FAKE = 'ghp_FAKEDONOTUSE0123456789abcdefghij'
const SETUP = { marketplace: 'acme-setup', plugin: 'team', owner: 'Acme' }
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudock-team-')))
}

/** A guard that allows the folder and records what went to the "Trash" (a folder beside it). */
function guardFor(trashed: string[]): WriteGuard {
  return {
    allowed: () => true,
    trash: async (abs) => {
      trashed.push(abs)
      fs.rmSync(abs)
    }
  }
}

function repoFolder(): string {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, '.git'))
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:acme/claude-setup.git\n')
  return dir
}

const HOME = '/Users/sam'
const skill = (name: string, body = 'Draft release notes.'): Source => ({
  kind: 'skill',
  id: `skill:${name}`,
  name,
  files: [{ rel: 'SKILL.md', data: bytes(`---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`) }],
  link: false,
  bytes: 100
})
const hook: Source = (() => {
  const s = hookScriptToken('~/bin/fmt.sh', HOME)
  return {
    kind: 'hook',
    id: 'hook:PostToolUse:Edit|Write:abcd1234',
    name: 'fmt.sh',
    event: 'PostToolUse',
    matcher: 'Edit|Write',
    entry: { type: 'command', command: '~/bin/fmt.sh' },
    commandKey: 'command',
    script: s ? { ...s, file: true, data: bytes('#!/bin/sh\nexit 0\n') } : null
  }
})()
const github: Source = { kind: 'mcp', id: 'mcp:github', name: 'github', config: { type: 'http', url: 'https://api.example.com/mcp/', headers: { Authorization: `Bearer ${FAKE}` } } }

test('paths: only plain relative paths inside the folder', () => {
  assert.equal(checkRel('plugins/team/skills/a/SKILL.md'), 'plugins/team/skills/a/SKILL.md')
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\\b', 'C:/x', './a', 'a/\0']) assert.throws(() => checkRel(bad), /Refusing/, bad)
})

test('the development rule: a synthetic folder only, unless real writes are allowed', () => {
  const dir = tmp()
  try {
    assert.equal(devAllowed(dir, { dev: true, allowReal: false }), false)
    assert.equal(devAllowed(dir, { dev: true, allowReal: true }), true)
    assert.equal(devAllowed(dir, { dev: false, allowReal: false }), true)
    assert.equal(devAllowed(dir, { dev: false, allowReal: false, readonly: true }), false)
    fs.writeFileSync(path.join(dir, '.claudock-fixture'), '')
    assert.equal(devAllowed(dir, { dev: true, allowReal: false }), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('read, plan, write, read again: published, and a second write writes nothing', async () => {
  const dir = repoFolder()
  const trashed: string[] = []
  const guard = guardFor(trashed)
  try {
    assert.deepEqual(await readRemote(dir), { kind: 'github', text: 'acme/claude-setup' })
    const outs = [buildOut(skill('release-notes'), []), buildOut(hook, [{ kind: 'copy-script', where: 'command', as: 'fmt.sh' }]), buildOut(github, [{ kind: 'ask', where: 'headers.Authorization', key: 'github_token' }])]
    const view0 = await readRepo(dir, 'team')
    assert.equal(view0.manifest, null)
    const plan = buildPlan(SETUP, outs.map((out) => ({ out, mode: 'write' as const })), view0)
    const r1 = await writeFiles(dir, plan.writes, plan.removes, guard)
    assert.equal(r1.written.length, plan.writes.size)
    // the script keeps its run bit, nothing holds the token
    assert.ok(fs.statSync(path.join(dir, 'plugins/team/bin/fmt.sh')).mode & 0o100)
    for (const rel of fs.readdirSync(dir, { recursive: true })) {
      const f = path.join(dir, String(rel))
      if (fs.statSync(f).isFile()) assert.ok(!fs.readFileSync(f, 'utf8').includes(FAKE), `${rel} holds the token`)
    }
    assert.deepEqual(await existingNames(dir), { marketplace: 'acme-setup', plugin: 'team', owner: 'Acme' })

    const view1 = await readRepo(dir, 'team')
    for (const o of outs) assert.equal(stateOf(true, o, view1.manifest?.items.find((r) => r.id === o.id) ?? null, view1), 'published')
    const again = buildPlan(SETUP, outs.map((out) => ({ out, mode: 'write' as const })), view1)
    const r2 = await writeFiles(dir, again.writes, again.removes, guard)
    assert.deepEqual(r2, { written: [], removed: [] })

    // the skill is left out: its file goes to the Trash and its empty folder with it, the rest stays
    const third = buildPlan(SETUP, outs.slice(1).map((out) => ({ out, mode: 'write' as const })), view1)
    const r3 = await writeFiles(dir, third.writes, third.removes, guard)
    assert.deepEqual(r3.removed, ['plugins/team/skills/release-notes/SKILL.md'])
    assert.equal(trashed.length, 1)
    assert.ok(!fs.existsSync(path.join(dir, 'plugins/team/skills/release-notes')))
    assert.ok(fs.existsSync(path.join(dir, 'plugins/team/bin/fmt.sh')))
    assert.equal(stateOf(false, outs[0], view1.manifest?.items.find((r) => r.id === 'skill:release-notes') ?? null, await readRepo(dir, 'team')), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('never through a link, never over a link', async () => {
  const dir = repoFolder()
  const outside = tmp()
  try {
    fs.mkdirSync(path.join(dir, 'plugins'))
    fs.symlinkSync(outside, path.join(dir, 'plugins', 'team'))
    await assert.rejects(writeFiles(dir, new Map([['plugins/team/x.md', bytes('x')]]), [], guardFor([])), /not a plain folder/)
    assert.deepEqual(fs.readdirSync(outside), [])
    fs.unlinkSync(path.join(dir, 'plugins', 'team'))
    fs.mkdirSync(path.join(dir, 'plugins', 'team'))
    fs.writeFileSync(path.join(outside, 'secret'), 'mine')
    fs.symlinkSync(path.join(outside, 'secret'), path.join(dir, 'plugins', 'team', 'x.md'))
    await assert.rejects(writeFiles(dir, new Map([['plugins/team/x.md', bytes('x')]]), [], guardFor([])), /not a plain file/)
    assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'mine')
    // refused before anything is written
    await assert.rejects(writeFiles(dir, new Map([['a.md', bytes('a')], ['../b.md', bytes('b')]]), [], guardFor([])), /Refusing/)
    assert.ok(!fs.existsSync(path.join(dir, 'a.md')))
    // a folder that may not be written
    await assert.rejects(writeFiles(dir, new Map([['a.md', bytes('a')]]), [], { allowed: () => false, trash: async () => undefined }), /turned off/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test("a project's settings.json: the two keys in, the rest byte for byte", async () => {
  const project = tmp()
  try {
    fs.mkdirSync(path.join(project, '.claude'))
    const before = jsonText({ permissions: { allow: ['Bash(npm test)'] } })
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), before)
    const remote = { kind: 'github' as const, text: 'acme/claude-setup' }
    const next = pointerText(await readText(project, '.claude/settings.json'), SETUP, remote).text
    assert.equal(await writeOne(project, '.claude/settings.json', next, guardFor([])), true)
    assert.equal(await writeOne(project, '.claude/settings.json', next, guardFor([])), false)
    const got = JSON.parse(fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'))
    assert.deepEqual(Object.keys(got), ['permissions', 'extraKnownMarketplaces', 'enabledPlugins'])
    assert.deepEqual(got.permissions, { allow: ['Bash(npm test)'] })
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})
