import test from 'node:test'
import assert from 'node:assert/strict'
import { MASK, maskText, secretsInText } from '../../shared/secrets.ts'
import { classifyRule, isBroad } from './classify.ts'

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
