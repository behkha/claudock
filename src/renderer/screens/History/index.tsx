import { useEffect, useMemo, useState } from 'react'
import { History as HistoryIcon } from 'lucide-react'
import { formatCount } from '@shared/format'
import { EmptyState, ListDetailLayout, SearchField, Select, Spinner } from '@/components'
import { api, useApi } from '@/lib/api'
import { useDebounced, useSelectId } from '@/lib/hooks'
import type { ScreenProps } from '@/lib/nav'
import { HistoryDetail } from './HistoryDetail'
import { HistoryList } from './HistoryList'
import './history.css'

const baseName = (p: string): string => p.split(/[\\/]+/).filter(Boolean).pop() ?? p

export default function HistoryScreen({ selectId }: ScreenProps): JSX.Element {
  const [sel, setSel] = useSelectId(selectId)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const dq = useDebounced(query, 200)
  const cfg = useApi(() => api.system.configInfo(), [])
  const { data, error, loading } = useApi(() => api.history.index(dq, project), [dq, project])

  const selected = sel !== undefined && /^\d+$/.test(sel) ? Number(sel) : undefined
  const rows = useMemo(() => data?.rows ?? [], [data?.rows])

  useEffect(() => {
    if (!data || loading) return
    if (rows.length > 0 && (selected === undefined || !rows.some((r) => r.id === selected))) {
      // keep a selection that is only hidden by the filter; otherwise open the newest entry
      if (selected === undefined) setSel(String(rows[0].id))
    }
  }, [data, loading, rows, selected, setSel])

  const projectOptions = useMemo(
    () => [
      { value: '', label: 'All projects' },
      ...(data?.projects ?? []).map((p) => ({ value: p.path, label: `${baseName(p.path)} (${formatCount(p.count)})` }))
    ],
    [data?.projects]
  )

  const filtered = !!dq.trim() || !!project

  return (
    <ListDetailLayout
      list={
        <section className="his-pane" aria-label="History">
          <header className="list-pane__header">
            <div className="list-pane__titlebar">
              <h2 className="list-pane__title">History</h2>
              {data ? <span className="list-pane__count">{formatCount(data.totalAll)}</span> : null}
              <span className="list-pane__spacer" />
              {loading && data ? <Spinner size={14} label="Searching" /> : null}
            </div>
            <SearchField value={query} onChange={setQuery} placeholder="Search prompts" />
            <div className="his-filter">
              <Select aria-label="Project" value={project} onChange={setProject} options={projectOptions} />
            </div>
          </header>
          {error ? (
            <p className="list-pane__error" role="alert">
              {error}
            </p>
          ) : null}
          {!data && loading ? (
            <div className="list-pane__loading">
              <Spinner />
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<HistoryIcon />}
              title={filtered ? 'No match' : 'No history yet'}
              description={filtered ? 'Try another word or choose all projects.' : 'Claude Code records every prompt you send in history.jsonl.'}
            />
          ) : (
            <HistoryList rows={rows} projects={data?.projects ?? []} selected={selected} onSelect={(id) => setSel(String(id))} />
          )}
          {data && rows.length > 0 ? (
            <footer className="list-pane__footer">{filtered ? `${formatCount(rows.length)} of ${formatCount(data.totalAll)} prompts` : `${formatCount(rows.length)} prompts`}</footer>
          ) : null}
        </section>
      }
      detail={
        selected !== undefined ? (
          <HistoryDetail key={selected} id={selected} home={cfg.data?.home ?? ''} />
        ) : (
          <EmptyState icon={<HistoryIcon />} title="Select a prompt" description="Pick an entry to read it in full." />
        )
      }
    />
  )
}
