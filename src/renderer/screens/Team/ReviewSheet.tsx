import { useEffect, useState } from 'react'
import type { Finding, FixChoice, Review, TeamState, Written } from '@shared/api/team'
import { Button, ConfirmDialog } from '@/components'
import { api } from '@/lib/api'
import { cx } from '@/lib/cx'
import { FetchedDiff } from './parts'

const MARK = { add: '+', change: '~', remove: '−' } as const

/** Plugin files are shown inside the plugin folder; the marketplace file and the README as they are. */
const shown = (rel: string): string => rel.replace(/^plugins\/[^/]+\//, '')

/**
 * Review (decision 3 A): what must be fixed first, each with its fix buttons, then every file the write adds, changes
 * or removes, each opening as a diff. Write stays off until no blocker is left.
 */
export function ReviewSheet({ open, onClose, onTicked, onWritten }: { open: boolean; onClose: () => void; onTicked: (s: TeamState) => void; onWritten: (w: Written) => void }): JSX.Element {
  const [review, setReview] = useState<Review | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return setReview(null)
    setFile(null)
    setError(null)
    let stale = false
    api.team.review().then(
      (r) => !stale && setReview(r),
      (e: Error) => !stale && setError(e.message)
    )
    return () => {
      stale = true
    }
  }, [open])

  async function run(key: string, fn: () => Promise<Review>): Promise<void> {
    setBusy(key)
    setError(null)
    try {
      setReview(await fn())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  function choose(f: Finding, c: FixChoice): void {
    if (c.kind === 'untick') {
      void run(f.key, async () => {
        onTicked(await api.team.setTicked([f.itemId], false))
        return api.team.review()
      })
    } else if (c.kind === 'theirs') {
      void run(f.key, async () => {
        await api.team.takeRepoVersion(f.itemId)
        return api.team.review()
      })
    } else if (c.kind === 'ask') void run(f.key, () => api.team.setFix(f.itemId, { kind: 'ask', where: f.where, key: c.value ?? 'token' }))
    else if (c.kind === 'env') void run(f.key, () => api.team.setFix(f.itemId, { kind: 'env', where: f.where, name: c.value ?? 'TOKEN' }))
    else if (c.kind === 'copy-script') void run(f.key, () => api.team.setFix(f.itemId, { kind: 'copy-script', where: f.where, as: c.value ?? 'script' }))
    else if (c.kind === 'keep' || c.kind === 'mine') {
      const kind = c.kind
      void run(f.key, () => api.team.setFix(f.itemId, { kind, where: f.where }))
    }
  }

  async function write(): Promise<void> {
    if (!review) return
    setBusy('write')
    setError(null)
    try {
      onWritten(await api.team.write(review.token))
    } catch (e) {
      setError((e as Error).message)
      api.team.review().then(setReview, () => undefined)
    } finally {
      setBusy(null)
    }
  }

  const findings = review?.findings ?? []
  const todo = findings.filter((f) => !f.fix)
  const done = findings.filter((f) => f.fix)
  const files = review?.files ?? []
  const label = files.length === 1 ? 'Write 1 file' : `Write ${files.length} files`

  return (
    <ConfirmDialog
      open={open}
      wide
      title="Review"
      confirmLabel={label}
      busy={busy === 'write'}
      confirmDisabled={!review?.canWrite || busy !== null}
      description={
        <div className="tm-sheet" aria-busy={review === null}>
          {findings.length ? (
            <>
              <h3 className="tm-sheet__sub">Fix first · {todo.length}</h3>
              <div className="tm-sheet__list">
                {[...todo, ...done].map((f) => (
                  <div key={f.key} className="tm-find">
                    <span className={cx('tm-find__dot', f.fix ? 'tm-find__dot--done' : !f.blocks && 'tm-find__dot--warning')} aria-hidden />
                    <span className="tm-find__text">
                      <b>{f.itemName}</b>
                      <span>{f.fix ? `${f.text} · ${f.choices.find((c) => c.kind === f.fix?.kind)?.label ?? ''}` : f.text}</span>
                    </span>
                    <span className="tm-find__fixes">
                      {f.fix ? (
                        <Button disabled={busy !== null} onClick={() => void run(f.key, () => api.team.setFix(f.itemId, { kind: 'clear', where: f.where }))}>
                          Undo
                        </Button>
                      ) : (
                        f.choices.map((c) => (
                          <Button key={c.kind} disabled={busy !== null} loading={busy === f.key} onClick={() => choose(f, c)}>
                            {c.label}
                          </Button>
                        ))
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
          <h3 className="tm-sheet__sub">Changes · {files.length === 1 ? '1 file' : `${files.length} files`}</h3>
          {files.length ? (
            <div className="tm-sheet__list">
              {files.map((f) => (
                <div key={f.rel}>
                  <button type="button" className={cx('tm-file', `tm-file--${f.change}`)} aria-expanded={file === f.rel} onClick={() => setFile(file === f.rel ? null : f.rel)}>
                    <span className="tm-file__mark" aria-label={f.change}>
                      {MARK[f.change]}
                    </span>
                    <span className="tm-file__rel">{shown(f.rel)}</span>
                  </button>
                  {file === f.rel ? (
                    <div className="tm-sheet__diff">
                      <FetchedDiff load={() => api.team.fileDiff(f.rel)} deps={[f.rel, review?.token]} beforeLabel="In the repo" afterLabel="Written" />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="tm-sheet__muted">{review ? 'Nothing to write.' : ''}</p>
          )}
          {error ? (
            <p className="tm-sheet__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      }
      onConfirm={() => void write()}
      onCancel={onClose}
    />
  )
}
