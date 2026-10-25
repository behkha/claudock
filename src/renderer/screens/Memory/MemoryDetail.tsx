import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Save, Trash2 } from 'lucide-react'
import type { MemoryFileContent, MemoryFileInfo } from '@shared/api/memory'
import { tildify } from '@shared/format'
import {
  Badge,
  Button,
  CodeEditor,
  ConfirmDialog,
  DetailPane,
  MarkdownView,
  Segmented,
  Select,
  Spinner,
  TextField,
  useToast
} from '@/components'
import { api, useApi } from '@/lib/api'
import { useNavGuard } from '@/lib/nav'

const TYPES = ['user', 'feedback', 'project', 'reference']

interface Props {
  info: MemoryFileInfo
  projectName: string
  onDirtyChange: (dirty: boolean) => void
  onSaved: () => void
  onTrashed: () => void
}

export function MemoryDetail({ info, projectName, onDirtyChange, onSaved, onTrashed }: Props): JSX.Element {
  const toast = useToast()
  const [file, setFile] = useState<MemoryFileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('')
  const [body, setBody] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [dropLine, setDropLine] = useState(true)
  const [busy, setBusy] = useState(false)
  // mtime of the content the editor started from (sent with Save), and the newest read of the file on disk
  const [baseMtime, setBaseMtime] = useState(0)
  const [disk, setDisk] = useState<MemoryFileContent | null>(null)
  const cfg = useApi(() => api.system.configInfo(), [])
  const absPath = cfg.data ? tildify(`${cfg.data.configDir}${cfg.data.sep}${info.rel}`, cfg.data.home) : info.rel

  const load = useCallback(() => {
    setError(null)
    return api.memory.read(info.rel).then(
      (f) => {
        setFile(f)
        setBaseMtime(f.mtimeMs)
        setDisk(null)
        setName(f.name)
        setDescription(f.description)
        setType(f.type)
        setBody(f.body)
      },
      (e: Error) => setError(e.message)
    )
  }, [info.rel])

  useEffect(() => {
    setFile(null)
    setMode('preview')
    void load()
  }, [load])

  const dirty = !!file && (name !== file.name || description !== file.description || type !== file.type || body !== file.body)
  useNavGuard(dirty)
  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  // Claude Code writes memory files too: when the window regains focus, check whether this one changed on disk
  useEffect(() => {
    const check = (): void => {
      api.memory.read(info.rel).then(
        (d) => setDisk(d),
        () => undefined
      )
    }
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [info.rel])
  const stale = !!file && !!disk && disk.mtimeMs !== baseMtime
  // nothing to lose: show the new content straight away
  useEffect(() => {
    if (stale && !dirty) void load()
  }, [stale, dirty, load])

  const save = useCallback(async () => {
    if (!file || !dirty || stale) return
    setSaving(true)
    try {
      await api.memory.save(info.rel, { name, description, type }, body, baseMtime)
      toast('Saved. Snapshot kept in Backups.', { kind: 'success' })
      await load()
      onSaved()
    } catch (e) {
      const m = (e as Error).message
      if (m.startsWith('CHANGED_ON_DISK')) {
        setDisk(await api.memory.read(info.rel).catch(() => null))
        toast(`${info.file} changed on disk. Nothing was written.`, { kind: 'error' })
      } else toast(m, { kind: 'error' })
    } finally {
      setSaving(false)
    }
  }, [file, dirty, stale, info.rel, info.file, name, description, type, body, baseMtime, toast, load, onSaved])
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
    if (disk) setBaseMtime(disk.mtimeMs)
    setDisk(null)
  }

  const typeOptions = useMemo(() => {
    const opts = TYPES.map((t) => ({ value: t, label: t }))
    if (type && !TYPES.includes(type)) opts.push({ value: type, label: type })
    return [{ value: '', label: 'Not set' }, ...opts]
  }, [type])

  async function trash(): Promise<void> {
    setBusy(true)
    try {
      await api.memory.trash(info.rel, !!file?.indexed && dropLine)
      toast(file?.indexed && dropLine ? 'Moved to Trash. Line removed from MEMORY.md.' : 'Moved to Trash.', { kind: 'success' })
      onDirtyChange(false)
      onTrashed()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
      setConfirm(false)
    }
  }

  if (error) {
    return (
      <DetailPane title={info.title} path={absPath} reveal={info.rel}>
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      </DetailPane>
    )
  }
  if (!file) {
    return (
      <DetailPane title={info.title} path={absPath} reveal={info.rel}>
        <Spinner />
      </DetailPane>
    )
  }

  return (
    <>
      <DetailPane
        title={info.isIndex ? 'MEMORY.md' : file.name || info.title}
        path={absPath}
        reveal={info.rel}
        badges={
          <>
            <Badge tone="oat">{projectName}</Badge>
            {info.isIndex ? <Badge>Index</Badge> : file.type ? <Badge>{file.type}</Badge> : null}
          </>
        }
        actions={
          <>
            <Button variant="primary" icon={<Save size={15} />} onClick={() => void save()} loading={saving} disabled={!dirty || stale} title="Save (⌘S / Ctrl+S)">
              Save
            </Button>
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setConfirm(true)}>
              Move to Trash
            </Button>
            {dirty ? <span className="mem-dirty">Unsaved changes</span> : null}
          </>
        }
      >
        {stale ? (
          <div className="mem-banner" role="alert">
            <AlertTriangle size={16} strokeWidth={1.8} aria-hidden />
            <span className="mem-banner__text">
              {info.file} changed on disk after you started editing. Saving is paused until you choose. Keeping your edits will overwrite the newer file
              (the newer version stays in Backups).
            </span>
            <Button onClick={() => void reloadFromDisk()}>Reload and drop my edits</Button>
            <Button onClick={keepMine}>Keep my edits</Button>
          </div>
        ) : null}
        {info.isIndex ? (
          <p className="mem-note">This index lists one line per memory file in this project. Claude reads it at the start of a session.</p>
        ) : (
          <div className="mem-form">
            <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Select label="Type" value={type} onChange={setType} options={typeOptions} />
            <TextField
              className="mem-form__wide"
              label="Description"
              multiline
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              hint="One line. Claude uses it to decide when this memory is relevant."
            />
          </div>
        )}
        <div className="mem-tabs">
          <Segmented
            aria-label="Body view"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'preview', label: 'Preview' },
              { value: 'edit', label: 'Edit' }
            ]}
          />
          <span className="mem-tabs__hint">{mode === 'edit' ? 'Press Cmd+S or Ctrl+S to save' : null}</span>
        </div>
        {mode === 'edit' ? (
          <div className="mem-editor">
            <CodeEditor aria-label="Memory body" language="markdown" value={body} onChange={setBody} minHeight={260} onSave={onEditorSave} />
          </div>
        ) : (
          <div className="mem-preview">
            {body.trim() ? <MarkdownView source={body} stripFrontmatter={false} /> : <p className="mem-note">This file has no body.</p>}
          </div>
        )}
      </DetailPane>
      <ConfirmDialog
        open={confirm}
        tone="danger"
        busy={busy}
        title="Move this memory to Trash?"
        description={
          <>
            <p>
              <code>{info.file}</code> goes to the Trash. Claude will stop using it in this project.
            </p>
            {file.indexed ? (
              <label className="mem-check">
                <input type="checkbox" checked={dropLine} onChange={(e) => setDropLine(e.target.checked)} />
                <span>Also remove its line from MEMORY.md</span>
              </label>
            ) : null}
          </>
        }
        confirmLabel="Move to Trash"
        onCancel={() => setConfirm(false)}
        onConfirm={() => void trash()}
      />
    </>
  )
}
