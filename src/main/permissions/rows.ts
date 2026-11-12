import crypto from 'node:crypto'
import type { GitState, ProjectRule, ProjectRuleList, ProjectRules, RuleFile } from '@shared/api/permissions'
import { classifyRule } from './classify.ts'

/**
 * The rows of Permissions › Projects: every permission rule saved in a project's `.claude/settings.json` and
 * `settings.local.json`, as it may be shown (a secret covered) and what it is. Pure, so `npm test` loads it as is;
 * src/main/domains/permissions.ts reads the files.
 */

export const RULE_FILES: readonly RuleFile[] = ['settings.json', 'settings.local.json']
export const RULE_LISTS: readonly ProjectRuleList[] = ['allow', 'ask', 'deny']

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One rule as the file holds it: the text never leaves the main process. */
export interface SavedRule {
  list: ProjectRuleList
  rule: string
}

/** The rules in a settings file's text, in order; null when the text is not a JSON object. */
export function rulesIn(text: string): SavedRule[] | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObj(o)) return null
  const p = o.permissions
  if (!isObj(p)) return []
  const out: SavedRule[] = []
  for (const list of RULE_LISTS) {
    const arr = p[list]
    if (Array.isArray(arr)) for (const rule of arr) if (typeof rule === 'string' && rule) out.push({ list, rule })
  }
  return out
}

/** A rule's id: a hash of where it is and what it says, so "Not a secret" can remember it without keeping its text. */
export function ruleId(projectPath: string, file: RuleFile, list: ProjectRuleList, rule: string): string {
  return crypto.createHash('sha256').update([projectPath, file, list, rule].join('\0')).digest('hex').slice(0, 32)
}

/** Last folder name of a project's path. */
export function projectName(projectPath: string): string {
  return projectPath.split(/[\\/]+/).filter(Boolean).pop() ?? projectPath
}

/** One rule file that was read. */
export interface RuleFileRead {
  projectPath: string
  file: RuleFile
  mtimeMs: number
  git: GitState
  rules: SavedRule[]
}

/** A row that is flagged: it holds a secret and was not marked "Not a secret". */
export const flagged = (r: Pick<ProjectRule, 'secret' | 'dismissed'>): boolean => r.secret && !r.dismissed

/**
 * The table: flagged rows first, then by project, then by rule, with the counts the filters, the sidebar and Today's
 * chip show. A rule saved twice in one list is one row (its id is the same).
 */
export function buildRows(files: readonly RuleFileRead[], dismissed: ReadonlySet<string>, unreadable = 0): ProjectRules {
  const byId = new Map<string, ProjectRule>()
  for (const f of files) {
    for (const { list, rule } of f.rules) {
      const id = ruleId(f.projectPath, f.file, list, rule)
      if (byId.has(id)) continue
      const c = classifyRule(rule)
      byId.set(id, { id, projectName: projectName(f.projectPath), projectPath: f.projectPath, file: f.file, list, text: c.text, secret: c.secret, secretSpans: c.secretSpans, broad: c.broad, fileMtimeMs: f.mtimeMs, git: f.git, dismissed: c.secret && dismissed.has(id) })
    }
  }
  const rules = [...byId.values()].sort(
    (a, b) => Number(flagged(b)) - Number(flagged(a)) || a.projectName.localeCompare(b.projectName) || a.projectPath.localeCompare(b.projectPath) || a.text.localeCompare(b.text) || a.id.localeCompare(b.id)
  )
  return { rules, toCheck: rules.filter(flagged).length, broad: rules.filter((r) => r.broad).length, total: rules.length, unreadable }
}
