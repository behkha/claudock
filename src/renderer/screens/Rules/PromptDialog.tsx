import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Button, TextField } from '@/components'

export interface PromptDialogProps {
  open: boolean
  title: string
  label: string
  initial?: string
  hint?: ReactNode
  confirmLabel: string
  /** Return an error message to keep the dialog open, or nothing on success. */
  onSubmit: (value: string) => Promise<string | void>
  onCancel: () => void
}

/** A one-field modal (new rule, rename). Built on <dialog> like ConfirmDialog; Enter submits, Esc cancels. */
export function PromptDialog({ open, title, label, initial = '', hint, confirmLabel, onSubmit, onCancel }: PromptDialogProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setValue(initial)
      setError(null)
      d.showModal()
    }
    if (!open && d.open) d.close()
  }, [open, initial])

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const msg = await onSubmit(value)
      if (msg) setError(msg)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="prompt-title"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onCancel()
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onCancel()
      }}
    >
      {open ? (
        <form className="dialog__panel" onSubmit={(e) => void submit(e)}>
          <h2 id="prompt-title" className="dialog__title">
            {title}
          </h2>
          <TextField label={label} hint={hint} error={error} autoFocus value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
          <div className="dialog__actions">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!value.trim()}>
              {confirmLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  )
}
