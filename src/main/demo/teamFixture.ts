import fs from 'node:fs'
import path from 'node:path'

/** The file that tells a development build it may write in a synthetic folder (FIXTURE_MARK in src/main/paths.ts). */
const MARK = '.claudock-fixture'

/**
 * The folders Team mode writes outside the config folder, beside the fixture: `team-repo`, an empty git repo whose
 * `origin` is on GitHub (a hand-written `.git/config`; Claudock never runs git), and `acme-web`, a project with its own
 * `.claude/settings.json` to connect. Both carry the fixture mark, so a development build may write there. Plain Node,
 * like buildFixture. `base` is the folder holding the fixture (./.fixture, or --demo's data folder).
 */
export function buildTeamFixture(base: string, configDir = path.join(base, 'claude')): { team: string; project: string } {
  const team = path.join(base, 'team-repo')
  const project = path.join(base, 'acme-web')
  const w = (abs: string, text: string): void => {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  const git = (dir: string, url: string): void => {
    w(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    w(path.join(dir, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`)
    w(path.join(dir, MARK), '')
  }
  for (const d of [team, project]) if (fs.existsSync(d) && fs.readdirSync(d).length) throw new Error(`fixture: ${d} is not empty`)
  git(team, 'https://github.com/acme/claude-setup.git')
  git(project, 'git@github.com:acme/web.git')
  w(path.join(project, 'README.md'), '# acme web\n\nThe storefront.\n')
  w(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)', 'Bash(npm run lint)'] } }, null, 2) + '\n')
  // one session in the project, five days ago, so Claude Code knows it (and the Connect sheet lists it)
  const at = Date.now() - 5 * 86_400_000
  const sessionId = '7e1a2b3c-0000-4000-8000-00000000ac3e'
  const line = { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'Add the checkout page' }, uuid: '7e1a2b3c-0000-4000-8000-0000000000u1', timestamp: new Date(at).toISOString(), cwd: project, sessionId, version: '2.1.318', gitBranch: 'main', userType: 'external' }
  const file = path.join(configDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
  w(file, JSON.stringify(line) + '\n')
  fs.utimesSync(file, new Date(at), new Date(at))
  return { team, project }
}
