import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Brain } from 'lucide-react'
import type { MemoryFileInfo } from '@shared/api/memory'
import { formatCount } from '@shared/format'
import { Badge, ConfirmDialog, EmptyState, ListDetailLayout, ListGroup, ListPane, ListRow } from '@/components'
import { api, useApi } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import type { ScreenProps } from '@/lib/nav'
import { MemoryDetail } from './MemoryDetail'
import './memory.css'

export default function MemoryScreen({ selectId }: ScreenProps): JSX.Element {
  const [selected, setSelected] = useSelectId(selectId)
  const [query, setQuery] = useState('')
  const list = useApi(() => api.memory.list(), [])
  const dirty = useRef(false)
  const [pending, setPending] = useState<string | undefined | null>(null)
  const onDirtyChange = useCallback((d: boolean) => {
    dirty.current = d
  }, [])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = list.data ?? []
    if (!q) return all
    return all
      .map((g) => ({
        ...g,
        files: g.files.filter((f) => `${f.title} ${f.description} ${f.file} ${g.projectName}`.toLowerCase().includes(q))
      }))
      .filter((g) => g.files.length > 0)
  }, [list.data, query])

  const flat = useMemo(() => groups.flatMap((g) => g.files.map((f) => ({ f, projectName: g.projectName }))), [groups])
  const total = useMemo(() => (list.data ?? []).reduce((n, g) => n + g.files.length, 0), [list.data])
  const current = useMemo(() => {
    const all = (list.data ?? []).flatMap((g) => g.files.map((f) => ({ f, projectName: g.projectName })))
    return all.find((x) => x.f.rel === selected)
  }, [list.data, selected])

  // open the first file only when nothing was asked for: an unknown id keeps showing "not found"
  useEffect(() => {
    if (list.loading || !list.data || flat.length === 0) return
    if (!selected) setSelected(flat.find((x) => !x.f.isIndex)?.f.rel ?? flat[0].f.rel)
  }, [selected, flat, list.loading, list.data, setSelected])

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
            title="Memory"
            count={list.data ? formatCount(total) : undefined}
            search={{ value: query, onChange: setQuery, placeholder: 'Search names and descriptions' }}
            loading={list.loading && !list.data}
            error={list.error}
            isEmpty={groups.length === 0}
            empty={
              <EmptyState
                icon={<Brain />}
                title={query ? 'No match' : 'No memory yet'}
                description={query ? 'Try another word.' : 'Claude saves notes here when you ask it to remember something. They live in each project’s memory folder.'}
              />
            }
          >
            {groups.map((g) => (
              <MemoryGroupRows key={g.projectId} name={g.projectName} files={g.files} selected={selected} onSelect={choose} />
            ))}
          </ListPane>
        }
        detail={
          current ? (
            <MemoryDetail
              key={current.f.rel}
              info={current.f}
              projectName={current.projectName}
              onDirtyChange={onDirtyChange}
              onSaved={list.reload}
              onTrashed={() => {
                setSelected(undefined)
                list.reload()
              }}
            />
          ) : (
            <EmptyState
              icon={<Brain />}
              title={selected && list.data ? 'Memory file not found' : 'Select a memory file'}
              description={selected && list.data ? 'It may have been moved to the Trash.' : 'Pick a file to read or edit it.'}
            />
          )
        }
      />
      <ConfirmDialog
        open={pending !== null}
        title="Discard unsaved changes?"
        description="You edited this file and did not save. Switching now drops those edits."
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

function MemoryGroupRows({
  name,
  files,
  selected,
  onSelect
}: {
  name: string
  files: MemoryFileInfo[]
  selected: string | undefined
  onSelect: (rel: string) => void
}): JSX.Element {
  return (
    <>
      <ListGroup>{name}</ListGroup>
      {files.map((f) => (
        <ListRow
          key={f.rel}
          title={f.title}
          subtitle={f.isIndex ? 'Index of this project’s memory' : f.description || f.file}
          meta={f.type && !f.isIndex ? <Badge>{f.type}</Badge> : undefined}
          selected={f.rel === selected}
          onSelect={() => onSelect(f.rel)}
        />
      ))}
    </>
  )
}
