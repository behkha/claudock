import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from './Button'

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** danger = destructive confirm (Move to Trash). Focus starts on Cancel. */
  tone?: 'default' | 'danger'
  busy?: boolean
  /** The confirm button is disabled (nothing chosen yet). */
  confirmDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Modal built on <dialog>: focus trap, Esc to cancel and aria-modal come from the platform. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  busy,
  confirmDisabled,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onCancel()
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onCancel()
      }}
    >
      {open ? (
        <div className="dialog__panel">
          <h2 id="confirm-title" className="dialog__title">
            {title}
          </h2>
          {description ? <div className="dialog__body">{description}</div> : null}
          <div className="dialog__actions">
            <Button variant="secondary" autoFocus={tone === 'danger'} onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </Button>
            <Button variant={tone === 'danger' ? 'danger' : 'primary'} autoFocus={tone !== 'danger'} onClick={onConfirm} loading={busy} disabled={confirmDisabled}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}
