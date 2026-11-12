import { useEffect, useRef, type ReactNode } from 'react'
import type { GitState, ProjectRule } from '@shared/api/permissions'

const GIT_LINE: Record<Exclude<GitState, null>, string> = {
  tracked: 'tracked by git',
  ignored: 'ignored by git',
  'not-ignored': 'not ignored by git',
  repo: 'in a git repository'
}
export const gitLine = (g: GitState): string | null => (g ? GIT_LINE[g] : null)

/** A rule's text with its covered parts marked. A rule marked "Not a secret" keeps its cover and loses the mark. */
export function RuleText({ rule }: { rule: ProjectRule }): JSX.Element {
  if (rule.dismissed || rule.secretSpans.length === 0) return <>{rule.text}</>
  const parts: ReactNode[] = []
  let at = 0
  rule.secretSpans.forEach(([s, e], i) => {
    parts.push(rule.text.slice(at, s), <mark key={i}>{rule.text.slice(s, e)}</mark>)
    at = e
  })
  return (
    <>
      {parts}
      {rule.text.slice(at)}
    </>
  )
}

/** "9 Nov", with the year when it is not this one. */
function day(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * One saved rule: the rule (a secret covered), where it is saved, when its file last changed and what git says about
 * that file. A flagged rule also says that removing it does not change the secret.
 */
export function RuleSheet({ rule, onClose }: { rule: ProjectRule | null; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (rule && !d.open) d.showModal()
    if (!rule && d.open) d.close()
  }, [rule])
  const flagged = rule ? rule.secret && !rule.dismissed : false
  const git = rule ? gitLine(rule.git) : null
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="pm-sheet-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {rule ? (
        <div className="dialog__panel pm-sheet">
          <h2 id="pm-sheet-title" className="dialog__title">
            {flagged ? 'This rule holds a secret' : 'Saved rule'}
          </h2>
          <code className="pm-sheet__rule">
            <RuleText rule={rule} />
          </code>
          <div className="pm-sheet__meta">
            <span title={rule.projectPath}>
              {rule.projectName} · .claude/{rule.file}
            </span>
            <span>
              File changed {day(rule.fileMtimeMs)}
              {git ? ` · ${git}` : ''}
            </span>
          </div>
          {flagged ? <p className="pm-sheet__meta">Removing the rule does not change the secret. Change it where it was issued.</p> : null}
        </div>
      ) : null}
    </dialog>
  )
}
