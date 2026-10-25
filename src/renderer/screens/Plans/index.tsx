import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardList } from 'lucide-react'
import { formatCount, formatRelative } from '@shared/format'
import { ConfirmDialog, EmptyState, ListDetailLayout, ListPane, ListRow } from '@/components'
import { api, useApi } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import type { ScreenProps } from '@/lib/nav'
import { PlanDetail } from './PlanDetail'
import './plans.css'

export default function PlansScreen({ selectId }: ScreenProps): JSX.Element {
  const [selected, setSelected] = useSelectId(selectId)
  const [query, setQuery] = useState('')
  const list = useApi(() => api.plans.list(), [])
  const dirty = useRef(false)
  const [pending, setPending] = useState<string | undefined | null>(null)
  const onDirtyChange = useCallback((d: boolean) => {
    dirty.current = d
  }, [])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = list.data ?? []
    return q ? all.filter((p) => `${p.title} ${p.file} ${p.excerpt}`.toLowerCase().includes(q)) : all
  }, [list.data, query])
  const current = list.data?.find((p) => p.rel === selected)

  // open the first plan only when nothing was asked for: an unknown id keeps showing "not found"
  useEffect(() => {
    if (list.loading || !list.data || rows.length === 0) return
    if (!selected) setSelected(rows[0].rel)
  }, [selected, rows, list.loading, list.data, setSelected])

  function choose(rel: string): void {
    if (rel === selected) return
    if (dirty.current) setPending(rel)
    else setSelected(rel)
  }

  return (
    <>
      <ListDetailLayout
        list={
          <ListPane
            title="Plans"
            count={list.data ? formatCount(list.data.length) : undefined}
            search={{ value: query, onChange: setQuery, placeholder: 'Search plans' }}
            loading={list.loading && !list.data}
            error={list.error}
            isEmpty={rows.length === 0}
            empty={
              <EmptyState
                icon={<ClipboardList />}
                title={query ? 'No match' : 'No plans yet'}
                description={query ? 'Try another word.' : 'Claude Code saves a plan here each time it finishes planning in plan mode.'}
              />
            }
          >
            {rows.map((p) => (
              <ListRow
                key={p.rel}
                title={p.title}
                subtitle={p.excerpt || p.file}
                meta={formatRelative(p.mtimeMs)}
                selected={p.rel === selected}
                onSelect={() => choose(p.rel)}
              />
            ))}
          </ListPane>
        }
        detail={
          current ? (
            <PlanDetail
              key={current.rel}
              plan={current}
              onDirtyChange={onDirtyChange}
              onSaved={list.reload}
              onTrashed={() => {
                setSelected(undefined)
                list.reload()
              }}
            />
          ) : (
            <EmptyState
              icon={<ClipboardList />}
              title={selected && list.data ? 'Plan not found' : 'Select a plan'}
              description={selected && list.data ? 'It may have been moved to the Trash.' : 'Pick a plan to read it.'}
            />
          )
        }
      />
      <ConfirmDialog
        open={pending !== null}
        title="Discard unsaved changes?"
        description="You edited this plan and did not save. Switching now drops those edits."
        confirmLabel="Discard changes"
        tone="danger"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          dirty.current = false
          setSelected(pending ?? undefined)
          setPending(null)
        }}
      />
    </>
  )
}
