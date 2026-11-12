import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { GitState } from '@shared/api/permissions'

/**
 * What git says about a rule file, for the sheet's git line: the only place Claudock runs git, and only these two
 * commands, which read and never write:
 *   git ls-files --error-unmatch -- <file>   is the file tracked (0 yes, 1 no)
 *   git check-ignore -q -- <file>            is it ignored (0 yes, 1 no)
 * Run with a fixed argument list (no shell), in the project (`-C`), with the fsmonitor hook off (a repo's config could
 * name a program there), no optional locks, no prompt and a 2 s limit. Git missing, failing or refusing the folder
 * leaves "in a git repository" when a `.git` entry sits above the file, else nothing. Team mode never runs git.
 */

/** A command's exit code; null when git is missing, timed out or was killed. */
export type GitExit = number | null

const TIMEOUT_MS = 2000

/**
 * The state from the two answers. Tracked wins: a file that is ignored but was already committed is still on its way
 * to the remote. Any answer git could not give falls back to whether a repository is there at all.
 */
export function gitStateOf(inRepo: boolean, tracked: GitExit, ignored: GitExit): GitState {
  if (!inRepo) return null
  if (tracked === 0) return 'tracked'
  if (tracked === 1 && ignored === 0) return 'ignored'
  if (tracked === 1 && ignored === 1) return 'not-ignored'
  return 'repo'
}

/** The arguments of one of the two commands: nothing else is ever passed to git. */
export function gitArgs(project: string, what: 'tracked' | 'ignored', rel: string): string[] {
  const base = ['-C', project, '-c', 'core.fsmonitor=false']
  return what === 'tracked' ? [...base, 'ls-files', '--error-unmatch', '--', rel] : [...base, 'check-ignore', '-q', '--', rel]
}

function run(args: string[]): Promise<GitExit> {
  return new Promise((resolve) => {
    execFile('git', args, { timeout: TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (err) => {
      if (!err) return resolve(0)
      const code = (err as NodeJS.ErrnoException & { code?: unknown }).code
      resolve(typeof code === 'number' ? code : null)
    })
  })
}

/** A `.git` entry (a folder, or a worktree's file) in the project folder or a folder above it. */
export async function repoAbove(project: string): Promise<boolean> {
  for (let dir = path.resolve(project); ; dir = path.dirname(dir)) {
    if (await fsp.lstat(path.join(dir, '.git')).then(() => true, () => false)) return true
    if (path.dirname(dir) === dir) return false
  }
}

/** The git state of `<project>/<rel>` (`rel` with forward slashes). Never throws. */
export async function gitState(project: string, rel: string): Promise<GitState> {
  if (!(await repoAbove(project))) return null
  const tracked = await run(gitArgs(project, 'tracked', rel))
  // tracked settles it; otherwise ask whether it is ignored
  const ignored = tracked === 1 ? await run(gitArgs(project, 'ignored', rel)) : null
  return gitStateOf(true, tracked, ignored)
}
