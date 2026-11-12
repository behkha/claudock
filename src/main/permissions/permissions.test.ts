import test from 'node:test'
import assert from 'node:assert/strict'
import { MASK, maskText, secretsInText } from '../../shared/secrets.ts'
import { classifyRule, isBroad } from './classify.ts'
import { gitArgs, gitStateOf } from './git.ts'
import { buildRows, projectName, ruleId, rulesIn, type RuleFileRead } from './rows.ts'
import { maskRuleFile, removeRuleFromText } from './ruleFile.ts'

/* Every value below is invented for these tests. */
const GH = 'ghp_FAKEDONOTUSE0123456789abcdefABCD'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.c2lnbmF0dXJlLWZha2U'

/** The secrets found in `text`, as the strings they are. */
const found = (text: string): string[] => secretsInText(text).map((s) => text.slice(s.start, s.end))

/* ------------------------------------------------------------------ secrets in a rule's text */

test('rule secrets: a known token shape, anywhere', () => {
  assert.deepEqual(found(`Bash(API_TOKEN=${GH} npm run sync)`), [GH])
  assert.deepEqual(found(`Bash(gh auth login --with-token ${GH})`), [GH])
  assert.deepEqual(found('Bash(aws configure set aws_access_key_id AKIAFAKEFAKEFAKE1234)'), ['AKIAFAKEFAKEFAKE1234'])
  assert.deepEqual(found(`Bash(curl -H "X-Session: ${JWT}" https://api.example.test)`), [JWT])
  assert.deepEqual(found('Bash(slack-cli --token xoxb-0000-fake-do-not-use)'), ['xoxb-0000-fake-do-not-use'])
  assert.deepEqual(found('WebFetch(domain:example.test)'), [])
})

test('rule secrets: name=value and name: value under a secret-like name, eight characters or more', () => {
  assert.deepEqual(found('Bash(PGPASSWORD=correct-horse-fake psql -h db:*)'), ['correct-horse-fake'])
  assert.deepEqual(found('Bash(curl -d key=fake-key-do-not-use https://api.example.test/v1)'), ['fake-key-do-not-use'])
  assert.deepEqual(found('Bash(deploy --api-key=fakefake1234 --region eu)'), ['fakefake1234'])
  assert.deepEqual(found('Bash(mysql --password="fake pass words" shop)'), ['fake pass words'])
  assert.deepEqual(found('Bash(curl -H "X-Api-Key: fakefakefake" https://api.example.test)'), ['fakefakefake'])
  // a trailing wildcard is not part of the value
  assert.deepEqual(found('Bash(SECRET=fake-secret-1:*)'), ['fake-secret-1'])
  // short values, counts, and names that are not a secret's
  assert.deepEqual(found('Bash(TOKEN=short npm test)'), [])
  assert.deepEqual(found('Bash(llm --max-tokens=100000000 run)'), [])
  assert.deepEqual(found('Bash(NODE_ENV=production-build npm run build)'), [])
  assert.deepEqual(found('Bash(docker run registry.example.test/secret:latestversion)'), [])
  assert.deepEqual(found('Bash(npm run token:*)'), [])
})

test('rule secrets: Bearer, Basic and Token values', () => {
  assert.deepEqual(found('Bash(curl -H "Authorization: Bearer fake0123456789abcdefFAKE" https://api.example.test)'), ['fake0123456789abcdefFAKE'])
  assert.deepEqual(found("Bash(curl -H 'Authorization: Basic ZmFrZTpmYWtlZmFrZWZha2U=' https://api.example.test)"), ['ZmFrZTpmYWtlZmFrZWZha2U='])
  assert.deepEqual(found('Bash(http GET api.example.test "X-Auth:Token fake0123456789abcdefFAKE")'), ['fake0123456789abcdefFAKE'])
  assert.deepEqual(found('Bash(echo Bearer of good news)'), [])
})

test('rule secrets: a password or a secret parameter in a URL', () => {
  assert.deepEqual(found('Bash(git clone https://deploy:fake-pass-1234@git.example.test/shop.git)'), ['fake-pass-1234'])
  assert.deepEqual(found('Bash(psql postgres://app:fakefake@db.example.test:5432/shop)'), ['fakefake'])
  assert.deepEqual(found('Bash(curl https://api.example.test/hook?token=fake0123456789&x=1)'), ['fake0123456789'])
  assert.deepEqual(found('WebFetch(https://api.example.test/v1?access_token=fake0123456789)'), ['fake0123456789'])
  assert.deepEqual(found('Bash(curl https://user@git.example.test/shop.git)'), [])
})

test('rule secrets: a value read from a variable is not a secret', () => {
  for (const rule of [
    'Bash(API_TOKEN=$API_TOKEN npm run sync)',
    'Bash(API_TOKEN=${API_TOKEN} npm run sync)',
    'Bash(PGPASSWORD="$PGPASSWORD" psql -h db:*)',
    'Bash(curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.example.test)',
    'Bash(curl -H "Authorization: Bearer ${GITHUB_TOKEN}" https://api.example.test)',
    'Bash(set API_KEY=%API_KEY%)',
    'Bash(TOKEN=$(pass show deploy) npm run deploy)',
    'Bash(git clone https://deploy:$DEPLOY_PASS@git.example.test/shop.git)',
    'Bash(curl https://api.example.test/hook?token=$HOOK_TOKEN)'
  ]) {
    assert.deepEqual(found(rule), [], rule)
  }
})

test('rule secrets: covered text never holds the secret; a token shape keeps only its public start', () => {
  const rules: [string, string, string][] = [
    [`Bash(API_TOKEN=${GH} npm run sync)`, GH, `Bash(API_TOKEN=ghp_${MASK} npm run sync)`],
    ['Bash(PGPASSWORD=correct-horse-fake psql -h db:*)', 'correct-horse-fake', `Bash(PGPASSWORD=${MASK} psql -h db:*)`],
    ['Bash(curl -d key=fake-key-do-not-use https://api.example.test/v1)', 'fake-key-do-not-use', `Bash(curl -d key=${MASK} https://api.example.test/v1)`],
    ['Bash(git clone https://deploy:fake-pass-1234@git.example.test/shop.git)', 'fake-pass-1234', `Bash(git clone https://deploy:${MASK}@git.example.test/shop.git)`]
  ]
  for (const [rule, secret, want] of rules) {
    const c = classifyRule(rule)
    assert.equal(c.secret, true)
    assert.equal(c.text, want)
    assert.equal(c.text.includes(secret), false)
    // no run of the secret longer than its public start is left anywhere
    for (let i = 0; i + 6 <= secret.length; i++) assert.equal(c.text.includes(secret.slice(i, i + 6)), false, `${rule} leaks "${secret.slice(i, i + 6)}"`)
    assert.deepEqual(c.secretSpans.map(([a, b]) => c.text.slice(a, b).endsWith(MASK)), [true])
  }
  // two secrets in one rule: both covered, each with its own span
  const two = classifyRule(`Bash(A_TOKEN=${GH} B_SECRET=another-fake-value run)`)
  assert.equal(two.text, `Bash(A_TOKEN=ghp_${MASK} B_SECRET=${MASK} run)`)
  assert.deepEqual(two.secretSpans.map(([a, b]) => two.text.slice(a, b)), [`ghp_${MASK}`, MASK])
  // nothing to cover: the text is the rule
  assert.deepEqual(maskText('Bash(npm run test:*)', []), { text: 'Bash(npm run test:*)', spans: [] })
  assert.deepEqual(classifyRule('Bash(npm run test:*)'), { text: 'Bash(npm run test:*)', secret: false, secretSpans: [], broad: false })
})

/* ------------------------------------------------------------------ rules that run any script */

test('broad rules: any shell command, or an interpreter or runner with a wildcard', () => {
  for (const rule of ['Bash', 'Bash(*)', 'Bash(python3:*)', 'Bash(python:*)', 'Bash(node *)', 'Bash(node:*)', 'Bash(sh:*)', 'Bash(bash:*)', 'Bash(zsh:*)', 'Bash(ruby:*)', 'Bash(perl:*)', 'Bash(deno:*)', 'Bash(bun:*)', 'Bash(npx:*)', 'Bash(uvx:*)', 'Bash(sudo:*)', 'Bash(env:*)', 'Bash(xargs:*)', 'Bash(eval:*)', 'Bash(/usr/bin/python3:*)']) {
    assert.equal(isBroad(rule), true, rule)
  }
  for (const rule of ['Bash(npm run test:*)', 'Bash(python3 scripts/build.py)', 'Bash(node scripts/check.mjs:*)', 'Bash(nodemon:*)', 'Bash(git status)', 'Read(~/.zshrc)', 'WebFetch(domain:example.test)', 'mcp__github__get_issue', 'Bash(npx prettier:*)']) {
    assert.equal(isBroad(rule), false, rule)
  }
})

/* ------------------------------------------------------------------ the rows of Permissions › Projects */

test('project rules: the rules of a settings file, list by list; a file that is not a JSON object is unreadable', () => {
  const text = JSON.stringify({ model: 'opus', permissions: { defaultMode: 'default', allow: ['Bash(npm test)', 7, ''], ask: ['Bash(git push:*)'], deny: ['Read(./.env)'], additionalDirectories: ['~/notes'] } })
  assert.deepEqual(rulesIn(text), [
    { list: 'allow', rule: 'Bash(npm test)' },
    { list: 'ask', rule: 'Bash(git push:*)' },
    { list: 'deny', rule: 'Read(./.env)' }
  ])
  assert.deepEqual(rulesIn('{"model":"opus"}'), [])
  assert.deepEqual(rulesIn('{"permissions":{"allow":"Bash"}}'), [])
  assert.equal(rulesIn('{ "permissions": broken'), null)
  assert.equal(rulesIn('[]'), null)
})

const read = (projectPath: string, rules: string[], over: Partial<RuleFileRead> = {}): RuleFileRead => ({ projectPath, file: 'settings.local.json', mtimeMs: 1_800_000_000_000, git: null, rules: rules.map((rule) => ({ list: 'allow', rule })), ...over })

test('project rules: flagged first, then by project, then by rule, with the counts the filters show', () => {
  const secret = `Bash(API_TOKEN=${GH} npm run sync)`
  const t = buildRows([read('/work/web', ['Bash(python3:*)', 'Bash(npm test)']), read('/work/shop-api', ['Bash(npm test)', secret, 'Bash(node:*)'], { git: 'ignored' })], new Set(), 1)
  assert.deepEqual(t.rules.map((r) => `${r.projectName} ${r.text}`), [`shop-api Bash(API_TOKEN=ghp_${MASK} npm run sync)`, 'shop-api Bash(node:*)', 'shop-api Bash(npm test)', 'web Bash(npm test)', 'web Bash(python3:*)'])
  assert.deepEqual([t.toCheck, t.broad, t.total, t.unreadable], [1, 2, 5, 1])
  assert.equal(t.rules[0].git, 'ignored')
  // nothing a row carries holds the secret
  assert.equal(JSON.stringify(t).includes(GH), false)
  // the same rule saved twice in one list is one row
  assert.equal(buildRows([read('/work/web', ['Bash(npm test)', 'Bash(npm test)'])], new Set()).total, 1)
  assert.equal(projectName('C:\\work\\shop-api'), 'shop-api')
})

test('project rules: "Not a secret" is remembered for that exact rule, in that file and list', () => {
  const secret = 'Bash(PGPASSWORD=correct-horse-fake psql -h db:*)'
  const files = [read('/work/shop-api', [secret]), read('/work/web', [secret])]
  const id = ruleId('/work/shop-api', 'settings.local.json', 'allow', secret)
  const t = buildRows(files, new Set([id]))
  assert.deepEqual(t.rules.map((r) => [r.projectName, r.secret, r.dismissed]), [
    ['web', true, false],
    ['shop-api', true, true]
  ])
  assert.equal(t.toCheck, 1)
  // the id says nothing about the rule, and another list or file is another rule
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.notEqual(id, ruleId('/work/shop-api', 'settings.local.json', 'ask', secret))
  assert.notEqual(id, ruleId('/work/shop-api', 'settings.json', 'allow', secret))
  // a rule that holds no secret is never "dismissed"
  assert.equal(buildRows([read('/work/web', ['Bash(npm test)'])], new Set([ruleId('/work/web', 'settings.local.json', 'allow', 'Bash(npm test)')])).rules[0].dismissed, false)
})

/* ------------------------------------------------------------------ what git says about a rule file */

test('git line: tracked wins, then ignored or not; anything git could not say is "in a git repository"', () => {
  assert.equal(gitStateOf(true, 0, null), 'tracked')
  // ignored by a pattern but already committed: still tracked
  assert.equal(gitStateOf(true, 0, 0), 'tracked')
  assert.equal(gitStateOf(true, 1, 0), 'ignored')
  assert.equal(gitStateOf(true, 1, 1), 'not-ignored')
  // git missing or timed out (null), not a repository it accepts (128)
  assert.equal(gitStateOf(true, null, null), 'repo')
  assert.equal(gitStateOf(true, 128, null), 'repo')
  assert.equal(gitStateOf(true, 1, 128), 'repo')
  assert.equal(gitStateOf(true, 1, null), 'repo')
  // no .git above the file: nothing to say, and git is not run
  assert.equal(gitStateOf(false, 0, 0), null)
})

test('git line: only two commands, both read-only, with the fsmonitor hook off', () => {
  assert.deepEqual(gitArgs('/work/shop-api', 'tracked', '.claude/settings.local.json'), ['-C', '/work/shop-api', '-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', '.claude/settings.local.json'])
  assert.deepEqual(gitArgs('/work/shop-api', 'ignored', '.claude/settings.local.json'), ['-C', '/work/shop-api', '-c', 'core.fsmonitor=false', 'check-ignore', '-q', '--', '.claude/settings.local.json'])
})

/* ------------------------------------------------------------------ taking one rule out of a rule file */

const FILE = `{
  "model": "opus",
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "Bash(npm test)",
      "Bash(TOKEN=fake-token-value npm run sync)",
      "Bash(git status)"
    ],
    "ask": ["Bash(git push:*)", "Bash(npm test)"],
    "deny": [
      "Read(./.env)"
    ]
  },
  "env": { "A": "Bash(npm test)" }
}
`

test('remove a rule: only that item goes; every other byte stays', () => {
  // from the middle, the start and the end of a list written one item a line
  assert.equal(removeRuleFromText(FILE, 'allow', 'Bash(TOKEN=fake-token-value npm run sync)'), FILE.replace('      "Bash(TOKEN=fake-token-value npm run sync)",\n', ''))
  assert.equal(removeRuleFromText(FILE, 'allow', 'Bash(npm test)'), FILE.replace('      "Bash(npm test)",\n', ''))
  assert.equal(removeRuleFromText(FILE, 'allow', 'Bash(git status)'), FILE.replace(',\n      "Bash(git status)"', ''))
  // a list on one line; the same text in another list and in another key is left alone
  assert.equal(removeRuleFromText(FILE, 'ask', 'Bash(npm test)'), FILE.replace('["Bash(git push:*)", "Bash(npm test)"]', '["Bash(git push:*)"]'))
  assert.equal(removeRuleFromText(FILE, 'ask', 'Bash(git push:*)'), FILE.replace('["Bash(git push:*)", "Bash(npm test)"]', '["Bash(npm test)"]'))
  // the only rule of a list: the list stays, empty
  assert.equal(removeRuleFromText(FILE, 'deny', 'Read(./.env)'), FILE.replace('[\n      "Read(./.env)"\n    ]', '[]'))
})

test('remove a rule: tabs, Windows line ends, no trailing newline and escaped text survive', () => {
  const tabs = '{\r\n\t"permissions": {\r\n\t\t"allow": [\r\n\t\t\t"Bash(echo \\"a, b\\")",\r\n\t\t\t"Bash(npm test)"\r\n\t\t]\r\n\t}\r\n}'
  assert.equal(removeRuleFromText(tabs, 'allow', 'Bash(echo "a, b")'), tabs.replace('\t\t\t"Bash(echo \\"a, b\\")",\r\n', ''))
  assert.equal(removeRuleFromText(tabs, 'allow', 'Bash(npm test)'), tabs.replace(',\r\n\t\t\t"Bash(npm test)"', ''))
  // a rule that itself looks like JSON punctuation
  const odd = '{"permissions":{"allow":["Bash(a],[b)","Bash(c)"]}}'
  assert.equal(removeRuleFromText(odd, 'allow', 'Bash(a],[b)'), '{"permissions":{"allow":["Bash(c)"]}}')
})

test('remove a rule: a rule saved twice loses its first copy; a missing rule, list or readable file changes nothing', () => {
  const twice = '{\n  "permissions": {\n    "allow": [\n      "Bash(a)",\n      "Bash(b)",\n      "Bash(a)"\n    ]\n  }\n}\n'
  assert.equal(removeRuleFromText(twice, 'allow', 'Bash(a)'), '{\n  "permissions": {\n    "allow": [\n      "Bash(b)",\n      "Bash(a)"\n    ]\n  }\n}\n')
  assert.equal(removeRuleFromText(FILE, 'allow', 'Bash(rm -rf:*)'), null)
  assert.equal(removeRuleFromText(FILE, 'deny', 'Bash(npm test)'), null)
  assert.equal(removeRuleFromText('{"model":"opus"}', 'allow', 'Bash(a)'), null)
  assert.equal(removeRuleFromText('{"permissions":{"allow":"Bash(a)"}}', 'allow', 'Bash(a)'), null)
  assert.equal(removeRuleFromText('{ "permissions": { "allow": ["Bash(a)"', 'allow', 'Bash(a)'), null)
  // the same list name elsewhere in the file is not the permissions list
  assert.equal(removeRuleFromText('{"other":{"allow":["Bash(a)"]},"permissions":{"allow":["Bash(b)"]}}', 'allow', 'Bash(a)'), null)
})

test('a rule file shown in Backups has its secrets covered, in JSON and in text that is not', () => {
  const shown = maskRuleFile(FILE)
  assert.equal(shown.includes('fake-token-value'), false)
  assert.equal(shown, FILE.replace('fake-token-value', MASK).replace('["Bash(git push:*)", "Bash(npm test)"]', '[\n      "Bash(git push:*)",\n      "Bash(npm test)"\n    ]').replace('{ "A": "Bash(npm test)" }', '{\n    "A": "Bash(npm test)"\n  }'))
  const quoted = JSON.stringify({ permissions: { allow: ['Bash(mysql --password="fake pass words" shop)'] } })
  assert.equal(maskRuleFile(quoted).includes('fake pass words'), false)
  assert.equal(maskRuleFile(`{ broken "Bash(API_TOKEN=${GH} npm run sync)"`).includes(GH), false)
})
