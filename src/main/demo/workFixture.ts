import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** The file that tells a development build it may write in a synthetic folder (FIXTURE_MARK in src/main/paths.ts). */
const MARK = '.claudock-fixture'

/**
 * A second, smaller SYNTHETIC config folder: a work account beside the main fixture, for profiles (item 42).
 * `npm run fixture` builds it in ./.fixture/claude-work and `--demo` beside its own fixture, where Add profile finds it.
 * Its own settings, CLAUDE.md, two skills, an MCP server and a week of sessions on two work projects, a few of them
 * today. Plain Node only, like buildFixture. `dir` must be missing or empty.
 */
export function buildWorkFixture(dir: string): void {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`fixture: ${dir} is not empty`)
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const DAY = 86_400_000
  const HOUR = 3_600_000

  let seed = 20261028
  function rnd(): number {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1))
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]
  const hex = (n: number): string => crypto.randomBytes(n).toString('hex')

  function w(rel: string, content: string, mtime?: number): void {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    if (mtime) fs.utimesSync(p, new Date(mtime), new Date(mtime))
  }
  const json = (o: unknown): string => JSON.stringify(o, null, 2) + '\n'

  w(MARK, '')
  // never read: Claudock shows it as a locked row
  w('.credentials.json', 'FAKE-DO-NOT-READ')
  w(
    'settings.json',
    json({
      model: 'sonnet',
      permissions: {
        allow: ['Bash(pnpm test:*)', 'Bash(pnpm lint)', 'Bash(git status)', 'Read(~/work/**)'],
        deny: ['Read(./.env)', 'Bash(terraform apply:*)'],
        defaultMode: 'default'
      },
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0' }
    })
  )
  w('CLAUDE.md', '# Work account (fixture)\n\n- Follow the team style guide in docs/STYLE.md.\n- Open a draft PR before asking for review.\n- Never run migrations against production.\n')
  w('skills/pr-review/SKILL.md', '---\nname: pr-review\ndescription: Review a pull request against the team checklist\n---\n\nRead the diff, then check tests, naming and the changelog entry.\n')
  w('skills/oncall-handoff/SKILL.md', '---\nname: oncall-handoff\ndescription: Write the on-call handoff note from the last 24 hours of alerts\n---\n\nList open incidents first, then anything paged twice.\n')

  const projects = [
    { folder: '-Users-me-work-billing', cwd: '/Users/me/work/billing', sessions: 6 },
    { folder: '-Users-me-work-api-gateway', cwd: '/Users/me/work/api-gateway', sessions: 4 }
  ]
  const prompts = [
    'Add retries to the invoice export job',
    'Why does the rate limiter reject health checks?',
    'Write tests for the proration rules',
    'Move the webhook signing key to the secrets manager',
    'Find why p95 latency doubled after the last deploy',
    'Rename the legacy customer table columns'
  ]
  const history: { display: string; pastedContents: Record<string, never>; timestamp: number; project: string }[] = []
  let n = 0
  for (const p of projects) {
    for (let i = 0; i < p.sessions; i++, n++) {
      // the first three sessions are today (also just after midnight), the rest spread over the week
      const midnight = new Date(now).setHours(0, 0, 0, 0)
      const start = n < 3 ? Math.max(now - (n + 1) * 2 * HOUR, midnight + ((now - midnight) * (2 - n)) / 4) : now - int(1, 6) * DAY - int(0, 8) * HOUR
      const sessionId = crypto.randomUUID()
      const first = pick(prompts)
      const lines: string[] = []
      let t = start
      let parent: string | null = null
      const line = (type: string, message: unknown, extra: Record<string, unknown> = {}): void => {
        const uuid = crypto.randomUUID()
        lines.push(JSON.stringify({ parentUuid: parent, isSidechain: false, type, message, uuid, timestamp: new Date(t).toISOString(), cwd: p.cwd, sessionId, version: '2.1.0', gitBranch: 'main', userType: 'external', ...extra }))
        parent = uuid
        t += int(5, 120) * 1000
      }
      for (let turn = 0; turn < int(3, 7); turn++) {
        const prompt = turn === 0 ? first : pick(prompts)
        line('user', { role: 'user', content: prompt })
        if (turn === 0) history.push({ display: prompt, pastedContents: {}, timestamp: t, project: p.cwd })
        line(
          'assistant',
          {
            model: 'claude-sonnet-4',
            id: `msg_${hex(10)}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Done. The change is in place and the tests pass.' }],
            usage: { input_tokens: int(500, 4000), output_tokens: int(200, 1500), cache_creation_input_tokens: int(2000, 9000), cache_read_input_tokens: int(20_000, 90_000) }
          },
          { requestId: `req_${hex(8)}` }
        )
      }
      if (n % 2 === 0) lines.splice(1, 0, JSON.stringify({ type: 'custom-title', customTitle: first, sessionId }))
      w(`projects/${p.folder}/${sessionId}.jsonl`, lines.join('\n') + '\n', t)
    }
  }
  history.sort((a, b) => a.timestamp - b.timestamp)
  w('history.jsonl', history.map((h) => JSON.stringify(h)).join('\n') + '\n')
  w(
    '.claude.json',
    json({
      numStartups: 42,
      mcpServers: { 'team-tracker': { type: 'http', url: 'https://tracker.example.com/mcp' } },
      projects: Object.fromEntries(projects.map((p) => [p.cwd, { allowedTools: [], hasTrustDialogAccepted: true }]))
    })
  )
}
