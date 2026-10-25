import { useEffect, useState, type ReactNode } from 'react'
import type { SaveResult } from '@shared/api/skills'
import { Button, CodeEditor } from '@/components'
import { MarkdownPane, Tabs, useNotify, useSaveShortcut } from './ui'
import { useNavGuard } from '@/lib/nav'

export interface EditableDoc<F> {
  text: string
  body: string
  fields: F
  extra: Record<string, string | string[]>
  mtimeMs: number
  truncated: boolean
}

/**
 * Editor for a Markdown file with frontmatter (agents, commands): a form for the known keys plus the body, or the
 * whole file as text. Unknown frontmatter keys are never touched by the form (the main process rewrites only the
 * keys that changed).
 */
export function DocEditor<F extends object>({
  doc,
  renderForm,
  validate,
  saveForm,
  saveRaw,
  onSaved,
  onDirty,
  bodyLabel,
  fileLabel
}: {
  doc: EditableDoc<F>
  renderForm: (fields: F, patch: (p: Partial<F>) => void, disabled: boolean) => ReactNode
  /** Return a message to block saving, or null. */
  validate?: (fields: F) => string | null
  saveForm: (fields: F, body: string, baseMtimeMs: number) => Promise<SaveResult>
  saveRaw: (text: string, baseMtimeMs: number) => Promise<SaveResult>
  onSaved: () => void
  onDirty: (dirty: boolean) => void
  bodyLabel: string
  fileLabel: string
}): JSX.Element {
  const notify = useNotify()
  const [mode, setMode] = useState<'form' | 'file'>('form')
  const [fields, setFields] = useState<F>(doc.fields)
  const [body, setBody] = useState(doc.body)
  const [raw, setRaw] = useState(doc.text)
  const [saving, setSaving] = useState(false)

  // a fresh copy of the file arrived (after a save or a reload): start from it
  useEffect(() => {
    setFields(doc.fields)
    setBody(doc.body)
    setRaw(doc.text)
  }, [doc])

  const formDirty = JSON.stringify(fields) !== JSON.stringify(doc.fields) || body !== doc.body
  const rawDirty = raw !== doc.text
  const dirty = formDirty || rawDirty
  useNavGuard(dirty)
  useEffect(() => {
    onDirty(dirty)
    return () => onDirty(false)
  }, [dirty, onDirty])

  const problem = mode === 'form' ? (validate?.(fields) ?? null) : null
  const readOnly = doc.truncated

  async function save(): Promise<void> {
    if (saving || problem || !dirty) return
    setSaving(true)
    try {
      const r = mode === 'form' ? await saveForm(fields, body, doc.mtimeMs) : await saveRaw(raw, doc.mtimeMs)
      notify.saved(r.snapshotId)
      onSaved()
    } catch (e) {
      notify.failed(e)
    } finally {
      setSaving(false)
    }
  }

  // ⌘S / Ctrl+S saves from anywhere on the screen while there are edits (editors handle it themselves when focused)
  useSaveShortcut(dirty && !readOnly, () => void save())

  function revert(): void {
    setFields(doc.fields)
    setBody(doc.body)
    setRaw(doc.text)
  }

  const extraKeys = Object.keys(doc.extra)

  return (
    <div className="ext-card">
      <Tabs
        label="Editor view"
        value={mode}
        onChange={setMode}
        tabs={[
          { value: 'form', label: 'Form', disabled: rawDirty, title: rawDirty ? 'Save or revert your edits to the full file first' : undefined },
          { value: 'file', label: 'Full file', disabled: formDirty, title: formDirty ? 'Save or revert your form edits first' : undefined }
        ]}
      />
      {mode === 'form' ? (
        <div className="ext-card__content ext-form">
          {readOnly ? <p className="ext-error">This file is larger than 1.5 MB, so it is shown but cannot be edited here.</p> : null}
          {renderForm(fields, (p) => setFields((f) => ({ ...f, ...p })), readOnly)}
          <div className="ext-field">
            <span className="ext-label">{bodyLabel}</span>
            <MarkdownPane label={bodyLabel} value={body} onChange={setBody} editable={!readOnly} onSave={() => void save()} stripFrontmatter={false} />
          </div>
          {extraKeys.length > 0 ? (
            <p className="ext-hint">
              Also in this file and left as it is: <span className="ext-mono">{extraKeys.join(', ')}</span>. Use Full file to change them.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="ext-card__content">
          <CodeEditor aria-label={fileLabel} language="markdown" value={raw} onChange={setRaw} onSave={() => void save()} readOnly={readOnly} minHeight={320} maxHeight={600} />
        </div>
      )}
      <div className="ext-savebar">
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || !!problem || readOnly}>
          Save
        </Button>
        <Button variant="secondary" onClick={revert} disabled={!dirty || saving}>
          Revert
        </Button>
        <span className={problem ? 'ext-error' : 'ext-savebar__status'} role={problem ? 'alert' : undefined}>
          {problem ?? (dirty ? 'Unsaved changes' : 'No changes')}
        </span>
      </div>
    </div>
  )
}
