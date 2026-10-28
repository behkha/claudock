import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Webhook } from 'lucide-react'
import type { HookEntry, HookInput } from '@shared/api/hooks'
import { SETTINGS_FILES, type SettingsFileName } from '@shared/api/settings'
import { Badge, ConfirmDialog, EmptyState, IconButton, ListDetailLayout, ListGroup, ListPane, ListRow, Segmented, Select, useToast } from '@/components'
import { api, useApi } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import { useNav, type ScreenProps } from '@/lib/nav'
import { ClaudockHooks, ClaudockMark } from './ClaudockHooks'
import { HookForm } from './HookForm'
import './hooks.css'

const NEW = '__new__'
/** Selection id of the one row that stands for Claudock's own hooks. */
const CLAUDOCK = '__claudock__'
const FILE_LABEL: Record<SettingsFileName, string> = { 'settings.json': 'User', 'settings.local.json': 'Local' }

/**
 * Palette ids are `<file>|<event>:<group>:<hook>` (file = settings.json / settings.local.json). A bare
 * `<event>:<group>` (older form) selects the first hook of that group in the user file.
 */
function parseTarget(selectId: string | undefined): { file?: SettingsFileName; id?: string } {
  if (!selectId) return {}
  const bar = selectId.indexOf('|')
  if (bar > 0) {
    const f = selectId.slice(0, bar)
    if ((SETTINGS_FILES as readonly string[]).includes(f)) return { file: f as SettingsFileName, id: selectId.slice(bar + 1) }
  }
  return { id: selectId }
}

export default function HooksScreen({ selectId }: ScreenProps): JSX.Element {
  const toast = useToast()
  const { seq, navigate } = useNav()
  const target = useMemo(() => parseTarget(selectId), [selectId])
  const [file, setFile] = useState<SettingsFileName>(target.file ?? 'settings.json')
  const [sel, setSel] = useSelectId(target.id)
  useEffect(() => {
    if (target.file) setFile(target.file)
  }, [target, seq])
  const [newEvent, setNewEvent] = useState('PreToolUse')
  const { data, error, loading, reload } = useApi(() => api.hooks.list(file), [file])
  const info = useApi(() => api.system.configInfo(), [])
  const dirtyRef = useRef(false)
  const [pending, setPending] = useState<(() => void) | null>(null)

  useEffect(() => {
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])

  const all = useMemo(() => (data && data.file === file ? data.entries : []), [data, file])
  const entries = useMemo(() => all.filter((e) => !e.claudock), [all])
  const ours = useMemo(() => all.filter((e) => e.claudock), [all])
  const groups = useMemo(() => {
    const by = new Map<string, HookEntry[]>()
    for (const e of entries) by.set(e.event, [...(by.get(e.event) ?? []), e])
    return (data?.events ?? []).filter((ev) => by.has(ev)).map((ev) => ({ event: ev, items: by.get(ev) ?? [] }))
  }, [entries, data])

  const creating = sel === NEW
  const found = !creating && sel ? (entries.find((e) => e.id === sel) ?? entries.find((e) => e.id.startsWith(`${sel}:`))) : undefined
  // the Claudock row is the first row, so it is also what shows when nothing else is selected
  const pointsAtOurs = sel === CLAUDOCK || (!!sel && ours.some((e) => e.id === sel || e.id.startsWith(`${sel}:`)))
  const showOurs = !creating && !found && ours.length > 0 && (pointsAtOurs || !sel || entries.length === 0)
  const selected = creating || showOurs ? null : (found ?? entries[0] ?? null)

  /** Run `action`, asking first when the form has unsaved edits. */
  const guard = useCallback((action: () => void) => {
    if (dirtyRef.current) setPending(() => action)
    else action()
  }, [])
  const onDirty = useCallback((d: boolean) => void (dirtyRef.current = d), [])

  async function save(input: HookInput): Promise<void> {
    try {
      const ref = selected ? { event: selected.event, groupIndex: selected.groupIndex, hookIndex: selected.hookIndex, command: selected.command } : null
      const res = await api.hooks.save(file, input, ref)
      dirtyRef.current = false
      setSel(res.savedId)
      reload()
      toast('Saved. Snapshot kept in Backups.', { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
      reload()
    }
  }

  async function remove(): Promise<void> {
    if (!selected) return
    try {
      await api.hooks.remove(file, { event: selected.event, groupIndex: selected.groupIndex, hookIndex: selected.hookIndex, command: selected.command })
      dirtyRef.current = false
      setSel(undefined)
      reload()
      toast('Hook removed. Snapshot kept in Backups.', { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
      reload()
    }
  }

  const known = data?.events ?? []
  const problem = data?.problem ?? null
  const empty = !!data && all.length === 0 && !creating

  return (
    <>
      <ListDetailLayout
        list={
          <ListPane
            title="Hooks"
            count={entries.length || undefined}
            actions={
              <IconButton
                variant="secondary"
                aria-label="Add hook"
                icon={<Plus />}
                onClick={() =>
                  guard(() => {
                    setNewEvent('PreToolUse')
                    setSel(NEW)
                  })
                }
              />
            }
            filters={
              <div className="hk-filters">
                <Segmented<SettingsFileName>
                  aria-label="Settings file"
                  value={file}
                  onChange={(f) =>
                    guard(() => {
                      setFile(f)
                      setSel(undefined)
                    })
                  }
                  options={SETTINGS_FILES.map((f) => ({ value: f, label: FILE_LABEL[f] }))}
                />
                {known.length > 0 ? (
                  <Select
                    aria-label="Add a hook to an event"
                    value=""
                    options={[{ value: '', label: 'Add to…' }, ...known.map((ev) => ({ value: ev, label: entries.some((e) => e.event === ev) ? ev : `${ev} (none yet)` }))]}
                    onChange={(ev) =>
                      ev &&
                      guard(() => {
                        setNewEvent(ev)
                        setSel(NEW)
                      })
                    }
                  />
                ) : null}
              </div>
            }
            loading={loading && !data}
            error={error ?? problem}
            isEmpty={empty}
            empty={<EmptyState icon={<Webhook />} title="No hooks in this file" description="Hooks run a command when something happens, such as before a tool runs or when Claude stops." />}
          >
            {ours.length > 0 ? (
              <>
                <ListGroup>Claudock</ListGroup>
                <ListRow
                  selected={showOurs}
                  leading={<ClaudockMark />}
                  title="Connect to Claude Code"
                  meta={String(ours.length)}
                  onSelect={() => guard(() => setSel(CLAUDOCK))}
                />
              </>
            ) : null}
            {groups.map((g) => (
              <ListGroupBlock key={g.event} event={g.event} count={g.items.length}>
                {g.items.map((e) => (
                  <ListRow
                    key={e.id}
                    selected={!creating && selected?.id === e.id}
                    title={<span className="hk-matcher">{e.matcher ?? 'all'}</span>}
                    subtitle={<span className="hk-command">{e.command.replace(/\s+/g, ' ')}</span>}
                    meta={e.timeout !== null ? `${e.timeout}s` : undefined}
                    leading={e.type !== 'command' ? <Badge>{e.type}</Badge> : undefined}
                    onSelect={() => guard(() => setSel(e.id))}
                  />
                ))}
              </ListGroupBlock>
            ))}
          </ListPane>
        }
        detail={
          showOurs ? (
            <ClaudockHooks
              entries={ours}
              filePath={info.data ? `${info.data.configDir}${info.data.sep}${file}` : file}
              fileName={file}
              onDisconnect={() => navigate('today', 'disconnect')}
            />
          ) : creating || selected ? (
            <HookForm
              key={creating ? `new:${newEvent}` : `${file}:${selected?.id}`}
              entry={selected}
              newEvent={newEvent}
              events={known}
              filePath={info.data ? `${info.data.configDir}${info.data.sep}${file}` : file}
              fileName={file}
              onSave={save}
              onRemove={remove}
              onCancelNew={() => guard(() => setSel(undefined))}
              onDirty={onDirty}
            />
          ) : (
            <EmptyState
              icon={<Webhook />}
              title={problem ? 'Hooks cannot be edited here' : loading ? 'Loading…' : 'No hook selected'}
              description={problem ?? error ?? (loading ? undefined : 'Add one with the plus button, or pick an event from Add to…')}
            />
          )
        }
      />
      <ConfirmDialog
        open={pending !== null}
        title="Discard your edits?"
        description={<p>This hook has changes that are not saved.</p>}
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        tone="danger"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const run = pending
          dirtyRef.current = false
          setPending(null)
          run?.()
        }}
      />
    </>
  )
}

function ListGroupBlock({ event, count, children }: { event: string; count: number; children: React.ReactNode }): JSX.Element {
  return (
    <>
      <ListGroup>
        {event} · {count}
      </ListGroup>
      {children}
    </>
  )
}
