import { useEffect, useMemo, useState } from 'react'
import { Archive, FileText, FolderInput, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import type { FileCompare, LooseBackup } from '@shared/api/backups'
import type { SnapshotInfo } from '@shared/types'
import { formatBytes, formatDate, formatDateTime, formatRelative } from '@shared/format'
import {
  Badge,
  Button,
  Chip,
  ConfirmDialog,
  DetailPane,
  DiffView,
  EmptyState,
  IconButton,
  ListDetailLayout,
  ListGroup,
  ListPane,
  ListRow,
  Spinner,
  useToast
} from '@/components'
import { api, useApi } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useSelectId } from '@/lib/hooks'
import type { ScreenProps } from '@/lib/nav'
import './backups.css'

type Filter = 'all' | 'snapshots' | 'loose'

const snapKey = (id: string): string => `snap:${id}`
const looseKey = (rel: string): string => `loose:${rel}`

export default function BackupsScreen({ selectId }: ScreenProps): JSX.Element {
  const toast = useToast()
  const list = useApi(() => api.backups.list(), [])
  const [sel, setSel] = useSelectId(selectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [tidying, setTidying] = useState(false)

  const snapshots = useMemo(() => list.data?.snapshots ?? [], [list.data])
  const loose = useMemo(() => list.data?.loose ?? [], [list.data])
  const looseRoot = loose.filter((l) => l.location === 'root' && !l.hidden)

  // selectId may be "snap:<id>", "loose:<rel>", a snapshot id or a config-relative path
  const selected = useMemo(() => {
    if (!sel) return null
    if (sel.startsWith('snap:')) return snapshots.find((s) => s.id === sel.slice(5)) ? sel : null
    if (sel.startsWith('loose:')) return loose.find((l) => l.rel === sel.slice(6) && !l.hidden) ? sel : null
    if (snapshots.some((s) => s.id === sel)) return snapKey(sel)
    if (loose.some((l) => l.rel === sel && !l.hidden)) return looseKey(sel)
    return null
  }, [sel, snapshots, loose])

  // open the newest item when nothing is selected
  useEffect(() => {
    if (selected || !list.data) return
    if (snapshots[0]) setSel(snapKey(snapshots[0].id))
    else {
      const first = loose.find((l) => !l.hidden)
      if (first) setSel(looseKey(first.rel))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, selected])

  const snap = selected?.startsWith('snap:') ? snapshots.find((s) => s.id === selected.slice(5)) : undefined
  const looseSel = selected?.startsWith('loose:') ? loose.find((l) => l.rel === selected.slice(6)) : undefined

  async function tidy(): Promise<void> {
    setTidying(true)
    try {
      const r = await api.backups.tidy(looseRoot.map((l) => l.rel))
      toast(r.moved === 0 ? 'Nothing to tidy.' : `Moved ${r.moved} ${r.moved === 1 ? 'file' : 'files'} into ${r.folder}.`, { kind: 'success' })
      list.reload()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setTidying(false)
    }
  }

  const showSnaps = filter !== 'loose'
  const showLoose = filter !== 'snapshots'
  const total = snapshots.length + loose.filter((l) => !l.hidden).length

  const listPane = (
    <ListPane
      title="Backups"
      count={list.data ? total : undefined}
      actions={<IconButton aria-label="Refresh backups" icon={<RefreshCw size={16} strokeWidth={1.8} />} onClick={list.reload} />}
      filters={
        <>
          <Chip selected={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </Chip>
          <Chip selected={filter === 'snapshots'} onClick={() => setFilter('snapshots')} count={snapshots.length}>
            Snapshots
          </Chip>
          <Chip selected={filter === 'loose'} onClick={() => setFilter('loose')} count={loose.length}>
            Loose files
          </Chip>
        </>
      }
      windowed={{ rowHeight: 52 }}
      loading={list.loading && !list.data}
      error={list.error}
      isEmpty={!!list.data && total === 0 && loose.length === 0}
      empty={<EmptyState icon={<Archive />} title="No backups yet" description="Snapshots appear here after Claudock changes a file." />}
      footer={
        looseRoot.length > 0 ? (
          <Button variant="secondary" icon={<FolderInput size={16} strokeWidth={1.8} />} loading={tidying} onClick={() => void tidy()}>
            Tidy {looseRoot.length} loose {looseRoot.length === 1 ? 'file' : 'files'} into backups/
          </Button>
        ) : undefined
      }
    >
      {showSnaps && snapshots.length > 0 ? <ListGroup>Claudock snapshots</ListGroup> : null}
      {showSnaps
        ? snapshots.map((s) => (
            <ListRow
              key={s.id}
              title={formatDateTime(s.at)}
              subtitle={s.reason}
              meta={`${s.files.length} ${s.files.length === 1 ? 'file' : 'files'}`}
              selected={selected === snapKey(s.id)}
              onSelect={() => setSel(snapKey(s.id))}
            />
          ))
        : null}
      {showLoose && loose.length > 0 ? <ListGroup>Loose backup files</ListGroup> : null}
      {showLoose
        ? loose.map((l) => (
            <ListRow
              key={l.rel}
              title={<span className="bk__mono">{l.name}</span>}
              subtitle={l.hidden ? 'Hidden for safety' : `${originText(l)} · ${formatDate(l.mtimeMs)}`}
              meta={l.hidden ? undefined : formatBytes(l.size)}
              locked={l.hidden}
              selected={selected === looseKey(l.rel)}
              onSelect={() => setSel(looseKey(l.rel))}
            />
          ))
        : null}
    </ListPane>
  )

  let detail: JSX.Element
  if (snap) detail = <SnapshotDetail key={snap.id} snap={snap} onChanged={list.reload} />
  else if (looseSel) detail = <LooseDetail key={looseSel.rel} item={looseSel} onChanged={list.reload} />
  else if (list.loading && !list.data) detail = <div className="bk__center"><Spinner /></div>
  else detail = <EmptyState icon={<Archive />} title="Pick a backup" description="Choose a snapshot or a loose file to compare it with the current file and restore it." />

  return <ListDetailLayout list={listPane} detail={detail} />
}

function originText(l: LooseBackup): string {
  if (l.liveRel) return `Backs up ${l.liveName}`
  if (l.liveName) return `${l.liveName} is gone`
  return 'Original unknown'
}

/* ------------------------------------------------------------------ shared compare body */

function CompareBody({ data, backupLabel, loading, error }: { data: FileCompare | undefined; backupLabel: string; loading: boolean; error: string | null }): JSX.Element {
  if (error) return <p className="find__error" role="alert">{error}</p>
  if (!data) return <div className="bk__center"><Spinner /></div>
  if (data.binary) return <p className="bk__note">This file is not text, so it cannot be compared here.</p>
  if (data.tooLarge) return <p className="bk__note">This file is larger than 2 MB, so it cannot be compared here.</p>
  const claude = data.mode === 'claudeJson'
  return (
    <div className="bk__compare" aria-busy={loading || undefined}>
      {claude ? (
        <p className="bk__note">
          Compared: the <code>mcpServers</code> key of <code>.claude.json</code>.
          {data.differingKeys.filter((k) => k !== 'mcpServers').length > 0
            ? ` Claude Code also changed ${data.differingKeys.filter((k) => k !== 'mcpServers').join(', ')}; those are never touched.`
            : ''}
        </p>
      ) : (
        <p className="bk__note">Restoring turns the current file into the backup: green lines come back, red lines go away.</p>
      )}
      <div className="bk__diff">
        <DiffView
          before={data.live}
          after={data.backup}
          beforeLabel={data.liveExists ? 'Current' : 'Current (missing)'}
          afterLabel={backupLabel}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ snapshot detail */

function SnapshotDetail({ snap, onChanged }: { snap: SnapshotInfo; onChanged: () => void }): JSX.Element {
  const toast = useToast()
  const [fileRel, setFileRel] = useState(snap.files[0] ?? '')
  const file = snap.files.includes(fileRel) ? fileRel : (snap.files[0] ?? '')
  const cmp = useApi(() => (file ? api.backups.snapshotFile(snap.id, file) : Promise.reject(new Error('This snapshot has no files'))), [snap.id, file])
  const [confirm, setConfirm] = useState<'restore' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)

  // useApi keeps the previous result while a new one loads: never show or act on a comparison for another file
  const data = cmp.loading ? undefined : cmp.data
  const claude = data?.mode === 'claudeJson'
  const unchanged = !!data && !claude && !data.binary && !data.tooLarge && data.liveExists && data.live === data.backup
  const blocked = !data || (claude ? !data.canRestoreKey : false) || unchanged
  const restoreLabel = claude ? 'Restore mcpServers only' : 'Restore this file'
  const why = claude ? data?.restoreBlockedReason : unchanged ? 'This file is the same as the current one, so there is nothing to restore.' : null

  async function run(kind: 'restore' | 'delete'): Promise<void> {
    setBusy(true)
    try {
      if (kind === 'restore') {
        await api.backups.restoreSnapshotFile(snap.id, file)
        toast(`Restored ${claude ? 'mcpServers' : file}. The version it replaced is kept in Backups.`, { kind: 'success' })
        cmp.reload()
      } else {
        await api.backups.deleteSnapshot(snap.id)
        toast('Snapshot moved to Trash.', { kind: 'success' })
      }
      setConfirm(null)
      onChanged()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DetailPane
        title={formatDateTime(snap.at)}
        path={snap.id}
        reveal={false}
        badges={<Badge tone="oat">{formatRelative(snap.at)}</Badge>}
        actions={
          <>
            <Button variant="primary" icon={<RotateCcw size={16} strokeWidth={1.8} />} disabled={blocked || busy} onClick={() => setConfirm('restore')}>
              {restoreLabel}
            </Button>
            <Button variant="danger" icon={<Trash2 size={16} strokeWidth={1.8} />} onClick={() => setConfirm('delete')} disabled={busy}>
              Delete snapshot
            </Button>
          </>
        }
      >
        <div className="bk__body">
          <p className="bk__reason">{snap.reason}</p>
          {why ? <p className="bk__note bk__note--why">{why}</p> : null}
          <h2 className="bk__h">Files in this snapshot</h2>
          <ul role="list" className="bk__files">
            {snap.files.map((f) => (
              <li key={f}>
                <button type="button" className={cx('bk__file', f === file && 'bk__file--on')} aria-pressed={f === file} onClick={() => setFileRel(f)}>
                  <FileText size={14} strokeWidth={1.8} aria-hidden />
                  <span className="bk__mono">{f}</span>
                </button>
              </li>
            ))}
          </ul>
          <CompareBody data={data} backupLabel={`Snapshot of ${formatDateTime(snap.at)}`} loading={cmp.loading} error={cmp.error} />
        </div>
      </DetailPane>
      <ConfirmDialog
        open={confirm === 'restore'}
        title={claude ? 'Restore mcpServers?' : `Restore ${file}?`}
        description={
          claude
            ? 'Only the mcpServers key of .claude.json is replaced. The current .claude.json is snapshotted first, so you can undo this from Backups.'
            : 'The current version is snapshotted first, so you can undo this from Backups.'
        }
        confirmLabel="Restore"
        busy={busy}
        onConfirm={() => void run('restore')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Move this snapshot to Trash?"
        description={`The snapshot of ${formatDateTime(snap.at)} (${snap.files.length} ${snap.files.length === 1 ? 'file' : 'files'}) goes to the Trash. You can put it back from there.`}
        confirmLabel="Move to Trash"
        tone="danger"
        busy={busy}
        onConfirm={() => void run('delete')}
        onCancel={() => setConfirm(null)}
      />
    </>
  )
}

/* ------------------------------------------------------------------ loose file detail */

function LooseDetail({ item, onChanged }: { item: LooseBackup; onChanged: () => void }): JSX.Element {
  const toast = useToast()
  const cmp = useApi(() => api.backups.looseCompare(item.rel), [item.rel])
  const info = useApi(() => api.system.configInfo(), [])
  const [confirm, setConfirm] = useState<'restore' | 'trash' | null>(null)
  const [busy, setBusy] = useState(false)

  const data = cmp.loading ? undefined : cmp.data
  const claude = data?.mode === 'claudeJson'
  const unchanged = !!data && !claude && !data.binary && !data.tooLarge && data.liveExists && data.live === data.backup
  const blocked = !data || !!data.binary || data.tooLarge || (claude ? !data.canRestoreKey : !data.liveRel) || unchanged
  const restoreLabel = claude ? 'Restore mcpServers only' : item.liveName ? `Restore to ${item.liveName}` : 'Restore'
  const why = data?.restoreBlockedReason ?? (unchanged ? 'This file is the same as the current one, so there is nothing to restore.' : null)

  async function run(kind: 'restore' | 'trash'): Promise<void> {
    setBusy(true)
    try {
      if (kind === 'restore') {
        await api.backups.restoreLoose(item.rel)
        toast(`Restored ${claude ? 'mcpServers' : (item.liveName ?? item.name)}. The version it replaced is kept in Backups.`, { kind: 'success' })
        cmp.reload()
      } else {
        await api.backups.trashLoose(item.rel)
        toast(`Moved ${item.name} to Trash.`, { kind: 'success' })
      }
      setConfirm(null)
      onChanged()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DetailPane
        title={<span className="bk__mono bk__title">{item.name}</span>}
        path={info.data ? `${info.data.configDir}${info.data.sep}${item.rel.replace(/[\\/]/g, info.data.sep)}` : item.rel}
        reveal={item.rel}
        badges={
          <>
            <Badge tone="oat">{item.location === 'root' ? 'In the root' : 'In backups/'}</Badge>
            <Badge>{formatBytes(item.size)}</Badge>
          </>
        }
        actions={
          <>
            <Button variant="primary" icon={<RotateCcw size={16} strokeWidth={1.8} />} disabled={blocked || busy} onClick={() => setConfirm('restore')}>
              {restoreLabel}
            </Button>
            <Button variant="danger" icon={<Trash2 size={16} strokeWidth={1.8} />} onClick={() => setConfirm('trash')} disabled={busy}>
              Move to Trash
            </Button>
          </>
        }
      >
        <div className="bk__body">
          <p className="bk__reason">
            {item.liveRel ? (
              <>
                Backup of <span className="bk__mono">{item.liveName}</span>, saved {formatDateTime(item.mtimeMs)}.
              </>
            ) : item.liveName ? (
              <>
                Looks like a backup of <span className="bk__mono">{item.liveName}</span>, which is not in the folder any more.
              </>
            ) : (
              'Claudock cannot tell which file this is a backup of.'
            )}
          </p>
          {why ? <p className="bk__note bk__note--why">{why}</p> : null}
          <CompareBody data={data} backupLabel={item.name} loading={cmp.loading} error={cmp.error} />
        </div>
      </DetailPane>
      <ConfirmDialog
        open={confirm === 'restore'}
        title={claude ? 'Restore mcpServers?' : `Restore ${item.liveName ?? 'this file'}?`}
        description={
          claude
            ? 'Only the mcpServers key of .claude.json is replaced. The current .claude.json is snapshotted first, so you can undo this from Backups.'
            : `${item.name} replaces the current ${item.liveName}. The current version is snapshotted first, so you can undo this from Backups.`
        }
        confirmLabel="Restore"
        busy={busy}
        onConfirm={() => void run('restore')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'trash'}
        title={`Move ${item.name} to Trash?`}
        description="You can put it back from the Trash."
        confirmLabel="Move to Trash"
        tone="danger"
        busy={busy}
        onConfirm={() => void run('trash')}
        onCancel={() => setConfirm(null)}
      />
    </>
  )
}
