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
export function buildTeamFixture(base: string): { team: string; project: string } {
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
  return { team, project }
}
