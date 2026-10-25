import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Eye, EyeOff, Plus, X } from 'lucide-react'
import type { ScreenId } from '@shared/nav'
import type { SettingsSummary } from '@shared/api/settings'
import { Button, Card, IconButton, Segmented, Select, TextField, Toggle } from '@/components'
import { api } from '@/lib/api'
import { useDebounced } from '@/lib/hooks'
import type { JsonObject } from './json'

/* ------------------------------------------------------------------ small pieces */

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <div className="st-field" role="group" aria-label={label}>
      <span className="st-field__label">{label}</span>
      {children}
      {hint ? <p className="st-field__hint">{hint}</p> : null}
    </div>
  )
}

const OTHER = '__other__'

/** A select of presets plus "Other…", which reveals a free text box (for full model ids, custom themes, …). */
function ChoiceField({
  label,
  value,
  presets,
  defaultLabel,
  hint,
  otherLabel,
  onChange
}: {
  label: string
  value: string
  presets: Array<{ value: string; label: string }>
  defaultLabel: string
  hint?: ReactNode
  otherLabel: string
  onChange: (v: string) => void
}): JSX.Element {
  const known = presets.some((p) => p.value === value)
  const [other, setOther] = useState(!known && value !== '')
  useEffect(() => {
    if (!known && value !== '') setOther(true)
  }, [known, value])
  return (
    <div className="st-choice">
      <Select
        label={label}
        hint={hint}
        value={other ? OTHER : value}
        options={[{ value: '', label: defaultLabel }, ...presets, { value: OTHER, label: 'Other…' }]}
        onChange={(v) => {
          if (v === OTHER) setOther(true)
          else {
            setOther(false)
            onChange(v)
          }
        }}
      />
      {other ? <TextField aria-label={otherLabel} placeholder={otherLabel} mono value={value} onChange={(e) => onChange(e.target.value)} /> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ known keys */

const MODEL_PRESETS = ['opus', 'sonnet', 'haiku', 'fable'].map((v) => ({ value: v, label: v }))
/** The values the effortLevel key accepts. "max" works only per session (/effort max or CLAUDE_CODE_EFFORT_LEVEL). */
const EFFORTS = ['low', 'medium', 'high', 'xhigh']
const EFFORT_HINT = 'How hard Claude thinks before answering. Higher is slower and uses more of your limit. A level /effort saves for a model wins over this.'

function effortHint(effort: string): string {
  if (effort === 'max') return 'max works only for one session, set with /effort max or CLAUDE_CODE_EFFORT_LEVEL, so Claude Code ignores it here. Choose Default to clear it, or pick a level.'
  if (effort && !EFFORTS.includes(effort)) return `Claude Code does not accept "${effort}" here. Choose Default to clear it, or pick a level.`
  return EFFORT_HINT
}
const THEMES = ['auto', 'dark', 'light', 'dark-daltonized', 'light-daltonized', 'dark-ansi', 'light-ansi'].map((v) => ({ value: v, label: v }))

interface ScalarDef {
  key: string
  label: string
  hint: string
  kind: 'boolean' | 'number' | 'text'
  initial: boolean | number | string
  /** Kept editable when the file has it, but not offered under "Add a setting…". */
  deprecated?: boolean
}

const SCALARS: ScalarDef[] = [
  { key: 'outputStyle', label: 'Output style', hint: 'Name of an output style.', kind: 'text', initial: 'default' },
  { key: 'language', label: 'Language', hint: 'Language Claude answers in.', kind: 'text', initial: 'english' },
  { key: 'cleanupPeriodDays', label: 'Keep transcripts for (days)', hint: 'Older sessions are deleted at startup. At least 1.', kind: 'number', initial: 30 },
  {
    key: 'includeCoAuthoredBy',
    label: 'Co-authored-by line in commits',
    hint: 'Deprecated: set attribution in the JSON view instead. Off hides the commit trailer and the pull request text.',
    kind: 'boolean',
    initial: true,
    deprecated: true
  },
  { key: 'alwaysThinkingEnabled', label: 'Extended thinking', hint: 'On by default for models that support it. Off turns it off in every session.', kind: 'boolean', initial: false },
  { key: 'verbose', label: 'Verbose output', hint: 'Shows full tool output instead of summaries. viewMode wins when both are set.', kind: 'boolean', initial: true },
  { key: 'preferredNotifChannel', label: 'Notification channel', hint: 'For example auto, terminal_bell or iterm2.', kind: 'text', initial: 'auto' },
  { key: 'voiceEnabled', label: 'Voice input', hint: 'Deprecated: voice.enabled replaces it and wins when both are set.', kind: 'boolean', initial: true, deprecated: true },
  { key: 'agentPushNotifEnabled', label: 'Push notifications to your phone', hint: 'Claude sends one when it decides it is worth it.', kind: 'boolean', initial: true },
  { key: 'idleCompaction', label: 'Compact when idle', hint: 'On by default. Summarises a long session you have stepped away from.', kind: 'boolean', initial: false },
  { key: 'skipWorkflowUsageWarning', label: 'Skip workflow usage warning', hint: 'Hides the cost warning before workflows run.', kind: 'boolean', initial: true },
  { key: 'disableAllHooks', label: 'Turn off all hooks', hint: 'Hooks, a custom status line and the @ file suggestion command stay in the file but never run.', kind: 'boolean', initial: true },
  { key: 'apiKeyHelper', label: 'API key helper', hint: 'Script that prints an API key.', kind: 'text', initial: '' }
]

/** Keys the form edits itself or hands to another screen. Everything else is listed under "Other keys". */
const HANDLED = new Set(['model', 'effortLevel', 'theme', 'statusLine', 'env', 'hooks', 'permissions', 'skillOverrides', 'enabledPlugins', ...SCALARS.map((s) => s.key)])

const isScalar = (v: unknown): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v)

function preview(v: unknown): string {
  let s: string
  try {
    s = JSON.stringify(v) ?? String(v)
  } catch {
    s = String(v)
  }
  return s.length > 90 ? s.slice(0, 90) + '…' : s
}

function kindOf(v: unknown): string {
  if (Array.isArray(v)) return `list · ${v.length}`
  if (v !== null && typeof v === 'object') return `object · ${Object.keys(v).length} keys`
  return typeof v
}

/* ------------------------------------------------------------------ env table */

function EnvRow({
  name,
  value,
  taken,
  onRename,
  onValue,
  onRemove
}: {
  name: string
  value: unknown
  taken: (k: string) => boolean
  onRename: (to: string) => void
  onValue: (v: string) => void
  onRemove: () => void
}): JSX.Element {
  const [key, setKey] = useState(name)
  const [show, setShow] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setKey(name), [name])
  function commit(): void {
    const k = key.trim()
    if (k === name) return setErr(null)
    if (!k) {
      setErr('Name is empty')
      return
    }
    if (taken(k)) {
      setErr('Already defined')
      return
    }
    setErr(null)
    onRename(k)
  }
  return (
    <div className="st-env__row">
      <TextField
        aria-label={`Variable name ${name}`}
        mono
        value={key}
        error={err}
        onChange={(e) => setKey(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        spellCheck={false}
      />
      <TextField
        aria-label={`Value of ${name}`}
        mono
        type={show ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        value={typeof value === 'string' ? value : String(value ?? '')}
        onChange={(e) => onValue(e.target.value)}
      />
      <IconButton
        aria-label={show ? `Hide value of ${name}` : `Show value of ${name}`}
        aria-pressed={show}
        icon={show ? <EyeOff /> : <Eye />}
        onClick={() => setShow((s) => !s)}
      />
      <IconButton aria-label={`Remove ${name}`} icon={<X />} onClick={onRemove} />
    </div>
  )
}

/* ------------------------------------------------------------------ the form */

export interface FormViewProps {
  obj: JsonObject
  onChange: (next: JsonObject) => void
  summary: SettingsSummary | undefined
  onOpen: (screen: ScreenId) => void
  onEditJson: () => void
  /** Scrolls to and briefly highlights the field for this top-level key whenever `nonce` changes. */
  focusKey?: { key: string; nonce: number } | null
}

/** True when the form shows the top-level key `key` (every key present in the object is shown somewhere in the form). */
export function formShowsKey(obj: JsonObject, key: string): boolean {
  return key in obj
}

export function FormView({ obj, onChange, summary, onOpen, onEditJson, focusKey }: FormViewProps): JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const nonce = focusKey?.nonce
  const wanted = focusKey?.key
  useEffect(() => {
    if (!wanted) return
    const el = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-st-key]') ?? []).find((e) => e.dataset.stKey === wanted)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('st-flash')
    void el.offsetWidth // restart the animation when the same key is picked twice
    el.classList.add('st-flash')
    const t = setTimeout(() => el.classList.remove('st-flash'), 2000)
    return () => clearTimeout(t)
  }, [wanted, nonce])

  const set = (key: string, value: unknown): void => {
    const next: JsonObject = { ...obj }
    if (value === undefined) delete next[key]
    else next[key] = value
    onChange(next)
  }

  const model = typeof obj.model === 'string' ? obj.model : ''
  const effort = typeof obj.effortLevel === 'string' ? obj.effortLevel : ''
  const theme = typeof obj.theme === 'string' ? obj.theme : ''
  const effortOptions = [{ value: '', label: 'Default' }, ...EFFORTS.map((v) => ({ value: v, label: v }))]
  if (effort && !EFFORTS.includes(effort)) effortOptions.push({ value: effort, label: effort })

  /* scalars present / addable */
  const presentScalars = SCALARS.filter((s) => s.key in obj && isScalar(obj[s.key]))
  const addable = SCALARS.filter((s) => !(s.key in obj) && !s.deprecated)

  /* status line */
  const sl = obj.statusLine !== null && typeof obj.statusLine === 'object' && !Array.isArray(obj.statusLine) ? (obj.statusLine as JsonObject) : null
  const slCommand = sl && typeof sl.command === 'string' ? sl.command : ''
  const slType = sl && typeof sl.type === 'string' ? sl.type : 'command'
  const slProbe = useDebounced(slCommand, 300)
  const [scripts, setScripts] = useState<string[]>([])
  useEffect(() => {
    let live = true
    if (!slProbe) {
      setScripts([])
      return
    }
    api.settings.scripts(slProbe).then(
      (r) => live && setScripts(r),
      () => live && setScripts([])
    )
    return () => {
      live = false
    }
  }, [slProbe])

  /* env */
  const env = obj.env !== null && typeof obj.env === 'object' && !Array.isArray(obj.env) ? (obj.env as JsonObject) : {}
  const envEntries = Object.entries(env)
  const [adding, setAdding] = useState<{ key: string; value: string } | null>(null)
  const addErr = adding && adding.key.trim() && adding.key.trim() in env ? 'Already defined' : null
  const setEnv = (next: JsonObject): void => set('env', Object.keys(next).length ? next : undefined)

  /* other keys */
  const others = useMemo(() => Object.keys(obj).filter((k) => !HANDLED.has(k)), [obj])
  // scalar keys with a value that is not a scalar (e.g. outputStyle: {…}) are not editable here either
  const oddScalars = SCALARS.filter((s) => s.key in obj && !isScalar(obj[s.key])).map((s) => s.key)
  const otherKeys = [...others, ...oddScalars]

  const permLine = summary
    ? `${summary.defaultMode ? `Mode ${summary.defaultMode} · ` : ''}${summary.allow} allow, ${summary.ask} ask, ${summary.deny} deny`
    : '…'

  return (
    <div className="st-grid" ref={root}>
      <div className="st-col">
        <Card title="General" description="Model, reasoning effort and look.">
          <div className="st-stack">
            <div data-st-key="model">
              <ChoiceField
                label="Model"
                value={model}
                presets={MODEL_PRESETS}
                defaultLabel="Default (not set)"
                otherLabel="Full model id"
                hint="Pick an alias, or choose Other… to enter a full model id."
                onChange={(v) => set('model', v === '' ? undefined : v)}
              />
            </div>
            <div data-st-key="effortLevel">
              <Field label="Effort" hint={effortHint(effort)}>
                <Segmented
                  aria-label="Effort"
                  options={effortOptions}
                  value={effort}
                  onChange={(v) => set('effortLevel', v === '' ? undefined : v)}
                />
              </Field>
            </div>
            <div data-st-key="theme">
              <ChoiceField
                label="Terminal theme"
                value={theme}
                presets={THEMES}
                defaultLabel="Default (not set)"
                otherLabel="Theme name"
                onChange={(v) => set('theme', v === '' ? undefined : v)}
              />
            </div>
            {presentScalars.map((s) => {
              const v = obj[s.key]
              return (
                <div className="st-scalar" key={s.key} data-st-key={s.key}>
                  <div className="st-scalar__main">
                    {s.kind === 'boolean' && typeof v === 'boolean' ? (
                      <div className="st-toggle-row">
                        <div>
                          <div className="st-toggle-row__label">{s.label}</div>
                          <p className="st-field__hint">{s.hint}</p>
                        </div>
                        <Toggle aria-label={s.label} checked={v} onChange={(c) => set(s.key, c)} />
                      </div>
                    ) : s.kind === 'number' && typeof v === 'number' ? (
                      <TextField
                        label={s.label}
                        hint={s.hint}
                        type="number"
                        min={1}
                        value={String(v)}
                        onChange={(e) => set(s.key, e.target.value === '' ? undefined : Number(e.target.value))}
                      />
                    ) : (
                      <TextField
                        label={s.label}
                        hint={s.hint}
                        mono={s.key === 'apiKeyHelper'}
                        value={String(v)}
                        onChange={(e) => set(s.key, e.target.value)}
                      />
                    )}
                  </div>
                  <IconButton aria-label={`Remove ${s.label}`} icon={<X />} onClick={() => set(s.key, undefined)} />
                </div>
              )
            })}
            {addable.length > 0 ? (
              <Select
                aria-label="Add a setting"
                value=""
                options={[{ value: '', label: 'Add a setting…' }, ...addable.map((s) => ({ value: s.key, label: s.label }))]}
                onChange={(k) => {
                  const def = addable.find((s) => s.key === k)
                  if (def) set(def.key, def.initial)
                }}
              />
            ) : null}
          </div>
        </Card>

        <div data-st-key="statusLine">
          <Card title="Status line" description="A command whose output Claude Code shows under the prompt.">
            {sl ? (
              <div className="st-stack">
                <Select
                  label="Type"
                  value={slType}
                  options={slType === 'command' ? [{ value: 'command', label: 'command' }] : [{ value: 'command', label: 'command' }, { value: slType, label: slType }]}
                  onChange={(v) => set('statusLine', { ...sl, type: v })}
                />
                <TextField
                  label="Command"
                  mono
                  multiline
                  rows={2}
                  spellCheck={false}
                  value={slCommand}
                  onChange={(e) => set('statusLine', { ...sl, command: e.target.value })}
                />
                <div className="st-actions">
                  {scripts.map((s) => (
                    <Button key={s} onClick={() => api.system.reveal(s).catch(() => undefined)}>
                      Reveal script
                      <span className="st-actions__file">{s.split(/[\\/]/).pop()}</span>
                    </Button>
                  ))}
                  <Button variant="ghost" onClick={() => set('statusLine', undefined)}>
                    Remove status line
                  </Button>
                </div>
              </div>
            ) : (
              <div className="st-stack">
                <p className="st-muted">No status line is set.</p>
                <div className="st-actions">
                  <Button icon={<Plus />} onClick={() => set('statusLine', { type: 'command', command: '' })}>
                    Add status line
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      <div className="st-col">
        <div data-st-key="env">
          <Card
            title="Environment variables"
            description="Set for every Claude Code session. Values are hidden because they can hold tokens."
            actions={
              <Button icon={<Plus />} onClick={() => setAdding({ key: '', value: '' })} disabled={adding !== null}>
                Add variable
              </Button>
            }
          >
            {envEntries.length === 0 && !adding ? <p className="st-muted">No variables.</p> : null}
            <div className="st-env">
              {envEntries.map(([k, v]) => (
                <EnvRow
                  key={k}
                  name={k}
                  value={v}
                  taken={(n) => n in env}
                  onRename={(to) => setEnv(Object.fromEntries(envEntries.map(([ek, ev]) => [ek === k ? to : ek, ev])))}
                  onValue={(val) => setEnv({ ...env, [k]: val })}
                  onRemove={() => {
                    const next = { ...env }
                    delete next[k]
                    setEnv(next)
                  }}
                />
              ))}
              {adding ? (
                <div className="st-env__row">
                  <TextField
                    aria-label="New variable name"
                    mono
                    autoFocus
                    placeholder="NAME"
                    value={adding.key}
                    error={addErr}
                    onChange={(e) => setAdding({ ...adding, key: e.target.value })}
                    spellCheck={false}
                  />
                  <TextField
                    aria-label="New variable value"
                    mono
                    type="password"
                    autoComplete="off"
                    placeholder="value"
                    value={adding.value}
                    onChange={(e) => setAdding({ ...adding, value: e.target.value })}
                    spellCheck={false}
                  />
                  <Button
                    variant="primary"
                    disabled={!adding.key.trim() || !!addErr}
                    onClick={() => {
                      setEnv({ ...env, [adding.key.trim()]: adding.value })
                      setAdding(null)
                    }}
                  >
                    Add
                  </Button>
                  <IconButton aria-label="Cancel new variable" icon={<X />} onClick={() => setAdding(null)} />
                </div>
              ) : null}
            </div>
          </Card>
        </div>

        <Card title="Managed on other screens" description="These keys have their own editors.">
          <ul role="list" className="st-links">
            <LinkRow k="hooks" title="Hooks" detail={summary ? (summary.hookCommands ? `${summary.hookCommands} on ${summary.hookEvents} event${summary.hookEvents === 1 ? '' : 's'}` : 'None') : '…'} onOpen={() => onOpen('hooks')} />
            <LinkRow k="permissions" title="Permissions" detail={permLine} onOpen={() => onOpen('permissions')} />
            <LinkRow
              k="skillOverrides"
              title="Skills"
              detail={summary ? `${summary.skillOverridesTotal} override${summary.skillOverridesTotal === 1 ? '' : 's'}, ${summary.skillOverridesOff} off` : '…'}
              onOpen={() => onOpen('skills')}
            />
            <LinkRow k="enabledPlugins" title="Plugins" detail={summary ? `${summary.pluginsEnabled} enabled of ${summary.pluginsTotal}` : '…'} onOpen={() => onOpen('plugins')} />
          </ul>
        </Card>

        {otherKeys.length > 0 ? (
          <Card
            title="Other keys"
            description="Claudock keeps these as they are. Change them in the JSON view."
            actions={<Button onClick={onEditJson}>Edit in JSON</Button>}
          >
            <ul role="list" className="st-other">
              {otherKeys.map((k) => (
                <li key={k} className="st-other__row" data-st-key={k}>
                  <code className="st-other__key">{k}</code>
                  <span className="st-other__kind">{kindOf(obj[k])}</span>
                  <code className="st-other__value">{preview(obj[k])}</code>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </div>
  )
}

function LinkRow({ k, title, detail, onOpen }: { k: string; title: string; detail: string; onOpen: () => void }): JSX.Element {
  return (
    <li className="st-links__row" data-st-key={k}>
      <button type="button" className="st-links__btn" onClick={onOpen} aria-label={`${title}: ${detail}. Open ${title}`}>
        <span className="st-links__title">{title}</span>
        <span className="st-links__detail">{detail}</span>
        <ChevronRight size={16} strokeWidth={1.8} aria-hidden />
      </button>
    </li>
  )
}
