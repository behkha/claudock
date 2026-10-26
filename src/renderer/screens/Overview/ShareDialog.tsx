import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, ExternalLink, X } from 'lucide-react'
import type { WrappedStats } from '@shared/api/overview'
import { Button, EmptyState, IconButton } from '@/components'
import { api } from '@/lib/api'
import { cardPng, drawCard } from './wrappedCard'

type Action = 'copy' | 'save' | 'post'
type Status = { kind: 'ok' | 'error'; text: string }

const DONE: Record<Action, string> = {
  copy: 'Copied',
  save: 'Saved',
  post: 'Image copied. Paste it into your post.'
}

/**
 * Modal with the share card. The canvas is drawn once at 2400x1350 and shown scaled down by CSS, so the preview is the
 * exported image. Feedback sits in the dialog because the toast layer is underneath a modal <dialog>.
 */
export function ShareDialog({ open, stats, onClose }: { open: boolean; stats: WrappedStats | null | undefined; onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    setStatus(null)
    setBusy(null)
  }, [open])

  useEffect(() => {
    const canvas = canvasRef.current
    setReady(false)
    if (!open || !stats || !canvas) return
    canvas.dataset.ready = 'false'
    let stale = false
    drawCard(canvas, stats).then(
      () => {
        if (stale) return
        canvas.dataset.ready = 'true'
        setReady(true)
      },
      (e: unknown) => {
        if (!stale) setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
      }
    )
    return () => {
      stale = true
    }
  }, [open, stats])

  async function run(action: Action): Promise<void> {
    const canvas = canvasRef.current
    if (!canvas || !ready) return
    setBusy(action)
    setStatus(null)
    try {
      const png = await cardPng(canvas)
      if (action === 'copy') await api.overview.copyImage(png)
      else if (action === 'post') await api.overview.postOnX(png)
      else if (!(await api.overview.saveImage(png)).saved) return
      setStatus({ kind: 'ok', text: DONE[action] })
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const disabled = !ready || busy !== null

  return (
    <dialog
      ref={dialogRef}
      className="dialog share"
      aria-labelledby="share-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
    >
      {open ? (
        <div className="dialog__panel share__panel">
          <header className="share__head">
            <h2 id="share-title" className="dialog__title">
              Share stats
            </h2>
            <IconButton aria-label="Close" icon={<X size={16} strokeWidth={1.8} />} onClick={onClose} />
          </header>
          {stats ? (
            <>
              <div className="share__frame">
                <canvas ref={canvasRef} className="share__canvas" aria-label="Your Claude Code stats card" role="img" />
              </div>
              <div className="share__actions">
                <p className={status?.kind === 'error' ? 'share__status share__status--error' : 'share__status'} role={status?.kind === 'error' ? 'alert' : 'status'}>
                  {status?.kind === 'ok' ? <Check size={14} strokeWidth={1.8} aria-hidden /> : null}
                  {status?.text}
                </p>
                <Button icon={<Copy size={15} strokeWidth={1.8} />} onClick={() => void run('copy')} disabled={disabled} loading={busy === 'copy'}>
                  Copy image
                </Button>
                <Button icon={<Download size={15} strokeWidth={1.8} />} onClick={() => void run('save')} disabled={disabled} loading={busy === 'save'}>
                  Save PNG
                </Button>
                <Button variant="primary" icon={<ExternalLink size={15} strokeWidth={1.8} />} onClick={() => void run('post')} disabled={disabled} loading={busy === 'post'}>
                  Post on X
                </Button>
              </div>
            </>
          ) : (
            <EmptyState title="No stats yet" />
          )}
        </div>
      ) : null}
    </dialog>
  )
}
