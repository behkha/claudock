import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import type { RuleDoc, RuleItem } from '@shared/api/rules'
import { splitFrontmatter } from '@shared/frontmatter'
import { Badge, Button, CodeEditor, ConfirmDialog, DetailPane, EmptyState, MarkdownView, Segmented, Spinner, useToast } from '@/components'
import { api } from '@/lib/api'
import { PromptDialog } from './PromptDialog'
import { clearDraft, getDraft, setDraft } from './store'

type Mode = 'edit' | 'preview'

export interface RuleDetailProps {
  item: RuleItem
  /** Refresh the list (sizes, subtitles) and optionally select another item. */
  onChanged: (selectId?: string) => void
  /** Bumped by the parent when the list should re-check this file (window focus). */
  focusTick: number
  /** The draft changed (so the list can show its unsaved dot). */
  onDraft: () => void
}

export function RuleDetail({ item, onChanged, focusTick, onDraft }: RuleDetailProps): JSX.Element {
  const toast = useToast()
  const [doc, setDoc] = useState<RuleDoc | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('edit')
  const [, setTick] = useState(0)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [trashing, setTrashing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [disk, setDisk] = useState<RuleDoc | null>(null)

  const id = item.id
  const load = useCallback(async (): Promise<RuleDoc | undefined> => {
    setError(null)
    try {
      const d = await api.rules.read(id)
      setDoc(d)
      setDisk(null)
      return d
    } catch (e) {
      setError((e as Error).message)
      return undefined
    }
  }, [id])

  useEffect(() => {
    setDoc(undefined)
    setMode('edit')
    void load()
  }, [load])

  // window focus: has the file changed on disk?
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    api.rules.read(id).then(
      (d) => setDisk(d),
      () => undefined
    )
  }, [focusTick, id])

  const base = doc?.text ?? ''
  const entry = getDraft(id)
  const text = entry?.text ?? base
  const dirty = !!doc && !!entry && entry.text !== base
  const diskChanged = !!doc && !!disk && disk.mtimeMs !== doc.mtimeMs
  const baseMoved = !!doc && !!entry && entry.baseMtime !== doc.mtimeMs
  const stale = diskChanged || baseMoved
  const canSave = !!doc && dirty && !saving && !stale

  useEffect(() => {
    if (doc && entry && entry.text === base) {
      clearDraft(id)
      setTick((t) => t + 1)
    }
  }, [doc, entry, base, id])

  function edit(next: string): void {
    if (!doc) return
    if (next === base) clearDraft(id)
    else setDraft(id, { text: next, baseMtime: entry?.baseMtime ?? doc.mtimeMs })
    setTick((t) => t + 1)
    onDraft()
  }

  async function save(): Promise<void> {
    if (!canSave || !entry || !doc) return
    setSaving(true)
    try {
      await api.rules.save(id, text, entry.baseMtime)
      clearDraft(id)
      await load()
      onChanged()
      onDraft()
      toast(doc.missing ? `Created ${item.fileName}.` : `Saved ${item.fileName}. Snapshot kept in Backups.`, { kind: 'success' })
    } catch (e) {
      const m = (e as Error).message
      if (m.startsWith('CHANGED_ON_DISK')) {
        setDisk(await api.rules.read(id).catch(() => null))
        toast(`${item.fileName} changed on disk. Nothing was written.`, { kind: 'error' })
      } else toast(m, { kind: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const saveRef = useRef(save)
  saveRef.current = save
  const editorSave = useCallback(() => void saveRef.current(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.key.toLowerCase() !== 's' || e.altKey || e.shiftKey) return
      if (!(window.claudock.platform === 'darwin' ? e.metaKey : e.ctrlKey)) return
      e.preventDefault()
      void saveRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  async function reloadFromDisk(): Promise<void> {
    clearDraft(id)
    await load()
    onChanged()
  }
  async function keepMine(): Promise<void> {
    const d = await load()
    const cur = getDraft(id)
    if (d && cur) setDraft(id, { ...cur, baseMtime: d.mtimeMs })
    setTick((t) => t + 1)
  }

  const fm = useMemo(() => splitFrontmatter(text).raw, [text])
  const isRule = item.kind === 'rule'

  if (error && !doc) return <EmptyState title={`Could not read ${item.fileName}`} description={error} action={<Button onClick={() => void load()}>Try again</Button>} />
  if (!doc) {
    return (
      <div className="rl-center">
        <Spinner />
      </div>
    )
  }

  return (
    <>
      <DetailPane
        title={item.fileName}
        path={doc.path}
        reveal={id}
        badges={
          <>
            {doc.missing ? <Badge>Not created</Badge> : doc.size === 0 && !dirty ? <Badge tone="oat">Empty</Badge> : null}
            {dirty ? <Badge tone="accent">Unsaved</Badge> : null}
          </>
        }
        actions={
          <>
            <Segmented<Mode>
              aria-label="Editor mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'edit', label: 'Edit' },
                { value: 'preview', label: 'Preview' }
              ]}
            />
            <Button variant="primary" onClick={() => void save()} disabled={!canSave} loading={saving} title="Save (⌘S / Ctrl+S)">
              Save
            </Button>
            {isRule ? (
              <Button icon={<Pencil />} onClick={() => setRenaming(true)} disabled={dirty} title={dirty ? 'Save or undo your edits first' : undefined}>
                Rename
              </Button>
            ) : null}
            <Button icon={<FolderOpen />} onClick={() => api.system.reveal(id).catch((e: Error) => toast(e.message, { kind: 'error' }))} disabled={doc.missing}>
              Reveal
            </Button>
            {isRule ? (
              <Button variant="danger" icon={<Trash2 />} onClick={() => setTrashing(true)}>
                Move to Trash
              </Button>
            ) : null}
          </>
        }
      >
        {stale ? (
          <div className="rl-banner" role="alert">
            <AlertTriangle size={16} strokeWidth={1.8} aria-hidden />
            <span className="rl-banner__text">
              {item.fileName} changed on disk{dirty ? ' after you started editing' : ''}.{' '}
              {dirty ? 'Saving is paused until you choose. Keeping your edits will overwrite the newer file.' : 'Reload to see the new content.'}
            </span>
            {dirty ? (
              <>
                <Button onClick={() => void reloadFromDisk()}>Reload and drop my edits</Button>
                <Button onClick={() => void keepMine()}>Keep my edits</Button>
              </>
            ) : (
              <Button onClick={() => void reloadFromDisk()}>Reload</Button>
            )}
          </div>
        ) : null}

        {mode === 'edit' ? (
          <div className="rl-editor">
            {text.trim() === '' ? (
              <p className="rl-hint">
                {item.kind === 'claude'
                  ? 'CLAUDE.md is empty. Claude Code reads it at the start of every session, so anything you write here applies to all your projects.'
                  : 'This rule is empty.'}
              </p>
            ) : null}
            <CodeEditor aria-label={`${item.fileName} as Markdown`} language="markdown" value={text} onChange={edit} onSave={editorSave} height="calc(100vh - 360px)" minHeight={280} />
          </div>
        ) : text.trim() === '' ? (
          <p className="rl-hint">Nothing to preview yet.</p>
        ) : (
          <>
            {fm ? (
              <div className="rl-frontmatter">
                <span className="rl-frontmatter__label">Frontmatter</span>
                <pre className="rl-frontmatter__body selectable">{fm}</pre>
              </div>
            ) : null}
            <MarkdownView source={text} />
          </>
        )}
      </DetailPane>

      <PromptDialog
        open={renaming}
        title={`Rename ${item.fileName}`}
        label="New name"
        initial={item.name.split('/').pop() ?? item.name}
        hint="Letters, numbers, spaces, dots, dashes and underscores. The .md ending is added for you."
        confirmLabel="Rename"
        onCancel={() => setRenaming(false)}
        onSubmit={async (v) => {
          const renamed = await api.rules.rename(id, v)
          setRenaming(false)
          toast(`Renamed to ${renamed.fileName}.`, { kind: 'success' })
          onChanged(renamed.id)
        }}
      />

      <ConfirmDialog
        open={trashing}
        busy={busy}
        tone="danger"
        title={`Move ${item.fileName} to the Trash?`}
        description={<p>The rule stops applying in every session. You can put it back from the Trash.</p>}
        confirmLabel="Move to Trash"
        onCancel={() => setTrashing(false)}
        onConfirm={() => {
          setBusy(true)
          api.rules
            .trash(id)
            .then(() => {
              clearDraft(id)
              setTrashing(false)
              toast(`Moved ${item.fileName} to the Trash.`, { kind: 'success' })
              onChanged('CLAUDE.md')
            })
            .catch((e: Error) => toast(e.message, { kind: 'error' }))
            .finally(() => setBusy(false))
        }}
      />
    </>
  )
}
