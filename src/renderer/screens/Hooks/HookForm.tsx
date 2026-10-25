import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Trash2 } from 'lucide-react'
import type { HookEntry, HookInput } from '@shared/api/hooks'
import { Badge, Button, ConfirmDialog, DetailPane, Select, TextField } from '@/components'
import { api } from '@/lib/api'
import { useDebounced } from '@/lib/hooks'
import { useNavGuard } from '@/lib/nav'

interface FormState {
  event: string
  matcher: string
  type: string
  command: string
  timeout: string
}

const toForm = (e: HookEntry | null, event: string): FormState =>
  e
    ? { event: e.event, matcher: e.matcher ?? '', type: e.type, command: e.command, timeout: e.timeout === null ? '' : String(e.timeout) }
    : { event, matcher: '', type: 'command', command: '', timeout: '' }

const same = (a: FormState, b: FormState): boolean =>
  a.event === b.event && a.matcher === b.matcher && a.type === b.type && a.command === b.command && a.timeout === b.timeout

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PermissionRequest']

function matcherHint(event: string): string {
  if (TOOL_EVENTS.includes(event)) return 'A tool name or pattern, such as Bash, Edit|Write or mcp__.*. Empty or * matches every tool.'
  if (event === 'SessionStart') return 'When the session starts: startup, resume, clear or compact. Empty matches all.'
  if (event === 'PreCompact') return 'manual or auto. Empty matches both.'
  if (event === 'Notification') return 'Which notification to react to. Empty matches all.'
  if (['UserPromptSubmit', 'Stop', 'SubagentStop'].includes(event)) return 'This event does not use a matcher. Leave it empty.'
  return 'Leave empty to match everything.'
}

export interface HookFormProps {
  /** The hook being edited, or null for a new one. */
  entry: HookEntry | null
  /** Event preselected for a new hook. */
  newEvent: string
  events: string[]
  /** Absolute path of the settings file, for the path line. */
  filePath: string
  fileName: string
  onSave: (input: HookInput) => Promise<void>
  onRemove: () => Promise<void>
  onCancelNew: () => void
  onDirty: (dirty: boolean) => void
}

export function HookForm({ entry, newEvent, events, filePath, fileName, onSave, onRemove, onCancelNew, onDirty }: HookFormProps): JSX.Element {
  const initial = useMemo(() => toForm(entry, newEvent), [entry, newEvent])
  const [form, setForm] = useState<FormState>(initial)
  const [baseline, setBaseline] = useState<FormState>(initial)
  const [saving, setSaving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  // the file changed under us: refresh the form unless there are edits in it
  useEffect(() => {
    if (same(initial, baseline)) return
    setForm((f) => (same(f, baseline) ? initial : f))
    setBaseline(initial)
  }, [initial, baseline])

  const dirty = !same(form, baseline)
  useNavGuard(dirty)
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
  useEffect(() => () => onDirty(false), [onDirty])

  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void => setForm((f) => ({ ...f, [k]: v }))

  const timeoutNum = form.timeout.trim() === '' ? null : Number(form.timeout)
  const timeoutError = timeoutNum !== null && (!Number.isFinite(timeoutNum) || timeoutNum <= 0) ? 'Use a number of seconds above 0' : null
  const commandLabel = form.type === 'command' ? 'Command' : 'Prompt'
  const canSave = form.command.trim() !== '' && !timeoutError && !saving && (entry === null || dirty)

  const probe = useDebounced(form.command, 300)
  const [scripts, setScripts] = useState<string[]>([])
  useEffect(() => {
    let live = true
    if (!probe) {
      setScripts([])
      return
    }
    api.settings.scripts(probe).then(
      (r) => live && setScripts(r),
      () => live && setScripts([])
    )
    return () => {
      live = false
    }
  }, [probe])

  async function save(): Promise<void> {
    if (!canSave) return
    setSaving(true)
    try {
      await onSave({ event: form.event, matcher: form.matcher, type: form.type, command: form.command, timeout: timeoutNum === null ? null : Math.round(timeoutNum) })
    } finally {
      setSaving(false)
    }
  }

  const typeOptions = [{ value: 'command', label: 'command' }]
  if (form.type !== 'command') typeOptions.push({ value: form.type, label: form.type })
  const eventOptions = events.includes(form.event) ? events : [...events, form.event]

  return (
    <>
      <DetailPane
        title={entry ? form.event : 'New hook'}
        path={filePath}
        reveal={fileName}
        badges={<>{entry ? <Badge tone="oat">{entry.matcher ?? 'all'}</Badge> : null}{dirty && entry ? <Badge tone="accent">Unsaved</Badge> : null}</>}
        actions={
          <>
            <Button variant="primary" onClick={() => void save()} disabled={!canSave} loading={saving}>
              {entry ? 'Save' : 'Add hook'}
            </Button>
            {entry === null ? (
              <Button onClick={onCancelNew}>Cancel</Button>
            ) : (
              <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            )}
          </>
        }
      >
        <form
          className="hk-form"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Select label="Event" value={form.event} options={eventOptions.map((v) => ({ value: v, label: v }))} onChange={(v) => set('event', v)} />
          <TextField label="Matcher" mono placeholder="all" spellCheck={false} hint={matcherHint(form.event)} value={form.matcher} onChange={(e) => set('matcher', e.target.value)} />
          <Select label="Type" value={form.type} options={typeOptions} onChange={(v) => set('type', v)} />
          <TextField
            label={commandLabel}
            mono
            multiline
            rows={5}
            spellCheck={false}
            hint={form.type === 'command' ? 'Runs in your shell. Claude Code sends details of the event to it as JSON on stdin.' : undefined}
            value={form.command}
            onChange={(e) => set('command', e.target.value)}
          />
          {scripts.length > 0 ? (
            <div className="hk-scripts">
              {scripts.map((s) => (
                <Button key={s} icon={<FolderOpen />} onClick={() => api.system.reveal(s).catch(() => undefined)}>
                  Reveal {s.split(/[\\/]/).pop()}
                </Button>
              ))}
            </div>
          ) : null}
          <TextField
            label="Timeout (seconds)"
            type="number"
            min={1}
            placeholder="Default"
            error={timeoutError}
            hint="Claude Code stops the hook after this long. Leave empty for the default."
            value={form.timeout}
            onChange={(e) => set('timeout', e.target.value)}
          />
        </form>
      </DetailPane>

      <ConfirmDialog
        open={confirmRemove}
        busy={removing}
        tone="danger"
        title="Remove this hook?"
        description={
          <p>
            It is taken out of {fileName}. A snapshot of the file is kept in Backups, so you can restore it.
          </p>
        }
        confirmLabel="Remove hook"
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setRemoving(true)
          onRemove().finally(() => {
            setRemoving(false)
            setConfirmRemove(false)
          })
        }}
      />
    </>
  )
}
