import { useEffect, useMemo, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { formatBytes, formatCount, formatRelative, tildify } from '@shared/format'
import { Badge, Chip, EmptyState, ListDetailLayout, ListPane, ListRow } from '@/components'
import { api, useApi } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import type { ScreenProps } from '@/lib/nav'
import { ProjectDetail } from './ProjectDetail'
import './projects.css'

type Sort = 'recent' | 'size' | 'name'

/** selectId = `<projectId>` or `<projectId>/<sessionId>` (folder names never contain a slash). */
function split(sel: string | undefined): [string | undefined, string | undefined] {
  if (!sel) return [undefined, undefined]
  const i = sel.indexOf('/')
  return i < 0 ? [sel, undefined] : [sel.slice(0, i), sel.slice(i + 1) || undefined]
}

export default function ProjectsScreen({ selectId }: ScreenProps): JSX.Element {
  const [selected, setSelected] = useSelectId(selectId)
  const [projectId, sessionId] = split(selected)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('recent')
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const list = useApi(() => api.projects.list(), [])
  const cfg = useApi(() => api.system.configInfo(), [])
  const home = cfg.data?.home ?? ''

  // full sizes (with sibling folders) arrive after the list
  useEffect(() => {
    if (!list.data) return
    let live = true
    api.projects.sizes().then(
      (s) => live && setSizes(s),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [list.data])

  const bytesOf = (id: string, fallback: number): number => sizes[id] ?? fallback

  const rows = useMemo(() => {
    const all = list.data ?? []
    const q = query.trim().toLowerCase()
    const hit = q ? all.filter((p) => p.name.toLowerCase().includes(q) || (p.path ?? '').toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) : all
    const arr = [...hit]
    if (sort === 'recent') arr.sort((a, b) => b.lastActiveMs - a.lastActiveMs)
    else if (sort === 'size') arr.sort((a, b) => (sizes[b.id] ?? b.bytes) - (sizes[a.id] ?? a.bytes))
    else arr.sort((a, b) => a.name.localeCompare(b.name))
    return arr
  }, [list.data, query, sort, sizes])

  // open the first project only when nothing was asked for: an unknown id keeps showing "not found"
  useEffect(() => {
    if (list.loading || !list.data || rows.length === 0) return
    if (!selected) setSelected(rows[0].id)
  }, [selected, rows, list.loading, list.data, setSelected])

  const current = list.data?.find((p) => p.id === projectId)

  return (
    <ListDetailLayout
      list={
        <ListPane
          title="Projects"
          count={list.data ? formatCount(list.data.length) : undefined}
          search={{ value: query, onChange: setQuery, placeholder: 'Search projects' }}
          filters={
            <div className="prj-sort" role="group" aria-label="Sort projects">
              <Chip selected={sort === 'recent'} onClick={() => setSort('recent')}>
                Last active
              </Chip>
              <Chip selected={sort === 'size'} onClick={() => setSort('size')}>
                Size
              </Chip>
              <Chip selected={sort === 'name'} onClick={() => setSort('name')}>
                Name
              </Chip>
            </div>
          }
          loading={list.loading && !list.data}
          error={list.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={<FolderOpen />}
              title={query ? 'No match' : 'No projects yet'}
              description={query ? 'Try another name or path.' : 'Claude Code adds a folder here for each directory you open it in.'}
            />
          }
        >
          {rows.map((p) => (
            <ListRow
              key={p.id}
              title={p.name}
              subtitle={
                <>
                  {p.missing ? (
                    <span className="prj-missing">
                      <Badge tone="danger">Folder missing</Badge>
                    </span>
                  ) : null}
                  {p.sessions} {p.sessions === 1 ? 'session' : 'sessions'} · {formatRelative(p.lastActiveMs)}
                </>
              }
              meta={formatBytes(bytesOf(p.id, p.bytes))}
              selected={p.id === projectId}
              onSelect={() => setSelected(p.id)}
            />
          ))}
        </ListPane>
      }
      detail={
        current ? (
          <ProjectDetail
            key={current.id}
            project={{ ...current, path: current.path ? tildify(current.path, home) : null }}
            bytes={bytesOf(current.id, current.bytes)}
            sessionId={sessionId}
            onOpenSession={(sid) => setSelected(sid ? `${current.id}/${sid}` : current.id)}
            onChanged={list.reload}
            onGone={() => {
              setSelected(undefined)
              list.reload()
            }}
          />
        ) : (
          <EmptyState
            icon={<FolderOpen />}
            title={projectId && list.data ? 'Project not found' : 'Select a project'}
            description={projectId && list.data ? 'It may have been moved to the Trash.' : 'Pick a project to see its sessions.'}
          />
        )
      }
    />
  )
}
