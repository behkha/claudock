import { useEffect, useState, type ReactNode } from 'react'
import { Button, Chip, EmptyState, PageLayout, Spinner } from '@/components'
import { api, useApi } from '@/lib/api'
import { RuleSheet, RuleText } from './RuleSheet'

/**
 * Permissions › Projects: every permission rule saved in the projects Claude Code knows (`<project>/.claude/settings.json`
 * and `settings.local.json`), in one table. A rule that holds a secret is flagged and listed first, with the secret
 * covered (the main process covers it; the rule in full never reaches this window). Filters: To check (flagged),
 * Runs any script (a choice the user made, so no flag), All. A row opens the rule's sheet.
 */

export type RuleFilter = 'check' | 'broad' | 'all'

export function ProjectsView({ scope, start }: { scope: ReactNode; start?: RuleFilter }): JSX.Element {
  const { data, error, reload } = useApi(() => api.permissions.projectRules(), [])
  const [picked, setPicked] = useState<RuleFilter | null>(start ?? null)
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => {
    if (start) setPicked(start)
  }, [start])
  // rule files change outside Claudock (Claude Code saves a rule): read again when the window comes back
  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  if (error && !data) return <EmptyState title="Could not read the saved rules" description={error} action={<Button onClick={reload}>Try again</Button>} />

  // "To check" first when something is flagged, else everything
  const filter: RuleFilter = picked ?? (data && data.toCheck > 0 ? 'check' : 'all')
  const rows = data ? data.rules.filter((r) => (filter === 'check' ? r.secret && !r.dismissed : filter === 'broad' ? r.broad : true)) : []
  const open = data?.rules.find((r) => r.id === openId) ?? null

  return (
    <PageLayout
      title="Permissions"
      actions={scope}
      toolbar={
        data && data.total > 0 ? (
          <div className="pm-filters" role="group" aria-label="Filter rules">
            <Chip selected={filter === 'check'} count={data.toCheck} onClick={() => setPicked('check')}>
              To check
            </Chip>
            <Chip selected={filter === 'broad'} count={data.broad} onClick={() => setPicked('broad')}>
              Runs any script
            </Chip>
            <Chip selected={filter === 'all'} count={data.total} onClick={() => setPicked('all')}>
              All
            </Chip>
          </div>
        ) : undefined
      }
    >
      {!data ? (
        <div className="pm-center">
          <Spinner />
        </div>
      ) : data.total === 0 ? (
        <EmptyState title="No rules saved in your projects" />
      ) : rows.length === 0 ? (
        <EmptyState title={filter === 'check' ? 'Nothing to check' : 'No rule runs any script'} />
      ) : (
        <div className="pm-table-wrap">
          <table className="pm-table">
            <thead>
              <tr>
                <th className="pm-table__dot" />
                <th scope="col">Rule</th>
                <th scope="col">Project</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="pm-prow">
                  <td className="pm-table__dot">{r.secret && !r.dismissed ? <span className="pm-dot" role="img" aria-label="Holds a secret" /> : null}</td>
                  <td className="pm-table__rule">
                    <button type="button" className="pm-prow__open" onClick={() => setOpenId(r.id)}>
                      <code>
                        <RuleText rule={r} />
                      </code>
                    </button>
                  </td>
                  <td className="pm-table__project" title={r.projectPath}>
                    {r.projectName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.unreadable > 0 ? (
        <p className="pm-note">{data.unreadable === 1 ? '1 rule file could not be read.' : `${data.unreadable} rule files could not be read.`}</p>
      ) : null}
      <RuleSheet rule={open} onClose={() => setOpenId(null)} />
    </PageLayout>
  )
}
