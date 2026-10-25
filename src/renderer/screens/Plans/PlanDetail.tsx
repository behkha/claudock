import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, FolderOpen, Save, Trash2 } from 'lucide-react'
import type { PlanInfo } from '@shared/api/plans'
import { formatBytes, formatDateTime, tildify } from '@shared/format'
import { Badge, Button, CodeEditor, ConfirmDialog, DetailPane, MarkdownView, Segmented, Spinner, useToast } from '@/components'
import { api, useApi } from '@/lib/api'
import { useNavGuard } from '@/lib/nav'

interface Props {
  plan: PlanInfo
  onDirtyChange: (dirty: boolean) => void
  onSaved: () => void
  onTrashed: () => void
}

export function PlanDetail({ plan, onDirtyChange, onSaved, onTrashed }: Props): JSX.Element {
  const toast = useToast()
  const [saved, setSaved] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  // mtime of the content the editor started from (sent with Save), and the newest mtime seen on disk
  const [baseMtime, setBaseMtime] = useState(0)
  const [diskMtime, setDiskMtime] = useState<number | null>(null)
  const cfg = useApi(() => api.system.configInfo(), [])
  const absPath = cfg.data ? tildify(`${cfg.data.configDir}${cfg.data.sep}${plan.rel}`, cfg.data.home) : plan.rel

  const load = useCallback(() => {
    setError(null)
    return api.plans.read(plan.rel).then(
      (r) => {
        setSaved(r.text)
        setText(r.text)
        setBaseMtime(r.mtimeMs)
        setDiskMtime(null)
      },
      (e: Error) => setError(e.message)
    )
  }, [plan.rel])

  useEffect(() => {
    setSaved(null)
    setMode('preview')
    void load()
  }, [load])

  const dirty = saved !== null && text !== saved
  useNavGuard(dirty)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  // Claude Code rewrites plan files: when the window regains focus, check whether this one changed on disk
  useEffect(() => {
    const check = (): void => {
      api.plans.read(plan.rel).then(
        (d) => setDiskMtime(d.mtimeMs),
        () => undefined
      )
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [plan.rel])
  const stale = saved !== null && diskMtime !== null && diskMtime !== baseMtime
  // nothing to lose: show the new content straight away
  useEffect(() => {
    if (stale && !dirty) void load()
  }, [stale, dirty, load])

  const save = useCallback(async () => {
    if (!dirty || stale) return
    setSaving(true)
    try {
      await api.plans.save(plan.rel, text, baseMtime)
      toast('Saved. Snapshot kept in Backups.', { kind: 'success' })
      await load()
      onSaved()
    } catch (e) {
      const m = (e as Error).message
      if (m.startsWith('CHANGED_ON_DISK')) {
        setDiskMtime((await api.plans.read(plan.rel).catch(() => null))?.mtimeMs ?? null)
        toast(`${plan.file} changed on disk. Nothing was written.`, { kind: 'error' })
      } else toast(m, { kind: 'error' })
    } finally {
      setSaving(false)
    }
  }, [dirty, stale, plan.rel, plan.file, text, baseMtime, toast, load, onSaved])
  const saveRef = useRef(save)
  saveRef.current = save
  const onEditorSave = useCallback(() => void saveRef.current(), [])

  // Cmd+S / Ctrl+S works wherever the focus is, not only inside the editor
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
    await load()
    onSaved()
  }
  function keepMine(): void {
    if (diskMtime !== null) setBaseMtime(diskMtime)
    setDiskMtime(null)
  }

  async function trash(): Promise<void> {
    setBusy(true)
    try {
      await api.plans.trash(plan.rel)
      toast('Moved to Trash.', { kind: 'success' })
      onDirtyChange(false)
      onTrashed()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  return (
    <>
      <DetailPane
        title={plan.title}
        path={absPath}
        reveal={plan.rel}
        badges={<Badge tone="oat">{formatBytes(plan.bytes)}</Badge>}
        actions={
          <>
            {mode === 'edit' || dirty ? (
              <Button variant="primary" icon={<Save size={15} />} onClick={() => void save()} loading={saving} disabled={!dirty || stale} title="Save (⌘S / Ctrl+S)">
                Save
              </Button>
            ) : null}
            <Button icon={<FolderOpen size={15} />} onClick={() => api.system.reveal(plan.rel).catch((e: Error) => toast(e.message, { kind: 'error' }))}>
              Reveal
            </Button>
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirm(true)}>
              Move to Trash
            </Button>
            {dirty ? <span className="pln-dirty">Unsaved changes</span> : null}
          </>
        }
      >
        {error ? (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        ) : saved === null ? (
          <Spinner />
        ) : (
          <>
            {stale ? (
              <div className="pln-banner" role="alert">
                <AlertTriangle size={16} strokeWidth={1.8} aria-hidden />
                <span className="pln-banner__text">
                  {plan.file} changed on disk after you started editing. Saving is paused until you choose. Keeping your edits will overwrite the
                  newer file (the newer version stays in Backups).
                </span>
                <Button onClick={() => void reloadFromDisk()}>Reload and drop my edits</Button>
                <Button onClick={keepMine}>Keep my edits</Button>
              </div>
            ) : null}
            <div className="pln-tabs">
              <Segmented
                aria-label="Plan view"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'preview', label: 'Preview' },
                  { value: 'edit', label: 'Edit' }
                ]}
              />
              <span className="pln-tabs__hint">{mode === 'edit' ? 'Press Cmd+S or Ctrl+S to save' : `Modified ${formatDateTime(plan.mtimeMs)}`}</span>
            </div>
            {mode === 'edit' ? (
              <div className="pln-editor">
                <CodeEditor aria-label="Plan text" language="markdown" value={text} onChange={setText} minHeight={360} onSave={onEditorSave} />
              </div>
            ) : (
              <div className="pln-preview">
                <MarkdownView source={text} />
              </div>
            )}
          </>
        )}
      </DetailPane>
      <ConfirmDialog
        open={confirm}
        tone="danger"
        busy={busy}
        title="Move this plan to Trash?"
        description={
          <p>
            <code>{plan.file}</code> goes to the Trash. Claude Code writes a new plan file each time you use plan mode, so nothing else depends on it.
          </p>
        }
        confirmLabel="Move to Trash"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void trash()}
      />
    </>
  )
}
