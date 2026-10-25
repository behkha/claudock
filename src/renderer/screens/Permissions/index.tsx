import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import type { PermissionsData, RuleList } from '@shared/api/permissions'
import { SETTINGS_FILES, type SettingsFileName } from '@shared/api/settings'
import { Button, Card, ConfirmDialog, EmptyState, IconButton, PageLayout, Segmented, SearchField, Select, Spinner, TextField, useToast } from '@/components'
import { api } from '@/lib/api'
import { useNav, type ScreenProps } from '@/lib/nav'
import './permissions.css'

const FILE_LABEL: Record<SettingsFileName, string> = { 'settings.json': 'settings.json', 'settings.local.json': 'settings.local.json' }
const SUBTITLE: Record<SettingsFileName, string> = {
  'settings.json': 'User settings · applies to every project',
  'settings.local.json': 'Local settings · this machine only'
}

const MODES: Array<{ value: string; label: string; description: string }> = [
  { value: '', label: 'Not set', description: 'Claude Code uses its normal behaviour, the same as default.' },
  { value: 'default', label: 'default', description: 'Asks the first time Claude uses each tool, then remembers your answer for the session.' },
  { value: 'acceptEdits', label: 'acceptEdits', description: 'Edits files without asking. Running commands and other actions still ask.' },
  { value: 'plan', label: 'plan', description: 'Claude can read and plan, but cannot edit files or run commands until you approve the plan.' },
  { value: 'auto', label: 'auto', description: 'A safety check lets routine actions run and stops risky ones, so you are asked less often.' },
  { value: 'bypassPermissions', label: 'bypassPermissions', description: 'Skips every permission prompt. Claude can run any command and change any file.' }
]

interface ListDef {
  key: Exclude<RuleList, 'additionalDirectories'>
  title: string
  description: string
  placeholder: string
}

const LISTS: ListDef[] = [
  { key: 'allow', title: 'Allow', description: 'Runs without asking.', placeholder: 'Bash(npm run test:*)' },
  { key: 'ask', title: 'Ask', description: 'Always asks first, even in a mode that would not.', placeholder: 'Bash(git push:*)' },
  { key: 'deny', title: 'Deny', description: 'Blocked. Deny rules win over ask and allow.', placeholder: 'Read(./.env)' }
]

const LIST_NAME: Record<RuleList, string> = { allow: 'Allow', ask: 'Ask', deny: 'Deny', additionalDirectories: 'Directories' }

/* ------------------------------------------------------------------ one list card */

function RuleCard({
  title,
  description,
  placeholder,
  hint,
  rules,
  filter,
  moveTargets,
  conflictIn,
  onAdd,
  onRemove,
  onMove
}: {
  title: string
  description: string
  placeholder: string
  hint: string
  rules: string[]
  filter: string
  moveTargets: RuleList[]
  /** Other lists that already hold a rule with this text. */
  conflictIn: (rule: string) => RuleList[]
  onAdd: (rule: string) => Promise<string | void>
  onRemove: (rule: string) => void
  onMove: (rule: string, to: RuleList) => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const shown = filter ? rules.filter((r) => r.toLowerCase().includes(filter)) : rules
  const also = value.trim() ? conflictIn(value.trim()) : []

  async function add(): Promise<void> {
    const r = value.trim()
    if (!r || busy) return
    setBusy(true)
    setError(null)
    try {
      const msg = await onAdd(r)
      if (msg) setError(msg)
      else setValue('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={`${title} · ${rules.length}`} description={description}>
      <form
        className="pm-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <TextField
          aria-label={`Add a rule to ${title}`}
          mono
          placeholder={placeholder}
          spellCheck={false}
          value={value}
          error={error}
          hint={also.length ? `Also in ${also.map((l) => LIST_NAME[l]).join(' and ')}. ${hint}` : hint}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
        />
        <Button type="submit" variant="secondary" disabled={!value.trim()} loading={busy}>
          Add
        </Button>
      </form>
      {rules.length === 0 ? (
        <p className="pm-empty">Nothing here yet.</p>
      ) : shown.length === 0 ? (
        <p className="pm-empty">No rule matches the filter.</p>
      ) : (
        <ul role="list" className="pm-rules">
          {shown.map((r) => (
            <li key={r} className="pm-rule">
              <code className="pm-rule__text selectable">{r}</code>
              <select
                className="pm-move"
                aria-label={`Move ${r} to another list`}
                value=""
                onChange={(e) => e.target.value && onMove(r, e.target.value as RuleList)}
              >
                <option value="">Move to…</option>
                {moveTargets.map((t) => (
                  <option key={t} value={t}>
                    {LIST_NAME[t]}
                  </option>
                ))}
              </select>
              <IconButton aria-label={`Remove ${r}`} icon={<X />} onClick={() => onRemove(r)} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ screen */

export default function PermissionsScreen({ selectId }: ScreenProps): JSX.Element {
  const toast = useToast()
  const { navigate } = useNav()
  const [file, setFile] = useState<SettingsFileName>(SETTINGS_FILES.find((f) => selectId === f || selectId?.startsWith(`${f}:`)) ?? 'settings.json')
  const [raw, setData] = useState<PermissionsData | undefined>()
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [confirmBypass, setConfirmBypass] = useState(false)

  const data = raw && raw.file === file ? raw : undefined
  // responses for a file the user has already switched away from are dropped
  const fileRef = useRef(file)
  fileRef.current = file

  const load = useCallback(async (f: SettingsFileName) => {
    try {
      const d = await api.permissions.get(f)
      if (d.file !== fileRef.current) return
      setData(d)
      setLoadError(null)
    } catch (e) {
      if (f === fileRef.current) setLoadError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    setData(undefined)
    void load(file)
  }, [file, load])
  useEffect(() => {
    const onFocus = (): void => void load(file)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [file, load])

  /** Run a write; show the new state and a toast. Returns an error message instead of throwing (for inline display). */
  async function run(op: () => Promise<PermissionsData>, done: string): Promise<string | void> {
    try {
      const d = await op()
      if (d.file === fileRef.current) setData(d)
      toast(`${done} Snapshot kept in Backups.`, { kind: 'success' })
    } catch (e) {
      const msg = (e as Error).message
      void load(file)
      return msg
    }
  }
  const runToast = async (op: () => Promise<PermissionsData>, done: string): Promise<void> => {
    const msg = await run(op, done)
    if (msg) toast(msg, { kind: 'error' })
  }

  const mode = data?.defaultMode ?? ''
  const modeOptions = useMemo(() => {
    const o = MODES.map((m) => ({ value: m.value, label: m.label }))
    if (mode && !MODES.some((m) => m.value === mode)) o.push({ value: mode, label: mode })
    return o
  }, [mode])
  const modeInfo = MODES.find((m) => m.value === mode)

  function changeMode(v: string): void {
    if (v === 'bypassPermissions') return setConfirmBypass(true)
    void runToast(() => api.permissions.setDefaultMode(file, v === '' ? null : v), 'Default mode saved.')
  }

  const fileOptions = SETTINGS_FILES.map((f) => ({ value: f, label: FILE_LABEL[f] }))
  const q = filter.trim().toLowerCase()

  if (loadError && !data) {
    return <EmptyState title="Could not read the permissions" description={loadError} action={<Button onClick={() => void load(file)}>Try again</Button>} />
  }

  const total = data ? data.allow.length + data.ask.length + data.deny.length : 0

  return (
    <PageLayout
      title="Permissions"
      description={`${SUBTITLE[file]}. What Claude Code may do without asking, what it must ask about, and what it can never do.`}
      actions={<Segmented<SettingsFileName> aria-label="Settings file" value={file} onChange={setFile} options={fileOptions} />}
      toolbar={
        data && total > 8 ? (
          <div className="pm-toolbar">
            <SearchField value={filter} onChange={setFilter} placeholder="Filter rules" />
          </div>
        ) : undefined
      }
    >
      {!data ? (
        <div className="pm-center">
          <Spinner />
        </div>
      ) : data.problem ? (
        <div className="pm-banner" role="alert">
          <AlertTriangle size={16} strokeWidth={1.8} aria-hidden />
          <span className="pm-banner__text">{data.problem}</span>
          <Button onClick={() => navigate('settings', file)}>Open Settings</Button>
        </div>
      ) : (
        <>
          {!data.exists ? <p className="pm-note">{file} does not exist yet. It is created when you add a rule or choose a mode.</p> : null}

          <Card title="Default mode" description="How Claude Code behaves when no rule matches.">
            <div className="pm-mode">
              <Select aria-label="Default mode" value={mode} options={modeOptions} onChange={changeMode} className="pm-mode__select" />
              <p className="pm-mode__desc">{modeInfo ? modeInfo.description : 'Not a mode Claudock knows about. It is left as it is.'}</p>
            </div>
            {mode === 'bypassPermissions' ? (
              <div className="pm-caution" role="note">
                <AlertTriangle size={16} strokeWidth={1.8} aria-hidden />
                <p>
                  Caution: with bypassPermissions nothing asks before it runs. Use it only in a sandbox, a container or a throwaway folder, and keep deny rules for anything you cannot undo.
                </p>
              </div>
            ) : null}
          </Card>

          <div className="pm-lists">
            {LISTS.map((l) => (
              <RuleCard
                key={l.key}
                title={l.title}
                description={l.description}
                placeholder={l.placeholder}
                hint="Format: Tool or Tool(specifier)."
                rules={data[l.key]}
                filter={q}
                moveTargets={LISTS.filter((x) => x.key !== l.key).map((x) => x.key)}
                conflictIn={(r) => LISTS.filter((x) => x.key !== l.key && data[x.key].includes(r)).map((x) => x.key)}
                onAdd={(r) => run(() => api.permissions.addRule(file, l.key, r), `Added to ${l.title}.`)}
                onRemove={(r) => void runToast(() => api.permissions.removeRule(file, l.key, r), 'Rule removed.')}
                onMove={(r, to) => void runToast(() => api.permissions.moveRule(file, l.key, to, r), `Moved to ${LIST_NAME[to]}.`)}
              />
            ))}
          </div>

          <RuleCard
            title="Additional directories"
            description="Folders Claude may work in besides the project folder."
            placeholder="~/Documents/notes"
            hint="A folder path."
            rules={data.additionalDirectories}
            filter={q}
            moveTargets={[]}
            conflictIn={() => []}
            onAdd={(r) => run(() => api.permissions.addRule(file, 'additionalDirectories', r), 'Directory added.')}
            onRemove={(r) => void runToast(() => api.permissions.removeRule(file, 'additionalDirectories', r), 'Directory removed.')}
            onMove={() => undefined}
          />

          {data.otherKeys.length > 0 ? (
            <p className="pm-note">
              Also in permissions, left as they are: {data.otherKeys.join(', ')}. Edit them in Settings &gt; JSON.
            </p>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirmBypass}
        tone="danger"
        title="Turn off all permission prompts?"
        description={
          <p>
            bypassPermissions lets Claude run any command and change any file without asking. It applies to {file === 'settings.json' ? 'every project' : 'this machine'}.
          </p>
        }
        confirmLabel="Use bypassPermissions"
        cancelLabel="Keep current mode"
        onCancel={() => setConfirmBypass(false)}
        onConfirm={() => {
          setConfirmBypass(false)
          void runToast(() => api.permissions.setDefaultMode(file, 'bypassPermissions'), 'Default mode saved.')
        }}
      />
    </PageLayout>
  )
}
