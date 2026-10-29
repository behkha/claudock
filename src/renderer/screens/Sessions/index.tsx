import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MessagesSquare, MoreHorizontal } from 'lucide-react'
import type { ArchiveList, ArchiveStatus, ArchivedSession, SearchHit } from '@shared/api/archive'
import { formatBytes, formatCount, formatDate, formatRelative } from '@shared/format'
import { Badge, Chip, ConfirmDialog, EmptyState, IconButton, ListDetailLayout, ListPane, ListRow, Toggle, useToast } from '@/components'
import { api, useEvent } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import type { ScreenProps } from '@/lib/nav'
import { SessionDetail } from './SessionDetail'
import './sessions.css'

type Filter = 'all' | 'archived'

/** selectId = `<key>` or `<key>@<byte offset>` (a search hit); keys never hold an '@'. */
function split(sel: string | undefined): [string | undefined, number | undefined] {
  if (!sel) return [undefined, undefined]
  const i = sel.lastIndexOf('@')
  if (i < 0) return [sel, undefined]
  const n = Number(sel.slice(i + 1))
  return [sel.slice(0, i), Number.isFinite(n) ? n : undefined]
}

/** The folder a session ran in, by name (else the project folder Claude Code made for it). */
export function projectName(s: ArchivedSession): string {
  if (s.cwd) return s.cwd.split(/[\\/]+/).filter(Boolean).pop() ?? s.cwd
  return s.projectId.replace(/^-+/, '') || '/'
}

const lastMs = (s: ArchivedSession): number => s.endMs ?? s.mtimeMs

function statusLine(s: ArchiveStatus): string {
  if (s.indexing) return `Reading sessions · ${formatCount(s.indexing.done)} of ${formatCount(s.indexing.total)}`
  const kept = (s.archived > 0 ? ` · ${formatCount(s.archived)} archived` : '') + (s.bytes > 0 ? ` · ${formatBytes(s.bytes)}` : '')
  if (s.readOnly) return `Archive off in development${kept}`
  return `${s.on ? 'Archive on' : 'Archive off'}${kept}`
}

/** The search hit's text with the matched words marked. */
function Snippet({ hit }: { hit: SearchHit }): JSX.Element {
  const parts: JSX.Element[] = []
  let at = 0
  hit.marks.forEach(([a, b], i) => {
    if (a > at) parts.push(<span key={`t${i}`}>{hit.snippet.slice(at, a)}</span>)
    parts.push(<mark key={`m${i}`}>{hit.snippet.slice(a, b)}</mark>)
    at = b
  })
  if (at < hit.snippet.length) parts.push(<span key="end">{hit.snippet.slice(at)}</span>)
  return <span className="ses-snippet">{parts}</span>
}

export default function SessionsScreen({ selectId }: ScreenProps): JSX.Element {
  const toast = useToast()
  const [selected, setSelected] = useSelectId(selectId)
  const [key, focus] = split(selected)
  const [data, setData] = useState<ArchiveList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [menu, setMenu] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [trashArchived, setTrashArchived] = useState(false)
  const [busy, setBusy] = useState(false)
  const menuRoot = useRef<HTMLDivElement>(null)

  const load = useCallback(
    () =>
      api.archive.list().then(
        (d) => {
          setData(d)
          setError(null)
        },
        (e: Error) => setError(e.message)
      ),
    []
  )
  useEffect(() => {
    void load()
  }, [load])

  // new sessions, ones Claude Code deleted, or more read for search: reload, at most twice a second
  const pending = useRef<number | undefined>(undefined)
  useEvent('archive:changed', () => {
    if (pending.current !== undefined) return
    pending.current = window.setTimeout(() => {
      pending.current = undefined
      void load()
    }, 500)
  })
  useEffect(() => () => window.clearTimeout(pending.current), [])

  // full-text search once typing pauses
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    let live = true
    const t = window.setTimeout(() => {
      api.archive.search(q).then(
        (h) => {
          if (!live) return
          setHits(h)
          setSearching(false)
        },
        (e: Error) => {
          if (!live) return
          setSearching(false)
          toast(e.message, { kind: 'error' })
        }
      )
    }, 250)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [query, toast])

  const byKey = useMemo(() => new Map((data?.sessions ?? []).map((s) => [s.key, s])), [data])
  const rows = useMemo(() => {
    const list: Array<{ s: ArchivedSession; hit?: SearchHit }> = hits
      ? hits.flatMap((h) => {
          const s = byKey.get(h.key)
          return s ? [{ s, hit: h }] : []
        })
      : (data?.sessions ?? []).map((s) => ({ s }))
    return filter === 'archived' ? list.filter((r) => r.s.archived) : list
  }, [data, hits, byKey, filter])

  // open the newest session when nothing was asked for: an unknown key keeps showing "not found"
  useEffect(() => {
    if (!data || selected || rows.length === 0 || hits) return
    setSelected(rows[0].s.key)
  }, [data, selected, rows, hits, setSelected])

  // the menu closes on a click elsewhere or Escape
  useEffect(() => {
    if (!menu) return
    const down = (e: MouseEvent): void => {
      if (!menuRoot.current?.contains(e.target as Node)) setMenu(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false)
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [menu])

  const status = data?.status
  const current = key ? byKey.get(key) : undefined
  const archivedCount = status?.archived ?? 0

  async function turn(on: boolean, trashToo = false): Promise<void> {
    setBusy(true)
    try {
      await api.archive.setOn(on, trashToo)
      toast(on ? 'Archiving this profile' : 'Stopped archiving this profile', { kind: 'success' })
      setStopping(false)
      await load()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const select = (s: ArchivedSession, hit?: SearchHit): void => setSelected(hit && hit.offset >= 0 ? `${s.key}@${hit.offset}` : s.key)

  return (
    <>
      <ListDetailLayout
        className="ses"
        list={
          <ListPane
            title="Sessions"
            count={hits ? formatCount(rows.length) : data ? formatCount(data.sessions.length) : undefined}
            search={{ value: query, onChange: setQuery, placeholder: 'Search every session' }}
            filters={
              <div className="ses-filters" role="group" aria-label="Show">
                <Chip selected={filter === 'all'} onClick={() => setFilter('all')}>
                  All
                </Chip>
                <Chip selected={filter === 'archived'} onClick={() => setFilter('archived')} disabled={archivedCount === 0 && filter !== 'archived'}>
                  Archived{archivedCount > 0 ? ` ${formatCount(archivedCount)}` : ''}
                </Chip>
              </div>
            }
            loading={(!data && !error) || searching}
            error={error}
            isEmpty={rows.length === 0}
            empty={
              <EmptyState
                icon={<MessagesSquare />}
                title={hits ? 'No match' : filter === 'archived' ? 'Nothing archived yet' : 'No sessions yet'}
                description={hits ? 'Try other words.' : undefined}
              />
            }
            windowed={hits ? undefined : { rowHeight: 54 }}
            footer={
              status ? (
                <div className="ses-status" ref={menuRoot}>
                  <span className="ses-status__text">{statusLine(status)}</span>
                  <IconButton aria-label="Archive" icon={<MoreHorizontal size={16} />} size="sm" onClick={() => setMenu((v) => !v)} aria-expanded={menu} aria-haspopup="menu" />
                  {menu ? (
                    <div className="ses-menu" role="menu" aria-label="Archive">
                      <button
                        type="button"
                        role="menuitem"
                        className="ses-menu__item"
                        onClick={() => {
                          setMenu(false)
                          api.archive.reveal().catch((e: Error) => toast(e.message, { kind: 'error' }))
                        }}
                      >
                        Show archive folder
                      </button>
                      {status.readOnly ? null : status.on ? (
                        <button
                          type="button"
                          role="menuitem"
                          className="ses-menu__item"
                          onClick={() => {
                            setMenu(false)
                            setTrashArchived(false)
                            setStopping(true)
                          }}
                        >
                          Stop archiving this profile…
                        </button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          className="ses-menu__item"
                          onClick={() => {
                            setMenu(false)
                            void turn(true)
                          }}
                        >
                          Archive this profile
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : undefined
            }
          >
            {data && !(searching && !hits) ? rows.map(({ s, hit }) => (
              <ListRow
                key={s.key}
                title={s.title || (s.pending ? 'Reading…' : 'Untitled session')}
                subtitle={
                  hit ? (
                    <Snippet hit={hit} />
                  ) : (
                    <>
                      {s.archived ? (
                        <span className="ses-badge">
                          <Badge tone="oat">Archived</Badge>
                        </span>
                      ) : null}
                      {projectName(s)} · {formatRelative(lastMs(s))}
                    </>
                  )
                }
                meta={hit ? formatDate(lastMs(s)) : formatBytes(s.bytes)}
                dimmed={s.pending}
                selected={s.key === key}
                onSelect={() => select(s, hit)}
              />
            )) : null}
          </ListPane>
        }
        detail={
          current ? (
            <SessionDetail
              key={current.key}
              session={current}
              focusOffset={focus}
              onChanged={() => void load()}
              onTrashed={() => {
                // gone from the list first, so the newest session left is the one that opens
                const gone = current.key
                setData((d) => d && { ...d, sessions: d.sessions.filter((x) => x.key !== gone) })
                setHits((h) => h && h.filter((x) => x.key !== gone))
                setSelected(undefined)
                void load()
              }}
            />
          ) : (
            <EmptyState
              icon={<MessagesSquare />}
              title={key && data ? 'Session not found' : 'Select a session'}
              description={key && data ? 'It may have been moved to the Trash.' : undefined}
            />
          )
        }
      />
      <ConfirmDialog
        open={stopping}
        title="Stop archiving this profile?"
        description={
          archivedCount > 0 ? (
            <Toggle
              checked={trashArchived}
              onChange={setTrashArchived}
              label={`Also move the ${formatCount(archivedCount)} archived ${archivedCount === 1 ? 'session' : 'sessions'} to the Trash`}
            />
          ) : undefined
        }
        confirmLabel="Stop archiving"
        tone={trashArchived ? 'danger' : 'default'}
        busy={busy}
        onConfirm={() => void turn(false, trashArchived)}
        onCancel={() => setStopping(false)}
      />
    </>
  )
}
