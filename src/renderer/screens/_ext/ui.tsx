import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Plus, X } from 'lucide-react'
import { Button, CodeEditor, ConfirmDialog, IconButton, MarkdownView, Segmented, TextField, useToast } from '@/components'
import { isMac } from '@/lib/api'
import { cx } from '@/lib/cx'
import './ext.css'

/* ------------------------------------------------------------------ small pieces */

/** Clay dot = on, hollow ring = off. The state is also written out in text next to it, never colour alone. */
export function Dot({ on }: { on: boolean }): JSX.Element {
  return <span aria-hidden className={cx('ext-dot', on ? 'ext-dot--on' : 'ext-dot--off')} />
}

export const Spacer = (): JSX.Element => <span className="ext-spacer" />

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Toasts used after writes. `saved(snapshotId)` says "Saved. Snapshot kept in Backups." when a snapshot exists, else
 * `whenNoSnapshot` (a file with no earlier content has nothing to snapshot, but it WAS written).
 * Pass `nothing` when the API can say that nothing changed: then that message is shown instead, as an info toast.
 */
export function useNotify(): {
  saved: (snapshotId: string | null, whenNoSnapshot?: string, nothing?: { changed: boolean; message: string }) => void
  failed: (e: unknown) => void
  info: (message: string) => void
} {
  const toast = useToast()
  return {
    saved: (snapshotId, whenNoSnapshot = 'Saved.', nothing) =>
      nothing && !nothing.changed
        ? toast(nothing.message, { kind: 'info' })
        : toast(snapshotId ? 'Saved. Snapshot kept in Backups.' : whenNoSnapshot, { kind: 'success' }),
    failed: (e) => toast(errorMessage(e), { kind: 'error' }),
    info: (m) => toast(m, { kind: 'info' })
  }
}

/** ⌘S / Ctrl+S runs `save` from anywhere on the screen while `active`. Focused editors handle the key themselves first. */
export function useSaveShortcut(active: boolean, save: () => void): void {
  const ref = useRef(save)
  ref.current = save
  useEffect(() => {
    if (!active) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.defaultPrevented || e.key.toLowerCase() !== 's' || e.altKey || e.shiftKey) return
      if (!(isMac() ? e.metaKey : e.ctrlKey)) return
      e.preventDefault()
      ref.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active])
}

/* ------------------------------------------------------------------ tabs */

export interface TabDef<T extends string> {
  value: T
  label: string
  disabled?: boolean
  title?: string
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label
}: {
  tabs: TabDef<T>[]
  value: T
  onChange: (v: T) => void
  label: string
}): JSX.Element {
  function onKeyDown(e: KeyboardEvent): void {
    const enabled = tabs.filter((t) => !t.disabled)
    const i = enabled.findIndex((t) => t.value === value)
    let n = -1
    if (e.key === 'ArrowRight') n = (i + 1) % enabled.length
    else if (e.key === 'ArrowLeft') n = (i - 1 + enabled.length) % enabled.length
    if (n < 0) return
    e.preventDefault()
    onChange(enabled[n].value)
  }
  return (
    <div role="tablist" aria-label={label} className="ext-tabs" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          disabled={t.disabled}
          title={t.title}
          className="ext-tab"
          onClick={() => onChange(t.value)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ dialogs */

export interface PromptDialogProps {
  open: boolean
  title: string
  label: string
  hint?: ReactNode
  initial?: string
  placeholder?: string
  confirmLabel: string
  mono?: boolean
  busy?: boolean
  /** Return an error message, or null when the value is fine. */
  validate?: (value: string) => string | null
  onSubmit: (value: string) => void
  onCancel: () => void
}

/** A modal with one text field (new skill, new command, rename). Enter submits, Esc cancels. */
export function PromptDialog({ open, title, label, hint, initial = '', placeholder, confirmLabel, mono, busy, validate, onSubmit, onCancel }: PromptDialogProps): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setValue(initial)
      setTouched(false)
      d.showModal()
      requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.select()
      })
    }
    if (!open && d.open) d.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const error = validate ? validate(value.trim()) : null
  const showError = touched && error ? error : undefined

  function submit(): void {
    setTouched(true)
    if (error || busy) return
    onSubmit(value.trim())
  }

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onCancel()
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) onCancel()
      }}
    >
      {open ? (
        <form
          className="dialog__panel"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <h2 className="dialog__title">{title}</h2>
          <TextField
            ref={input}
            label={label}
            hint={hint}
            error={showError}
            mono={mono}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setValue(e.target.value)
              setTouched(true)
            }}
          />
          <div className="dialog__actions">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={busy} disabled={touched && !!error}>
              {confirmLabel}
            </Button>
          </div>
        </form>
      ) : null}
    </dialog>
  )
}

/**
 * Selection with an "unsaved edits" guard. `request(id)` selects at once when nothing is dirty, else asks first.
 * The detail pane reports edits with `setDirty`. Render `dialog` once in the screen.
 */
export function useDirtyGuard(select: (id: string | undefined) => void): {
  request: (id: string | undefined) => void
  setDirty: (dirty: boolean) => void
  dialog: JSX.Element
} {
  const dirty = useRef(false)
  const [pending, setPending] = useState<{ id: string | undefined } | null>(null)
  const request = useCallback(
    (id: string | undefined) => {
      if (dirty.current) setPending({ id })
      else select(id)
    },
    [select]
  )
  const setDirty = useCallback((d: boolean) => {
    dirty.current = d
  }, [])
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title="Discard unsaved changes?"
      description="Your edits have not been saved. Leaving now throws them away."
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      tone="danger"
      onCancel={() => setPending(null)}
      onConfirm={() => {
        dirty.current = false
        if (pending) select(pending.id)
        setPending(null)
      }}
    />
  )
  return { request, setDirty, dialog }
}

/* ------------------------------------------------------------------ markdown */

/** Preview of a Markdown text, with an Edit / Preview switch when `editable`. */
export function MarkdownPane({
  value,
  onChange,
  editable,
  label,
  onSave,
  minHeight = 280,
  maxHeight = 560,
  stripFrontmatter = true,
  toolbar
}: {
  value: string
  onChange?: (v: string) => void
  editable: boolean
  label: string
  onSave?: () => void
  minHeight?: number
  maxHeight?: number
  stripFrontmatter?: boolean
  /** Extra controls on the right of the Edit / Preview switch. */
  toolbar?: ReactNode
}): JSX.Element {
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  return (
    <div className="ext-form">
      {editable ? (
        <div className="ext-kv__head">
          <Segmented
            aria-label={`${label}: edit or preview`}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'preview', label: 'Preview' },
              { value: 'edit', label: 'Edit' }
            ]}
          />
          <Spacer />
          {toolbar}
        </div>
      ) : null}
      {editable && mode === 'edit' ? (
        <CodeEditor aria-label={label} language="markdown" value={value} onChange={onChange} onSave={onSave} minHeight={minHeight} maxHeight={maxHeight} />
      ) : (
        <MarkdownView source={value} stripFrontmatter={stripFrontmatter} />
      )}
    </div>
  )
}

/** Frontmatter keys as a small definition list (skips keys in `skip`). */
export function FrontmatterFacts({ data, skip = [] }: { data: Record<string, string | string[]>; skip?: string[] }): JSX.Element | null {
  const entries = Object.entries(data).filter(([k]) => !skip.includes(k))
  if (entries.length === 0) return null
  return (
    <dl className="ext-facts selectable">
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{Array.isArray(v) ? v.join(', ') : v || '(empty)'}</dd>
        </div>
      ))}
    </dl>
  )
}

/* ------------------------------------------------------------------ chips */

export function ChipList({ items, empty }: { items: string[]; empty?: string }): JSX.Element {
  if (items.length === 0) return <span className="ext-hint">{empty ?? 'None'}</span>
  return (
    <div className="ext-chiplist">
      {items.map((t) => (
        <span key={t} className="ext-chip ext-chip--static">
          {t}
        </span>
      ))}
    </div>
  )
}

/** Editable list of short tokens (agent tools). Enter or comma adds, Backspace on an empty input removes the last. */
export function ChipsInput({
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
  ...rest
}: {
  value: string[]
  onChange: (v: string[]) => void
  suggestions?: string[]
  placeholder?: string
  disabled?: boolean
  'aria-label': string
}): JSX.Element {
  const [text, setText] = useState('')
  const listId = useId()
  function commit(raw: string): void {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length === 0) return
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setText('')
  }
  return (
    <div className="ext-chips">
      {value.map((t) => (
        <span key={t} className="ext-chip">
          {t}
          {disabled ? null : (
            <button type="button" className="ext-chip__x" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
              <X size={12} strokeWidth={1.8} />
            </button>
          )}
        </span>
      ))}
      {disabled ? null : (
        <>
          <input
            className="ext-chips__input"
            aria-label={rest['aria-label']}
            list={suggestions ? listId : undefined}
            value={text}
            placeholder={value.length === 0 ? placeholder : 'Add a tool'}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              const v = e.target.value
              if (v.includes(',')) commit(v)
              else setText(v)
            }}
            onBlur={() => commit(text)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit(text)
              } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
                onChange(value.slice(0, -1))
              }
            }}
          />
          {suggestions ? (
            <datalist id={listId}>
              {suggestions.filter((s) => !value.includes(s)).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          ) : null}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ key/value + list editors */

export type Rows = Array<[string, string]>
export const toRows = (o: Record<string, string> | undefined): Rows => Object.entries(o ?? {}).map(([k, v]) => [k, String(v)])
export function fromRows(rows: Rows): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of rows) if (k.trim() !== '' || v !== '') out[k.trim()] = v
  return out
}

export function KeyValueEditor({
  rows,
  onChange,
  reveal,
  keyPlaceholder = 'NAME',
  valuePlaceholder = 'value',
  addLabel,
  emptyText,
  disabled,
  ...rest
}: {
  rows: Rows
  onChange: (rows: Rows) => void
  /** Show the values. Off = masked. */
  reveal: boolean
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel: string
  emptyText: string
  disabled?: boolean
  'aria-label': string
}): JSX.Element {
  const label = rest['aria-label']
  const set = (i: number, col: 0 | 1, v: string): void => onChange(rows.map((r, j) => (j === i ? (col === 0 ? [v, r[1]] : [r[0], v]) : r)))
  return (
    <div className="ext-kv" role="group" aria-label={label}>
      {rows.length === 0 ? <p className="ext-kv__empty">{emptyText}</p> : null}
      {rows.map(([k, v], i) => (
        <div key={i} className="ext-kv__row">
          <input
            className="ext-input"
            aria-label={`${label}: name ${i + 1}`}
            value={k}
            placeholder={keyPlaceholder}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => set(i, 0, e.target.value)}
          />
          <input
            className="ext-input"
            aria-label={`${label}: value ${i + 1}`}
            type={reveal ? 'text' : 'password'}
            value={v}
            placeholder={valuePlaceholder}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => set(i, 1, e.target.value)}
          />
          <IconButton aria-label={`Remove ${k || `row ${i + 1}`}`} icon={<X />} disabled={disabled} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      {disabled ? null : (
        <div>
          <Button variant="secondary" icon={<Plus size={14} />} onClick={() => onChange([...rows, ['', '']])}>
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  )
}

export function ListEditor({
  items,
  onChange,
  placeholder,
  addLabel,
  emptyText,
  disabled,
  ...rest
}: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder?: string
  addLabel: string
  emptyText: string
  disabled?: boolean
  'aria-label': string
}): JSX.Element {
  const label = rest['aria-label']
  return (
    <div className="ext-kv" role="group" aria-label={label}>
      {items.length === 0 ? <p className="ext-kv__empty">{emptyText}</p> : null}
      {items.map((a, i) => (
        <div key={i} className="ext-kv__row ext-kv__row--list">
          <input
            className="ext-input"
            aria-label={`${label} ${i + 1}`}
            value={a}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <IconButton aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} icon={<X />} disabled={disabled} onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      {disabled ? null : (
        <div>
          <Button variant="secondary" icon={<Plus size={14} />} onClick={() => onChange([...items, ''])}>
            {addLabel}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Lines of an `ext-card` with a tab strip. */
export function TabCard({ children }: { children: ReactNode }): JSX.Element {
  return <div className="ext-card">{children}</div>
}
