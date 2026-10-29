import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Plus, Sparkles } from 'lucide-react'
import { RESERVED_NAME_ERROR, isReservedName } from '@shared/names'
import { SKILL_NAME_RE, type SkillInfo } from '@shared/api/skills'
import { formatBytes, formatCount } from '@shared/format'
import { parseFrontmatter } from '@shared/frontmatter'
import {
  Badge,
  Button,
  Chip,
  ConfirmDialog,
  DetailPane,
  EmptyState,
  IconButton,
  ListDetailLayout,
  ListGroup,
  ListPane,
  ListRow,
  Spinner,
  Toggle
} from '@/components'
import { api, useApi } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import { useNav, type ScreenProps, useNavGuard } from '@/lib/nav'
import { Dot, FrontmatterFacts, MarkdownPane, PromptDialog, Spacer, Tabs, useDirtyGuard, useNotify, useSaveShortcut } from '../_ext/ui'
import { FileTree } from './FileTree'

type Filter = 'all' | 'on' | 'off' | 'synced' | 'plugin'
type SizeInfo = { bytes: number; files: number } | 'err'

const BIG_COPY_BYTES = 200 * 1024 * 1024

function findSkill(skills: SkillInfo[], sel: string): SkillInfo | undefined {
  return (
    skills.find((s) => s.id === sel) ??
    skills.find((s) => s.skillFile === sel) ??
    skills.find((s) => s.key === sel) ??
    skills.find((s) => s.name === sel) ??
    skills.find((s) => s.id !== '' && sel.startsWith(s.id + '/'))
  )
}

function stateText(s: SkillInfo): string {
  if (s.source === 'override') return `${s.enabled ? 'On' : 'Off'} · override only`
  if (s.source === 'plugin' && s.pluginEnabled === false) return `Off · ${s.label} (plugin off)`
  // the two values between on and off: Claude sees only the name, or nothing while /name still runs it (Context's switch)
  if (s.override === 'name-only') return `Name only · ${s.label}`
  if (s.override === 'user-invocable-only') return `/${s.key} only · ${s.label}`
  return `${s.enabled ? 'On' : 'Off'} · ${s.label}`
}

export default function SkillsScreen({ selectId }: ScreenProps): JSX.Element {
  const { data, error, loading, reload } = useApi(() => api.skills.list(), [])
  const [selected, setSelected] = useSelectId(selectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [bulk, setBulk] = useState<{ enabled: boolean; keys: string[] } | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const notify = useNotify()
  const guard = useDirtyGuard(setSelected)

  const skills = useMemo(() => data?.skills ?? [], [data])

  /* ---------------------------------------------------------------- lazy sizes (a skill can be over a gigabyte) */
  const [sizes, setSizes] = useState<Record<string, SizeInfo>>({})
  const queue = useRef<string[]>([])
  const inflight = useRef(new Set<string>())
  const finished = useRef(new Set<string>())
  const alive = useRef(true)

  const pump = useCallback(() => {
    while (inflight.current.size < 3 && queue.current.length > 0) {
      const id = queue.current.shift() as string
      if (finished.current.has(id) || inflight.current.has(id)) continue
      inflight.current.add(id)
      api.skills
        .size(id)
        .then((r) => alive.current && setSizes((s) => ({ ...s, [id]: r })))
        .catch(() => alive.current && setSizes((s) => ({ ...s, [id]: 'err' })))
        .finally(() => {
          inflight.current.delete(id)
          finished.current.add(id)
          if (alive.current) pump()
        })
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const order = [...skills.filter((s) => s.source !== 'plugin'), ...skills.filter((s) => s.source === 'plugin')]
    for (const s of order) {
      if (!s.rel || finished.current.has(s.id) || inflight.current.has(s.id) || queue.current.includes(s.id)) continue
      queue.current.push(s.id)
    }
    pump()
  }, [skills, pump])

  /* ---------------------------------------------------------------- filtering */
  const q = query.trim().toLowerCase()
  const counts = useMemo(
    () => ({
      all: skills.length,
      on: skills.filter((s) => s.enabled).length,
      off: skills.filter((s) => !s.enabled).length,
      synced: skills.filter((s) => s.source === 'synced').length,
      plugin: skills.filter((s) => s.source === 'plugin').length
    }),
    [skills]
  )
  const view = useMemo(
    () =>
      skills.filter((s) => {
        if (filter === 'on' && !s.enabled) return false
        if (filter === 'off' && s.enabled) return false
        if (filter === 'synced' && s.source !== 'synced') return false
        if (filter === 'plugin' && s.source !== 'plugin') return false
        if (q && !`${s.name} ${s.label} ${s.description}`.toLowerCase().includes(q)) return false
        return true
      }),
    [skills, filter, q]
  )
  const current = useMemo(() => (selected === undefined ? view[0] : findSkill(skills, selected)), [selected, view, skills])

  // read the selected skill's size first
  useEffect(() => {
    if (!current?.rel) return
    const id = current.id
    if (finished.current.has(id) || inflight.current.has(id)) return
    queue.current = [id, ...queue.current.filter((x) => x !== id)]
    pump()
  }, [current, pump])

  const toOn = view.filter((s) => s.override === 'off')
  const toOff = view.filter((s) => s.source !== 'override' && s.override !== 'off' && s.pluginEnabled !== false)

  async function applyBulk(): Promise<void> {
    if (!bulk) return
    setBulkBusy(true)
    try {
      const r = await api.skills.setEnabled(bulk.keys, bulk.enabled)
      notify.saved(r.snapshotId, 'Saved.', { changed: r.changed > 0, message: 'Nothing needed to change.' })
      setBulk(null)
      reload()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBulkBusy(false)
    }
  }

  async function create(name: string): Promise<void> {
    setCreateBusy(true)
    try {
      const r = await api.skills.create(name)
      notify.saved(null, `Created skills/${name}/SKILL.md. Edit it to describe the skill.`)
      setCreating(false)
      setFilter('all')
      setQuery('')
      guard.request(r.id)
      reload()
    } catch (e) {
      notify.failed(e)
    } finally {
      setCreateBusy(false)
    }
  }

  const groups: Array<{ key: string; title: string; items: SkillInfo[] }> = [
    { key: 'user', title: 'Your skills', items: view.filter((s) => s.source === 'user') },
    { key: 'synced', title: 'Synced skills', items: view.filter((s) => s.source === 'synced') },
    { key: 'plugin', title: 'Plugin skills', items: view.filter((s) => s.source === 'plugin') },
    { key: 'override', title: 'Override only', items: view.filter((s) => s.source === 'override') }
  ]

  const list = (
    <ListPane
      title="Skills"
      count={data ? view.length : undefined}
      actions={<IconButton aria-label="New skill" icon={<Plus />} onClick={() => setCreating(true)} />}
      search={{ value: query, onChange: setQuery, placeholder: 'Filter skills' }}
      filters={
        <>
          <Chip selected={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
            All
          </Chip>
          <Chip selected={filter === 'on'} onClick={() => setFilter('on')} count={counts.on}>
            On
          </Chip>
          <Chip selected={filter === 'off'} onClick={() => setFilter('off')} count={counts.off}>
            Off
          </Chip>
          <Chip selected={filter === 'synced'} onClick={() => setFilter('synced')} count={counts.synced}>
            Synced
          </Chip>
          <Chip selected={filter === 'plugin'} onClick={() => setFilter('plugin')} count={counts.plugin}>
            Plugin
          </Chip>
        </>
      }
      loading={loading}
      error={data?.settingsError ?? (data ? error : null)}
      isEmpty={!!data && view.length === 0}
      empty={
        skills.length === 0 ? (
          <EmptyState
            icon={<Sparkles />}
            title="No skills yet"
            description="A skill is a folder with a SKILL.md that teaches Claude one task. Create one and Claude will use it when it fits."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                New skill
              </Button>
            }
          />
        ) : (
          <EmptyState title="No skills match" description="Try another filter or clear the search." />
        )
      }
      footer={
        data && view.length > 0 ? (
          <div className="ext-toggle-row">
            <Button variant="secondary" disabled={toOff.length === 0} onClick={() => setBulk({ enabled: false, keys: toOff.map((s) => s.key) })}>
              Turn off all in view{toOff.length ? ` (${toOff.length})` : ''}
            </Button>
            <Button variant="secondary" disabled={toOn.length === 0} onClick={() => setBulk({ enabled: true, keys: toOn.map((s) => s.key) })}>
              Turn on{toOn.length ? ` (${toOn.length})` : ''}
            </Button>
          </div>
        ) : undefined
      }
    >
      {data
        ? groups
            .filter((g) => g.items.length > 0)
            .flatMap((g) => [
              <ListGroup key={`g:${g.key}`}>
                {g.title} · {g.items.length}
              </ListGroup>,
              ...g.items.map((s) => {
                const sz = sizes[s.id]
                return (
                  <ListRow
                    key={s.id}
                    leading={<Dot on={s.enabled} />}
                    title={s.name}
                    subtitle={stateText(s)}
                    meta={sz && sz !== 'err' ? <span className="ext-size">{formatBytes(sz.bytes)}</span> : undefined}
                    dimmed={!s.enabled}
                    selected={current?.id === s.id}
                    onSelect={() => guard.request(s.id)}
                  />
                )
              })
            ])
        : undefined}
    </ListPane>
  )

  let detail: JSX.Element
  if (!data && loading) {
    detail = (
      <div className="empty">
        <Spinner />
      </div>
    )
  } else if (!data) {
    detail = (
      <EmptyState
        title="Could not load skills"
        description={error ?? 'Something went wrong.'}
        action={
          <Button variant="primary" onClick={reload}>
            Try again
          </Button>
        }
      />
    )
  } else if (!current) {
    detail = <EmptyState icon={<Sparkles />} title="Select a skill" description="Pick a skill on the left to see what it does and turn it on or off." />
  } else if (current.source === 'override') {
    detail = (
      <OverrideDetail
        key={current.id}
        skill={current}
        onDone={() => {
          reload()
          setSelected(undefined)
        }}
      />
    )
  } else {
    detail = (
      <SkillDetail
        key={current.id}
        skill={current}
        size={sizes[current.id]}
        setDirty={guard.setDirty}
        onChanged={reload}
        onGone={() => {
          reload()
          setSelected(undefined)
        }}
        onOpen={(id) => {
          reload()
          setFilter('all')
          setQuery('')
          setSelected(id)
        }}
      />
    )
  }

  return (
    <>
      <ListDetailLayout list={list} detail={detail} />
      {guard.dialog}
      <PromptDialog
        open={creating}
        title="New skill"
        label="Skill name"
        hint="Lowercase letters, numbers and hyphens. This becomes the folder name."
        placeholder="my-skill"
        mono
        confirmLabel="Create skill"
        busy={createBusy}
        validate={(v) => (!v ? 'Enter a name.' : !SKILL_NAME_RE.test(v) ? 'Use lowercase letters, numbers and hyphens (up to 64).' : isReservedName(v) ? RESERVED_NAME_ERROR : skills.some((s) => s.source === 'user' && s.rel === `skills/${v}`) ? 'A skill with this name already exists.' : null)}
        onSubmit={(v) => void create(v)}
        onCancel={() => setCreating(false)}
      />
      <ConfirmDialog
        open={bulk !== null}
        title={bulk ? `Turn ${bulk.enabled ? 'on' : 'off'} ${bulk.keys.length} skill${bulk.keys.length === 1 ? '' : 's'}?` : ''}
        description={
          bulk
            ? `This changes skillOverrides in settings.json for every skill in the current view (filter and search applied). A snapshot is kept in Backups, so you can undo it.`
            : undefined
        }
        confirmLabel={bulk ? `Turn ${bulk.enabled ? 'on' : 'off'} ${bulk.keys.length}` : 'Confirm'}
        busy={bulkBusy}
        onConfirm={() => void applyBulk()}
        onCancel={() => setBulk(null)}
      />
    </>
  )
}

/* ------------------------------------------------------------------ override-only */

function OverrideDetail({ skill, onDone }: { skill: SkillInfo; onDone: () => void }): JSX.Element {
  const notify = useNotify()
  const [busy, setBusy] = useState(false)
  async function clear(): Promise<void> {
    setBusy(true)
    try {
      const r = await api.skills.setEnabled([skill.key], true)
      notify.saved(r.snapshotId, 'Override cleared.', { changed: r.changed > 0, message: 'Override already cleared.' })
      onDone()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <DetailPane
      title={skill.name}
      badges={<Badge tone="oat">override only</Badge>}
      actions={
        <Button variant="primary" loading={busy} onClick={() => void clear()}>
          Clear override
        </Button>
      }
    >
      <div className="ext-body">
        <p className="ext-desc">
          settings.json has an override for <span className="ext-mono">{skill.key}</span> ({skill.override}), but no skill with that name is installed. It has no effect. Clear it to keep skillOverrides tidy.
        </p>
        <p className="ext-foot">Clearing it removes the key from skillOverrides in settings.json. A snapshot is kept in Backups.</p>
      </div>
    </DetailPane>
  )
}

/* ------------------------------------------------------------------ skill detail */

function sourceLine(s: SkillInfo): string {
  if (s.source === 'user') return s.symlink ? 'your skill (symlink)' : 'your skill'
  if (s.source === 'synced') {
    const bits = ['synced skill']
    if (s.syncSource) bits.push(s.syncSource)
    if (s.copies && s.copies > 1) bits.push(`${s.copies} copies, newest shown`)
    return bits.join(' · ')
  }
  return `plugin ${s.plugin}`
}

function SkillDetail({
  skill,
  size,
  setDirty,
  onChanged,
  onGone,
  onOpen
}: {
  skill: SkillInfo
  size: SizeInfo | undefined
  setDirty: (d: boolean) => void
  onChanged: () => void
  onGone: () => void
  onOpen: (id: string) => void
}): JSX.Element {
  const notify = useNotify()
  const { navigate } = useNav()
  const [tab, setTab] = useState<'md' | 'files'>('md')
  const [busy, setBusy] = useState(false)
  const [confirmTrash, setConfirmTrash] = useState(false)
  const [confirmCopy, setConfirmCopy] = useState(false)
  const pluginOff = skill.source === 'plugin' && skill.pluginEnabled === false

  async function toggle(next: boolean): Promise<void> {
    setBusy(true)
    try {
      const r = await api.skills.setEnabled([skill.key], next)
      notify.saved(r.snapshotId, 'Saved.', { changed: r.changed > 0, message: 'Nothing needed to change.' })
      onChanged()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(false)
    }
  }

  async function duplicate(): Promise<void> {
    setConfirmCopy(false)
    setBusy(true)
    try {
      const r = await api.skills.duplicate(skill.id)
      notify.saved(null, `Copied to ${r.id}.`)
      onOpen(r.id)
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(false)
    }
  }

  async function trash(): Promise<void> {
    setBusy(true)
    try {
      await api.skills.trash(skill.id)
      notify.saved(null, `Moved ${skill.name} to the Trash.`)
      setConfirmTrash(false)
      onGone()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(false)
    }
  }

  const sizeText = size === undefined ? 'calculating size…' : size === 'err' ? 'size unavailable' : `${formatBytes(size.bytes)} · ${formatCount(size.files)} file${size.files === 1 ? '' : 's'}`
  const user = !skill.readOnly

  return (
    <DetailPane
      title={skill.name}
      path={skill.dir}
      reveal={skill.rel}
      badges={
        <>
          <Badge tone={user ? 'neutral' : 'oat'}>{skill.label}</Badge>
          {skill.symlink ? <Badge>symlink</Badge> : null}
          {skill.override && skill.override !== 'off' ? <Badge>override: {skill.override}</Badge> : null}
        </>
      }
      actions={
        <>
          <Button variant="primary" icon={<ExternalLink size={14} />} onClick={() => void api.system.openInEditor(skill.skillFile).catch(notify.failed)}>
            Open in editor
          </Button>
          <Button variant="secondary" onClick={() => void api.system.reveal(skill.skillFile).catch(notify.failed)}>
            Reveal
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            title={user ? undefined : 'Make an editable copy in your own skills'}
            onClick={() => (size && size !== 'err' && size.bytes > BIG_COPY_BYTES ? setConfirmCopy(true) : void duplicate())}
          >
            {user ? 'Duplicate' : 'Copy to my skills'}
          </Button>
          <Spacer />
          {user ? (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmTrash(true)}>
              Move to Trash
            </Button>
          ) : null}
        </>
      }
    >
      <div className="ext-body">
        <div className="ext-metaline">
          {sizeText} · {sourceLine(skill)}
        </div>

        <div className="ext-toggle-row">
          <Toggle checked={skill.enabled} disabled={busy || pluginOff} onChange={(v) => void toggle(v)} label="Enabled" />
          {pluginOff ? (
            <span className="ext-hint">
              The plugin {skill.plugin} is off, so its skills are not loaded.{' '}
              <button type="button" className="ext-link" onClick={() => navigate('plugins', `${skill.plugin}`)}>
                Open Plugins
              </button>
            </span>
          ) : null}
        </div>

        <p className={skill.description ? 'ext-desc' : 'ext-desc ext-desc--muted'}>{skill.description || 'This skill has no description in its frontmatter, so Claude has little to go on.'}</p>

        <div className="ext-card">
          <Tabs
            label="Skill content"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'md', label: 'SKILL.md' },
              { value: 'files', label: 'Files' }
            ]}
          />
          {tab === 'md' ? (
            <SkillMdTab skill={skill} editable={user} setDirty={setDirty} onSaved={onChanged} />
          ) : (
            <div className="ext-card__content ext-card__content--flush">
              <FileTree skillId={skill.id} skillRel={skill.rel} />
            </div>
          )}
        </div>

        <p className="ext-foot">Turning a skill on or off writes skillOverrides in settings.json. A snapshot is kept in Backups.</p>
      </div>

      <ConfirmDialog
        open={confirmTrash}
        title={`Move ${skill.name} to Trash?`}
        description={`The skill folder${size && size !== 'err' ? ` (${formatBytes(size.bytes)}, ${formatCount(size.files)} files)` : ''} goes to the Trash. You can put it back from there. Any override for it stays in settings.json.`}
        confirmLabel="Move to Trash"
        tone="danger"
        busy={busy}
        onConfirm={() => void trash()}
        onCancel={() => setConfirmTrash(false)}
      />
      <ConfirmDialog
        open={confirmCopy}
        title="Copy a large skill?"
        description={`This skill is ${size && size !== 'err' ? formatBytes(size.bytes) : 'large'}. Copying duplicates every file and can take a while.`}
        confirmLabel="Copy it"
        onConfirm={() => void duplicate()}
        onCancel={() => setConfirmCopy(false)}
      />
    </DetailPane>
  )
}

/* ------------------------------------------------------------------ SKILL.md tab */

function SkillMdTab({ skill, editable, setDirty, onSaved }: { skill: SkillInfo; editable: boolean; setDirty: (d: boolean) => void; onSaved: () => void }): JSX.Element {
  const notify = useNotify()
  const { data: doc, error, loading, reload } = useApi(() => api.skills.read(skill.id), [skill.id])
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => setDraft(null), [doc])
  const dirty = draft !== null && doc !== undefined && draft !== doc.text
  useNavGuard(dirty)
  useEffect(() => {
    setDirty(dirty)
    return () => setDirty(false)
  }, [dirty, setDirty])

  const fm = useMemo(() => parseFrontmatter(doc?.text ?? ''), [doc])
  useSaveShortcut(dirty && editable && !!doc && !doc.truncated, () => void save())

  async function save(): Promise<void> {
    if (!doc || draft === null || draft === doc.text || saving) return
    setSaving(true)
    try {
      const r = await api.skills.save(skill.id, draft, doc.mtimeMs)
      notify.saved(r.snapshotId)
      reload()
      onSaved()
    } catch (e) {
      notify.failed(e)
    } finally {
      setSaving(false)
    }
  }

  if (error && !doc) {
    return (
      <div className="ext-card__content">
        <p className="ext-error" role="alert">
          {error}
        </p>
      </div>
    )
  }
  if (!doc) {
    return (
      <div className="ext-card__content">
        <Spinner />
      </div>
    )
  }
  const canEdit = editable && !doc.truncated
  return (
    <div className="ext-card__content">
      {doc.truncated ? <p className="ext-hint">This file is {formatBytes(doc.size)}. Only the first 1.5 MB is shown and it cannot be edited here.</p> : null}
      {!canEdit && !doc.truncated ? <p className="ext-hint">{skill.source === 'plugin' ? 'Provided by a plugin' : 'Synced from your Claude account'}, so it is read-only here.</p> : null}
      <FrontmatterFacts data={fm.data} skip={['name', 'description']} />
      <MarkdownPane
        label="SKILL.md"
        value={draft ?? doc.text}
        onChange={setDraft}
        editable={canEdit}
        onSave={() => void save()}
        toolbar={
          dirty ? (
            <>
              <span className="ext-savebar__status">Unsaved changes</span>
              <Button variant="secondary" onClick={() => setDraft(null)} disabled={saving}>
                Revert
              </Button>
              <Button variant="primary" onClick={() => void save()} loading={saving}>
                Save
              </Button>
            </>
          ) : loading ? (
            <Spinner size={14} />
          ) : null
        }
      />
    </div>
  )
}
