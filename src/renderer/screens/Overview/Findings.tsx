import { useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import type { Finding } from '@shared/api/overview'
import { formatBytes } from '@shared/format'
import { Button, ConfirmDialog, Spinner, useToast } from '@/components'
import { api } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useNav } from '@/lib/nav'
import './overview.css'

export interface FindingsListProps {
  findings: Finding[]
  scanning: boolean
  error?: string | null
  /** Tighter rows for the Storage screen. */
  compact?: boolean
  /** Called after an action changed something on disk (reload sizes, findings, counts). */
  onChanged: () => void
}

/** One-click actions for a finding. Anything that trashes or empties a file asks first. */
export function FindingsList({ findings, scanning, error, compact, onChanged }: FindingsListProps): JSX.Element {
  const toast = useToast()
  const { navigate } = useNav()
  const [pending, setPending] = useState<Finding | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function perform(f: Finding): Promise<void> {
    const a = f.action
    setBusyId(f.id)
    try {
      if (a.type === 'open') {
        navigate(a.screen, a.selectId)
        return
      }
      if (a.type === 'tidy') {
        const r = await api.backups.tidy(a.rels)
        toast(r.moved === 0 ? 'Nothing to tidy.' : `Moved ${r.moved} ${r.moved === 1 ? 'file' : 'files'} into ${r.folder}.`, { kind: 'success' })
      } else if (a.type === 'trash') {
        const r = await api.overview.trash(a.rels)
        toast(`Moved ${r.trashed} ${r.trashed === 1 ? 'item' : 'items'} to Trash.`, { kind: 'success' })
      } else {
        await api.overview.clearLog(a.rel)
        toast('Log cleared. Snapshot kept in Backups.', { kind: 'success' })
      }
      onChanged()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
      onChanged()
    } finally {
      setBusyId(null)
      setPending(null)
    }
  }

  function onAction(f: Finding): void {
    if (f.action.type === 'trash' || f.action.type === 'clearLog') setPending(f)
    else void perform(f)
  }

  const confirm = pending && (pending.action.type === 'trash' || pending.action.type === 'clearLog') ? pending.action : null

  return (
    <>
      {error ? (
        <p className="find__error" role="alert">
          {error}
        </p>
      ) : null}
      {findings.length > 0 ? (
        <ul role="list" className={cx('find', compact && 'find--compact')} aria-busy={scanning || undefined}>
          {findings.map((f) => (
            <li key={f.id} className="find__row">
              <div className="find__text">
                <span className="find__title">{f.title}</span>
                <span className="find__detail" title={f.detail}>
                  {f.detail}
                </span>
              </div>
              {f.bytes !== undefined && f.action.type !== 'open' ? <span className="find__size">{formatBytes(f.bytes)}</span> : null}
              <Button
                variant="secondary"
                className="find__action"
                loading={busyId === f.id}
                disabled={busyId !== null}
                onClick={() => onAction(f)}
                aria-label={`${f.action.label}: ${f.title}`}
              >
                {f.action.label}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {scanning ? (
        <p className="find__status" role="status">
          <Spinner size={14} label="" /> {findings.length > 0 ? 'Still looking…' : 'Looking for things worth a look…'}
        </p>
      ) : findings.length === 0 && !error ? (
        <p className="find__status find__status--ok">
          <CheckCircle2 size={16} strokeWidth={1.8} aria-hidden /> Nothing to clean up right now.
        </p>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.confirmTitle ?? ''}
        description={confirm?.confirmBody}
        confirmLabel={confirm?.type === 'clearLog' ? 'Clear log' : 'Move to Trash'}
        tone="danger"
        busy={busyId !== null}
        onConfirm={() => pending && void perform(pending)}
        onCancel={() => setPending(null)}
      />
    </>
  )
}
