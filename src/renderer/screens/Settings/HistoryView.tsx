import { useEffect, useState } from 'react'
import { History as HistoryIcon, RotateCcw } from 'lucide-react'
import type { SettingsFileName, SettingsHistoryItem } from '@shared/api/settings'
import { formatBytes, formatDateTime, formatRelative } from '@shared/format'
import { Badge, Button, ConfirmDialog, DiffView, EmptyState, Spinner } from '@/components'
import { api } from '@/lib/api'
import { cx } from '@/lib/cx'

export interface HistoryViewProps {
  file: SettingsFileName
  /** The saved file on disk (not the unsaved draft). */
  current: string
  dirty: boolean
  /** Bumped after a save or restore so the list refreshes. */
  version: number
  onRestore: (id: string, label: string) => Promise<void>
}

export function HistoryView({ file, current, dirty, version, onRestore }: HistoryViewProps): JSX.Element {
  const [items, setItems] = useState<SettingsHistoryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [textError, setTextError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setError(null)
    api.settings.history(file).then(
      (r) => {
        if (!live) return
        setItems(r)
        setSelected((s) => (s && r.some((i) => i.id === s) ? s : (r[0]?.id ?? null)))
      },
      (e: Error) => live && setError(e.message)
    )
    return () => {
      live = false
    }
  }, [file, version])

  useEffect(() => {
    if (!selected) return setText(null)
    let live = true
    setText(null)
    setTextError(null)
    api.settings.readHistory(file, selected).then(
      (t) => live && setText(t),
      (e: Error) => live && setTextError(e.message)
    )
    return () => {
      live = false
    }
  }, [file, selected])

  if (error) return <EmptyState title="Could not load history" description={error} />
  if (!items) {
    return (
      <div className="st-center">
        <Spinner />
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<HistoryIcon />}
        title="No earlier versions yet"
        description={`Every save keeps a snapshot of ${file}. Loose .bak copies in the config folder show up here too.`}
      />
    )
  }
  const item = items.find((i) => i.id === selected) ?? null

  return (
    <div className="st-history">
      <ul role="list" className="st-history__list" aria-label={`Earlier versions of ${file}`}>
        {items.map((i) => (
          <li key={i.id}>
            <button
              type="button"
              className={cx('st-history__item', i.id === selected && 'st-history__item--active')}
              aria-current={i.id === selected ? 'true' : undefined}
              onClick={() => setSelected(i.id)}
            >
              <span className="st-history__top">
                <span className="st-history__time">{formatDateTime(i.at)}</span>
                <Badge tone={i.kind === 'snapshot' ? 'oat' : 'neutral'}>{i.kind === 'snapshot' ? 'Snapshot' : 'Loose copy'}</Badge>
              </span>
              <span className="st-history__label">{i.label}</span>
              <span className="st-history__meta">
                {formatRelative(i.at)}
                {i.size !== null ? ` · ${formatBytes(i.size)}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="st-history__detail">
        {item ? (
          <>
            <div className="st-history__bar">
              <p className="st-muted">
                {dirty ? 'Compared with the saved file, not your unsaved edits.' : 'Compared with the file as it is now.'}
              </p>
              <Button icon={<RotateCcw />} disabled={text === null} onClick={() => setConfirm(true)}>
                Restore this version
              </Button>
            </div>
            {textError ? (
              <p className="st-error" role="alert">
                {textError}
              </p>
            ) : text === null ? (
              <div className="st-center">
                <Spinner />
              </div>
            ) : (
              <>
                <p className="st-muted">Restoring turns the current file into the backup: green lines come back, red lines go away.</p>
                <DiffView before={current} after={text} beforeLabel="Current" afterLabel={item.kind === 'snapshot' ? 'Snapshot' : item.label} context={4} />
              </>
            )}
          </>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm}
        busy={busy}
        title={`Restore ${file}?`}
        description={
          <>
            <p>
              This puts back the version from {item ? formatDateTime(item.at) : ''}. The file as it is now is kept as a snapshot first.
            </p>
            {dirty ? <p>Your unsaved edits to {file} will be dropped.</p> : null}
          </>
        }
        confirmLabel="Restore"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          if (!item) return
          setBusy(true)
          onRestore(item.id, item.label).finally(() => {
            setBusy(false)
            setConfirm(false)
          })
        }}
      />
    </div>
  )
}
