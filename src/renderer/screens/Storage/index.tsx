import { useEffect, useMemo, useState } from 'react'
import { File as FileIcon, Folder, FolderOpen, Lock, RefreshCw, Trash2 } from 'lucide-react'
import type { StorageEntry } from '@shared/api/storage'
import { formatBytes, formatCount, formatDateTime, formatRelative, tildify } from '@shared/format'
import { Badge, Button, Card, ConfirmDialog, EmptyState, IconButton, PageLayout, Spinner, useToast } from '@/components'
import { api, isMac, useApi } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useNav, type ScreenProps } from '@/lib/nav'
import { FindingsList } from '../Overview/Findings'
import { useFindings } from '../Overview/useFindings'
import { useFolder } from './useFolder'
import './storage.css'

const SHOW_LIMIT = 300

const parentOf = (rel: string): string => {
  const i = Math.max(rel.lastIndexOf('/'), rel.lastIndexOf('\\'))
  return i < 0 ? '' : rel.slice(0, i)
}

export default function StorageScreen({ selectId }: ScreenProps): JSX.Element {
  const toast = useToast()
  const { seq } = useNav()
  const info = useApi(() => api.system.configInfo(), [])
  const sep = info.data?.sep ?? '/'
  const [rel, setRel] = useState('')
  const [highlight, setHighlight] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [trashing, setTrashing] = useState<StorageEntry | null>(null)
  const [busy, setBusy] = useState(false)
  const folder = useFolder(rel)
  const found = useFindings()

  // arriving with a path (from Overview, a finding or the palette): open that folder, or the folder holding a file
  useEffect(() => {
    if (!selectId) return
    let alive = true
    api.storage.children(parentOf(selectId)).then(
      (list) => {
        if (!alive) return
        const hit = list.find((e) => e.rel === selectId)
        if (hit?.isDir) {
          setRel(hit.rel)
          setHighlight(null)
        } else {
          setRel(parentOf(selectId))
          setHighlight(selectId)
        }
        setShowAll(false)
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [selectId, seq])

  const go = (next: string): void => {
    setRel(next)
    setHighlight(null)
    setShowAll(false)
  }

  const rows = useMemo(
    () =>
      [...folder.entries].sort((a, b) => {
        if (a.bytes === null && b.bytes !== null) return 1
        if (b.bytes === null && a.bytes !== null) return -1
        return (b.bytes ?? 0) - (a.bytes ?? 0) || a.name.localeCompare(b.name)
      }),
    [folder.entries]
  )
  const max = rows.reduce((m, r) => Math.max(m, r.bytes ?? 0), 0)
  const total = rows.reduce((n, r) => n + (r.bytes ?? 0), 0)
  const shown = showAll ? rows : rows.slice(0, SHOW_LIMIT)

  const home = info.data?.home ?? ''
  const rootLabel = info.data ? tildify(info.data.configDir, home) : '~/.claude'
  const parts = rel ? rel.split(sep) : []
  const crumbs = [{ label: rootLabel, rel: '' }, ...parts.map((p, i) => ({ label: p, rel: parts.slice(0, i + 1).join(sep) }))]

  const scoped = found.findings.filter((f) => rel === '' || f.paths.some((p) => p === rel || p.startsWith(rel + sep)))
  const fm = isMac() ? 'Finder' : window.claudock.platform === 'win32' ? 'Explorer' : 'file manager'

  const reloadAll = (): void => {
    folder.reload()
    found.rescan()
  }

  async function confirmTrash(): Promise<void> {
    if (!trashing) return
    setBusy(true)
    try {
      await api.storage.trash(trashing.rel)
      toast(`Moved ${trashing.name} to Trash.`, { kind: 'success' })
      setTrashing(null)
      reloadAll()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageLayout
      title="Storage"
      description="What takes space, largest first. Open a folder to see what is inside it."
      actions={
        <Button variant="secondary" icon={<RefreshCw size={16} strokeWidth={1.8} />} onClick={reloadAll} disabled={folder.scanning}>
          Measure again
        </Button>
      }
      toolbar={
        <nav aria-label="Folder path" className="stor__crumbs">
          {crumbs.map((c, i) => (
            <span key={c.rel || 'root'} className="stor__crumb">
              {i > 0 ? (
                <span aria-hidden className="stor__sep">
                  /
                </span>
              ) : null}
              {i === crumbs.length - 1 ? (
                <span aria-current="page" className="stor__here">
                  {c.label}
                </span>
              ) : (
                <button type="button" className="stor__crumbbtn" onClick={() => go(c.rel)}>
                  {c.label}
                </button>
              )}
            </span>
          ))}
        </nav>
      }
    >
      {scoped.length > 0 || (found.scanning && rel === '') || found.error ? (
        <Card title="Suggestions" description="Cleanups found in your real files." className="stor__sugg">
          <FindingsList findings={scoped} scanning={found.scanning && rel === ''} error={found.error} compact onChanged={reloadAll} />
        </Card>
      ) : null}

      <Card
        flush
        title={rel ? parts[parts.length - 1] : 'Contents'}
        description={folder.loading ? 'Reading folder…' : `${formatCount(rows.length)} ${rows.length === 1 ? 'item' : 'items'}${folder.scanning ? ' · measuring' : ` · ${formatBytes(total)}`}`}
        actions={folder.scanning ? <Spinner size={16} label="Measuring" /> : undefined}
      >
        {folder.error ? (
          <p className="find__error stor__error" role="alert">
            {folder.error}
          </p>
        ) : null}
        {!folder.loading && rows.length === 0 && !folder.error ? (
          <EmptyState icon={<Folder />} title="This folder is empty" description="Nothing to show here." />
        ) : (
          <table className="stor__table">
            <colgroup>
              <col className="stor__c-name" />
              <col className="stor__c-bar" />
              <col className="stor__c-size" />
              <col className="stor__c-files" />
              <col className="stor__c-mod" />
              <col className="stor__c-act" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">
                  <span className="sr-only">Share of this folder</span>
                </th>
                <th scope="col" className="stor__num">
                  Size
                </th>
                <th scope="col" className="stor__num">
                  Files
                </th>
                <th scope="col">Modified</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <Row
                  key={r.rel}
                  entry={r}
                  max={max}
                  biggest={i === 0 && (r.bytes ?? 0) > 0}
                  highlighted={highlight === r.rel}
                  fm={fm}
                  onOpen={() => go(r.rel)}
                  onTrash={() => setTrashing(r)}
                />
              ))}
            </tbody>
          </table>
        )}
        {rows.length > shown.length ? (
          <div className="stor__more">
            <Button variant="secondary" onClick={() => setShowAll(true)}>
              Show all {formatCount(rows.length)} items
            </Button>
          </div>
        ) : null}
      </Card>

      <ConfirmDialog
        open={trashing !== null}
        title={trashing ? `Move ${trashing.name} to Trash?` : ''}
        description={
          trashing ? (
            <>
              <span className="stor__mono">{trashing.rel}</span>
              {trashing.bytes !== null ? ` (${formatBytes(trashing.bytes)})` : ''} goes to the Trash. You can put it back from there.
            </>
          ) : undefined
        }
        confirmLabel="Move to Trash"
        tone="danger"
        busy={busy}
        onConfirm={() => void confirmTrash()}
        onCancel={() => setTrashing(null)}
      />
    </PageLayout>
  )
}

interface RowProps {
  entry: StorageEntry
  max: number
  biggest: boolean
  highlighted: boolean
  fm: string
  onOpen: () => void
  onTrash: () => void
}

function Row({ entry: e, max, biggest, highlighted, fm, onOpen, onTrash }: RowProps): JSX.Element {
  const toast = useToast()
  const pct = e.bytes !== null && max > 0 ? Math.max(e.bytes > 0 ? 0.6 : 0, (e.bytes / max) * 100) : 0
  const Icon = e.locked ? Lock : e.isDir ? Folder : FileIcon

  if (e.locked) {
    return (
      <tr className="stor__row stor__row--locked">
        <td>
          <span className="stor__name">
            <Lock size={16} strokeWidth={1.8} aria-hidden className="stor__icon" />
            <span className="stor__label">{e.name}</span>
            <Badge tone="oat">hidden</Badge>
          </span>
        </td>
        <td />
        <td className="stor__num stor__muted" title="Hidden for safety">
          —
        </td>
        <td className="stor__num stor__muted">—</td>
        <td className="stor__muted">{formatRelative(e.mtimeMs)}</td>
        <td />
      </tr>
    )
  }

  return (
    <tr className={cx('stor__row', highlighted && 'stor__row--hl')} aria-current={highlighted || undefined}>
      <td>
        <span className="stor__name">
          <Icon size={16} strokeWidth={1.8} aria-hidden className="stor__icon" />
          {e.isDir ? (
            <button type="button" className="stor__open" onClick={onOpen} title={`Open ${e.name}`}>
              {e.name}
            </button>
          ) : (
            <span className="stor__label" title={e.name}>
              {e.name}
            </span>
          )}
        </span>
      </td>
      <td>
        <span className="stor__track" aria-hidden>
          <span className={cx('stor__fill', biggest && 'stor__fill--big')} style={{ width: `${pct}%` }} />
        </span>
      </td>
      <td className="stor__num">{e.bytes === null ? <span className="stor__muted">…</span> : formatBytes(e.bytes)}</td>
      <td className="stor__num">{e.isDir ? (e.files === null ? <span className="stor__muted">…</span> : formatCount(e.files)) : <span className="stor__muted">—</span>}</td>
      <td className="stor__muted" title={formatDateTime(e.mtimeMs)}>
        {formatRelative(e.mtimeMs)}
      </td>
      <td>
        <span className="stor__actions">
          <IconButton
            aria-label={`Reveal ${e.name} in ${fm}`}
            icon={<FolderOpen size={16} strokeWidth={1.8} />}
            size="sm"
            onClick={() => api.system.reveal(e.rel).catch((err: Error) => toast(err.message, { kind: 'error' }))}
          />
          <IconButton aria-label={`Move ${e.name} to Trash`} icon={<Trash2 size={16} strokeWidth={1.8} />} variant="danger" size="sm" onClick={onTrash} />
        </span>
      </td>
    </tr>
  )
}
