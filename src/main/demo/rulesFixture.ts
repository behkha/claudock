import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The file that tells a development build it may write in a synthetic folder (FIXTURE_MARK in src/main/paths.ts). */
const MARK = '.claudock-fixture'

/**
 * The projects the saved-rules check reads, beside the fixture: `shop-api` and `docs-site`, each a git repository with
 * permission rules saved in its `.claude` folder the way "don't ask again" saves them: ordinary rules, rules that run
 * any script, and rules holding a secret in each form the check knows. Every secret here is invented.
 *   - shop-api: `.claude/settings.local.json` is ignored by git (.gitignore);
 *   - docs-site: `.claude/settings.json` and `settings.local.json` are tracked (they are in the index).
 * The repositories are written by hand (HEAD, config, an index), since nothing here runs git. Their paths, and Team
 * mode's `acme-web` when it is there, are added to `projects` in the fixture's global state file, which is how Claude
 * Code knows a project. Both carry the fixture mark, so a development build may write there. Plain Node, like
 * buildFixture. `base` is the folder holding the fixture (./.fixture, or --demo's data folder).
 */
export function buildRulesFixture(base: string, configDir = path.join(base, 'claude')): { projects: string[] } {
  const w = (abs: string, text: string | Buffer): void => {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  const json = (o: unknown): string => JSON.stringify(o, null, 2) + '\n'

  /** An empty git repository, as `git init` leaves it, with `tracked` in its index (path -> content). */
  const repo = (dir: string, url: string, tracked: Record<string, string>): void => {
    w(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    w(path.join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`)
    fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true })
    const names = Object.keys(tracked).sort()
    if (names.length) w(path.join(dir, '.git', 'index'), gitIndex(names.map((name) => ({ name, content: tracked[name] }))))
    w(path.join(dir, MARK), '')
  }

  const shop = path.join(base, 'shop-api')
  const docs = path.join(base, 'docs-site')
  for (const d of [shop, docs]) if (fs.existsSync(d) && fs.readdirSync(d).length) throw new Error(`fixture: ${d} is not empty`)

  // shop-api: what a few weeks of "Yes, don't ask again" leave behind
  const shopLocal = json({
    permissions: {
      allow: [
        'Bash(npm run test:*)',
        'Bash(npm run lint)',
        'Bash(git status)',
        'Bash(git diff:*)',
        'Bash(API_TOKEN=ghp_FAKEfake0000DoNotUse0000fake0000 npm run sync)',
        'Bash(PGPASSWORD=fake-db-pass-do-not-use psql -h db.example.test:*)',
        'Bash(curl -d key=fake-key-0000-do-not-use https://api.example.test/v1/sync)',
        'Bash(curl -H "Authorization: Bearer fake0000bearer0000DoNotUse" https://api.example.test/v1/me)',
        'Bash(git clone https://deploy:fake-pass-do-not-use@git.example.test/shop/api.git)',
        'Bash(DEPLOY_TOKEN=$DEPLOY_TOKEN npm run deploy)',
        'Bash(python3:*)',
        'Bash(node:*)',
        'Bash(npx:*)',
        'Read(~/.zshrc)',
        'WebFetch(domain:docs.example.test)'
      ],
      ask: ['Bash(git push:*)'],
      deny: ['Read(./.env)']
    }
  })
  repo(shop, 'git@github.com:acme/shop-api.git', { 'README.md': '# shop-api\n', '.gitignore': 'node_modules\n.claude/settings.local.json\n' })
  w(path.join(shop, 'README.md'), '# shop-api\n')
  w(path.join(shop, '.gitignore'), 'node_modules\n.claude/settings.local.json\n')
  w(path.join(shop, '.claude', 'settings.local.json'), shopLocal)

  // docs-site: both rule files were committed, the local one by mistake
  const docsShared = json({ permissions: { allow: ['Bash(npm run docs:*)', 'Bash(npm run build)'] } })
  const docsLocal = json({ permissions: { allow: ['Bash(NETLIFY_AUTH_TOKEN=fake-netlify-token-0000 netlify deploy --prod)', 'Bash(sh:*)', 'Bash(npm run preview)'] } })
  repo(docs, 'git@github.com:acme/docs-site.git', { 'README.md': '# docs-site\n', '.claude/settings.json': docsShared, '.claude/settings.local.json': docsLocal })
  w(path.join(docs, 'README.md'), '# docs-site\n')
  w(path.join(docs, '.claude', 'settings.json'), docsShared)
  w(path.join(docs, '.claude', 'settings.local.json'), docsLocal)
  // saved three days ago
  const at = new Date(Date.now() - 3 * 86_400_000)
  for (const f of [path.join(shop, '.claude', 'settings.local.json'), path.join(docs, '.claude', 'settings.local.json')]) fs.utimesSync(f, at, at)

  // Claude Code knows a project once it ran there: a key under `projects` in the global state file
  const projects = [shop, docs, path.join(base, 'acme-web')].filter((p) => fs.existsSync(p))
  const stateFile = path.join(configDir, '.claude.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { projects?: Record<string, unknown> }
  state.projects = { ...(state.projects ?? {}), ...Object.fromEntries(projects.map((p) => [p, { allowedTools: [], mcpContextUris: [], mcpServers: {}, hasTrustDialogAccepted: true }])) }
  fs.writeFileSync(stateFile, json(state))
  return { projects }
}

/** A git index (version 2) listing `files`, which is all `git ls-files` reads to say a file is tracked. */
function gitIndex(files: { name: string; content: string }[]): Buffer {
  const head = Buffer.alloc(12)
  head.write('DIRC', 0, 'ascii')
  head.writeUInt32BE(2, 4)
  head.writeUInt32BE(files.length, 8)
  const entries = files.map(({ name, content }) => {
    const data = Buffer.from(content)
    const sha = crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest()
    const fixed = Buffer.alloc(62)
    // ctime, mtime, dev, ino stay 0 (git then compares content, which matches); a regular file, its size, its blob
    fixed.writeUInt32BE(0o100644, 24)
    fixed.writeUInt32BE(data.length, 36)
    sha.copy(fixed, 40)
    fixed.writeUInt16BE(Math.min(Buffer.byteLength(name), 0xfff), 60)
    const raw = Buffer.concat([fixed, Buffer.from(name)])
    // NUL-padded to a multiple of 8, with at least one NUL
    return Buffer.concat([raw, Buffer.alloc(8 - (raw.length % 8))])
  })
  const body = Buffer.concat([head, ...entries])
  return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()])
}
