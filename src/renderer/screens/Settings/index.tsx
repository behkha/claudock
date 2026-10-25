import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, FilePlus } from 'lucide-react'
import { SETTINGS_FILES, type SettingsDoc, type SettingsFileName, type SettingsSummary } from '@shared/api/settings'
import type { ScreenId } from '@shared/nav'
import { Button, CodeEditor, ConfirmDialog, EmptyState, PageLayout, PathLabel, Segmented, Spinner, useToast } from '@/components'
import { api } from '@/lib/api'
import { useNav, type ScreenProps } from '@/lib/nav'
import { FormView, formShowsKey } from './FormView'
import { HistoryView } from './HistoryView'
import { checkSettingsJson, describeProblem, parseObject, type JsonObject } from './json'
import { clearDraft, getDraft, setDraft } from './store'
import './settings.css'

type View = 'form' | 'json' | 'history'

const SUBTITLE: Record<SettingsFileName, string> = {
  'settings.json': 'User settings · applies to every project',
  'settings.local.json': 'Local settings · this machine only'
}

/**
 * Palette ids are `<file>:<key path>` (e.g. `settings.local.json:permissions.defaultMode`). A bare file name
 * (used by the Permissions screen's "Open Settings") selects just the file.
 */
function parseTarget(id: string | undefined): { file?: SettingsFileName; key?: string } {
  if (!id) return {}
  const file = SETTINGS_FILES.find((f) => id === f || id.startsWith(`${f}:`))
  if (!file) return {}
  return { file, key: id.length > file.length ? id.slice(file.length + 1) : undefined }
}

function Banner({ tone = 'info', children, actions }: { tone?: 'info' | 'warn'; children: ReactNode; actions?: ReactNode }): JSX.Element {
  return (
    <div className={`st-banner st-banner--${tone}`} role={tone === 'warn' ? 'alert' : 'status'}>
      {tone === 'warn' ? <AlertTriangle size={16} strokeWidth={1.8} aria-hidden /> : <FilePlus size={16} strokeWidth={1.8} aria-hidden />}
      <div className="st-banner__text">{children}</div>
      {actions ? <div className="st-banner__actions">{actions}</div> : null}
    </div>
  )
}

export default function SettingsScreen({ selectId }: ScreenProps): JSX.Element {
  const toast = useToast()
  const { navigate, seq: navSeq } = useNav()
  const [file, setFile] = useState<SettingsFileName>(() => parseTarget(selectId).file ?? 'settings.json')
  // a palette result for a key: where to scroll / highlight (form) or place the cursor (JSON)
  const [want, setWant] = useState<{ key: string; nonce: number } | null>(() => {
    const k = parseTarget(selectId).key
    return k ? { key: k, nonce: navSeq } : null
  })
  const [revealOffset, setRevealOffset] = useState<number | null>(null)
  const [view, setView] = useState<View>('form')
  const [doc, setDoc] = useState<SettingsDoc | undefined>()
  const [loadError, setLoadError] = useState<string | null>(null)
  const [summary, setSummary] = useState<SettingsSummary | undefined>()
  const [disk, setDisk] = useState<{ file: SettingsFileName; mtimeMs: number | null } | null>(null)
  const [, setTick] = useState(0)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [saving, setSaving] = useState(false)
  const [leaveTo, setLeaveTo] = useState<ScreenId | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const t = parseTarget(selectId)
    if (t.file) setFile(t.file)
    setWant((w) => (t.key ? (w && w.key === t.key && w.nonce === navSeq ? w : { key: t.key, nonce: navSeq }) : null))
  }, [selectId, navSeq])

  const load = useCallback(async (f: SettingsFileName): Promise<SettingsDoc | undefined> => {
    const id = ++seq.current
    setLoadError(null)
    try {
      const d = await api.settings.read(f)
      if (id !== seq.current) return undefined
      setDoc(d)
      setDisk(null)
      api.settings.summary(f).then(
        (s) => id === seq.current && setSummary(s),
        () => undefined
      )
      return d
    } catch (e) {
      if (id === seq.current) setLoadError((e as Error).message)
      return undefined
    }
  }, [])

  useEffect(() => {
    setDoc(undefined)
    setSummary(undefined)
    void load(file)
  }, [file, load])

  /* ---------------------------------------------------------------- derived state */
  const ready = !!doc && doc.file === file
  const baseText = ready && doc.exists ? doc.text : '{}\n'
  const entry = getDraft(file)
  const draft = entry?.text ?? baseText
  const dirty = ready && !!entry && entry.text !== baseText
  const problem = useMemo(() => checkSettingsJson(draft), [draft])
  const obj = useMemo<JsonObject | null>(() => parseObject(draft), [draft])
  const diskChanged = ready && disk?.file === file && disk.mtimeMs !== doc.mtimeMs
  const baseMoved = ready && !!entry && entry.baseMtime !== doc.mtimeMs
  const stale = diskChanged || baseMoved
  const canSave = ready && dirty && !problem && !saving && !stale
  const dirtyFiles = SETTINGS_FILES.filter((f) => getDraft(f))

  // apply a palette target once the right file is loaded: highlight the field, or open the JSON at the key
  useEffect(() => {
    if (!want || !ready) return
    const top = want.key.split('.')[0]
    if (obj && formShowsKey(obj, top)) {
      setView('form')
      setRevealOffset(null)
    } else {
      setView('json')
      const at = draft.indexOf(`\n  "${top}"`)
      const any = at >= 0 ? at + 1 : draft.indexOf(`"${top}"`)
      setRevealOffset(any >= 0 ? any : null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, ready])

  // a restored draft that now equals the file on disk is no longer a draft
  useEffect(() => {
    if (ready && entry && entry.text === baseText) {
      clearDraft(file)
      setTick((t) => t + 1)
    }
  }, [ready, entry, baseText, file])

  /* ---------------------------------------------------------------- external changes */
  useEffect(() => {
    const check = (): void => {
      if (document.visibilityState === 'hidden') return
      api.settings.stat(file).then(
        (s) => setDisk({ file, mtimeMs: s.mtimeMs }),
        () => undefined
      )
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [file])

  /* ---------------------------------------------------------------- editing */
  function applyText(text: string): void {
    if (!ready) return
    if (text === baseText) clearDraft(file)
    else setDraft(file, { text, baseMtime: entry?.baseMtime ?? doc.mtimeMs })
    setTick((t) => t + 1)
  }

  function applyObject(next: JsonObject): void {
    const base = parseObject(baseText)
    if (base && JSON.stringify(base) === JSON.stringify(next)) applyText(baseText)
    else applyText(JSON.stringify(next, null, 2) + '\n')
  }

  async function reload(): Promise<void> {
    clearDraft(file)
    await load(file)
    setHistoryVersion((v) => v + 1)
  }

  async function keepMine(): Promise<void> {
    const d = await load(file)
    const cur = getDraft(file)
    if (d && cur) setDraft(file, { ...cur, baseMtime: d.mtimeMs })
    setTick((t) => t + 1)
  }

  async function save(): Promise<void> {
    if (!canSave || !entry) return
    setSaving(true)
    try {
      const res = await api.settings.save(file, draft, entry.baseMtime)
      clearDraft(file)
      await load(file)
      setHistoryVersion((v) => v + 1)
      toast(res.snapshotId ? `Saved ${file}. Snapshot kept in Backups.` : `Saved ${file}. It is a new file, so there was nothing to snapshot.`, { kind: 'success' })
    } catch (e) {
      const m = (e as Error).message
      if (m.startsWith('CHANGED_ON_DISK')) {
        const s = await api.settings.stat(file).catch(() => null)
        if (s) setDisk({ file, mtimeMs: s.mtimeMs })
        toast(`${file} changed on disk. Nothing was written.`, { kind: 'error' })
      } else toast(m, { kind: 'error' })
    } finally {
      setSaving(false)
    }
  }

  async function restore(id: string, label: string): Promise<void> {
    try {
      await api.settings.restore(file, id)
      clearDraft(file)
      await load(file)
      setHistoryVersion((v) => v + 1)
      toast(`Restored ${file} from ${label}. Snapshot kept in Backups.`, { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    }
  }

  const saveRef = useRef(save)
  saveRef.current = save
  const editorSave = useCallback(() => void saveRef.current(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.key.toLowerCase() !== 's' || e.altKey || e.shiftKey) return
      const mod = window.claudock.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (!mod) return
      e.preventDefault()
      void saveRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /* ---------------------------------------------------------------- navigation */
  function go(screen: ScreenId): void {
    if (dirtyFiles.length > 0) setLeaveTo(screen)
    else navigate(screen)
  }

  /* ---------------------------------------------------------------- render */
  if (loadError && !ready) {
    return (
      <EmptyState
        title={`Could not read ${file}`}
        description={loadError}
        action={<Button onClick={() => void load(file)}>Try again</Button>}
      />
    )
  }
  if (!ready) {
    return (
      <div className="st-center st-center--page">
        <Spinner />
      </div>
    )
  }

  const fileOptions = SETTINGS_FILES.map((f) => ({
    value: f,
    label: (
      <>
        {f}
        {getDraft(f) ? <span className="st-dot" role="img" aria-label="unsaved changes" /> : null}
      </>
    )
  }))

  return (
    <PageLayout
      title={file}
      description={
        <>
          {SUBTITLE[file]}
          <span className="st-pathline">
            <PathLabel path={doc.path} />
          </span>
        </>
      }
      actions={
        <>
          <Segmented<SettingsFileName> aria-label="Settings file" options={fileOptions} value={file} onChange={setFile} />
          <Button variant="primary" onClick={() => void save()} disabled={!canSave} loading={saving} title={`Save (${window.claudock.platform === 'darwin' ? '⌘S' : 'Ctrl+S'})`}>
            Save
          </Button>
        </>
      }
      toolbar={
        <div className="st-toolbar">
          <Segmented<View>
            aria-label="View"
            value={view}
            onChange={setView}
            options={[
              { value: 'form', label: 'Form' },
              { value: 'json', label: 'JSON' },
              { value: 'history', label: 'History' }
            ]}
          />
          <span className="st-status" aria-live="polite">
            {dirty ? 'Unsaved changes' : ''}
          </span>
        </div>
      }
    >
      {diskChanged || baseMoved ? (
        <Banner
          tone="warn"
          actions={
            dirty ? (
              <>
                <Button onClick={() => void reload()}>Reload and drop my edits</Button>
                <Button onClick={() => void keepMine()}>Keep my edits</Button>
              </>
            ) : (
              <Button onClick={() => void reload()}>Reload</Button>
            )
          }
        >
          {file} changed on disk{dirty ? ' after you started editing' : ''}.{' '}
          {dirty ? 'Saving is paused until you choose. Keeping your edits will overwrite the newer file.' : 'Reload to see the new content.'}
        </Banner>
      ) : null}

      {!doc.exists ? (
        <Banner>{file} does not exist yet. It is created when you save.</Banner>
      ) : null}

      {view === 'form' ? (
        obj ? (
          <FormView obj={obj} onChange={applyObject} summary={summary} onOpen={go} onEditJson={() => setView('json')} focusKey={want} />
        ) : (
          <Banner
            tone="warn"
            actions={<Button onClick={() => setView('json')}>Open JSON view</Button>}
          >
            {problem ? describeProblem(problem) : 'This file is not a JSON object.'} The form is off until the JSON is valid.
          </Banner>
        )
      ) : null}

      {view === 'json' ? (
        <div className="st-json">
          <CodeEditor
            aria-label={`${file} as JSON`}
            language="json"
            value={draft}
            onChange={applyText}
            onSave={editorSave}
            revealOffset={revealOffset}
            height="calc(100vh - 380px)"
            minHeight={320}
          />
          {problem ? (
            <p className="st-error" role="alert">
              {describeProblem(problem)}
            </p>
          ) : (
            <p className="st-muted">Valid JSON. Comments and trailing commas are not allowed.</p>
          )}
        </div>
      ) : null}

      {view === 'history' ? (
        <HistoryView file={file} current={doc.exists ? doc.text : ''} dirty={dirty} version={historyVersion} onRestore={restore} />
      ) : null}

      <ConfirmDialog
        open={leaveTo !== null}
        title="Leave with unsaved changes?"
        description={
          <p>
            {dirtyFiles.join(' and ')} {dirtyFiles.length > 1 ? 'have' : 'has'} edits that are not saved. The Hooks, Permissions, Skills and Plugins screens write to the same files, so the edits would be out of date.
          </p>
        }
        confirmLabel="Discard and leave"
        cancelLabel="Keep editing"
        tone="danger"
        onCancel={() => setLeaveTo(null)}
        onConfirm={() => {
          const to = leaveTo
          dirtyFiles.forEach(clearDraft)
          setLeaveTo(null)
          if (to) navigate(to)
        }}
      />
    </PageLayout>
  )
}
