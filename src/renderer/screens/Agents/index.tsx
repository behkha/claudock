import { useMemo, useState } from 'react'
import { Bot, ExternalLink, Plus } from 'lucide-react'
import { RESERVED_NAME_ERROR, isReservedName } from '@shared/names'
import { AGENT_COLORS, AGENT_MODELS, AGENT_NAME_RE, type AgentFields, type AgentInfo } from '@shared/api/agents'
import { formatBytes } from '@shared/format'
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
  MarkdownView,
  Select,
  Spinner,
  TextField
} from '@/components'
import { api, useApi } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import type { ScreenProps } from '@/lib/nav'
import { DocEditor } from '../_ext/DocEditor'
import { ChipList, ChipsInput, Spacer, PromptDialog, useDirtyGuard, useNotify } from '../_ext/ui'

type Filter = 'all' | 'user' | 'plugin'

const TOOL_SUGGESTIONS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit']

function findAgent(list: AgentInfo[], sel: string): AgentInfo | undefined {
  return list.find((a) => a.id === sel) ?? list.find((a) => a.name === sel)
}

export default function AgentsScreen({ selectId }: ScreenProps): JSX.Element {
  const { data, error, loading, reload } = useApi(() => api.agents.list(), [])
  const [selected, setSelected] = useSelectId(selectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const notify = useNotify()
  const guard = useDirtyGuard(setSelected)

  const agents = useMemo(() => data?.agents ?? [], [data])
  const q = query.trim().toLowerCase()
  const view = useMemo(
    () =>
      agents.filter((a) => {
        if (filter !== 'all' && a.source !== filter) return false
        return !q || `${a.name} ${a.description} ${a.label}`.toLowerCase().includes(q)
      }),
    [agents, filter, q]
  )
  const current = useMemo(() => (selected === undefined ? view[0] : findAgent(agents, selected)), [selected, view, agents])
  const nUser = agents.filter((a) => a.source === 'user').length
  const nPlugin = agents.length - nUser

  async function create(name: string): Promise<void> {
    setBusy(true)
    try {
      const r = await api.agents.create(name)
      notify.saved(null, `Created ${r.id}. Describe when Claude should use it.`)
      setCreating(false)
      setFilter('all')
      setQuery('')
      guard.request(r.id)
      reload()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(false)
    }
  }

  const groups = [
    { key: 'user', title: 'Your agents', items: view.filter((a) => a.source === 'user') },
    { key: 'plugin', title: 'Plugin agents', items: view.filter((a) => a.source === 'plugin') }
  ].filter((g) => g.items.length > 0)

  const list = (
    <ListPane
      title="Agents"
      count={data ? agents.length : undefined}
      actions={<IconButton aria-label="New agent" icon={<Plus />} onClick={() => setCreating(true)} />}
      search={{ value: query, onChange: setQuery, placeholder: 'Filter agents' }}
      filters={
        <>
          <Chip selected={filter === 'all'} onClick={() => setFilter('all')} count={agents.length}>
            All
          </Chip>
          <Chip selected={filter === 'user'} onClick={() => setFilter('user')} count={nUser}>
            Yours
          </Chip>
          <Chip selected={filter === 'plugin'} onClick={() => setFilter('plugin')} count={nPlugin}>
            Plugin
          </Chip>
        </>
      }
      loading={loading}
      error={data ? error : null}
      isEmpty={!!data && view.length === 0}
      empty={
        agents.length === 0 ? (
          <EmptyState
            icon={<Bot />}
            title="No agents yet"
            description="An agent is a specialist Claude can hand work to, with its own instructions and tools. Create one to start."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                New agent
              </Button>
            }
          />
        ) : (
          <EmptyState title="No agents match" description="Try another filter or clear the search." />
        )
      }
    >
      {data
        ? groups.flatMap((g) => [
            <ListGroup key={`g:${g.key}`}>
              {g.title} · {g.items.length}
            </ListGroup>,
            ...g.items.map((a) => (
              <ListRow
                key={a.id}
                leading={<Bot size={16} strokeWidth={1.8} />}
                title={a.name}
                subtitle={a.description || 'No description'}
                meta={a.model || undefined}
                selected={current?.id === a.id}
                onSelect={() => guard.request(a.id)}
              />
            ))
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
        title="Could not load agents"
        description={error ?? 'Something went wrong.'}
        action={
          <Button variant="primary" onClick={reload}>
            Try again
          </Button>
        }
      />
    )
  } else if (!current) {
    detail = <EmptyState icon={<Bot />} title="Select an agent" description="Pick an agent on the left to read or edit it." />
  } else {
    detail = (
      <AgentDetail
        key={current.id}
        agent={current}
        setDirty={guard.setDirty}
        onChanged={reload}
        onGone={() => {
          reload()
          setSelected(undefined)
        }}
        onOpen={(id) => {
          reload()
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
        title="New agent"
        label="Agent name"
        hint="Lowercase letters, numbers and hyphens. This is also the file name."
        placeholder="code-reviewer"
        mono
        confirmLabel="Create agent"
        busy={busy}
        validate={(v) => (!v ? 'Enter a name.' : !AGENT_NAME_RE.test(v) ? 'Use lowercase letters, numbers and hyphens (up to 64).' : isReservedName(v) ? RESERVED_NAME_ERROR : agents.some((a) => a.id === `agents/${v}.md`) ? 'An agent with this name already exists.' : null)}
        onSubmit={(v) => void create(v)}
        onCancel={() => setCreating(false)}
      />
    </>
  )
}

function AgentDetail({
  agent,
  setDirty,
  onChanged,
  onGone,
  onOpen
}: {
  agent: AgentInfo
  setDirty: (d: boolean) => void
  onChanged: () => void
  onGone: () => void
  onOpen: (id: string) => void
}): JSX.Element {
  const notify = useNotify()
  const { data: doc, error, reload } = useApi(() => api.agents.read(agent.id), [agent.id])
  const [confirmTrash, setConfirmTrash] = useState(false)
  const [busy, setBusy] = useState(false)

  async function duplicate(): Promise<void> {
    setBusy(true)
    try {
      const r = await api.agents.duplicate(agent.id)
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
      await api.agents.trash(agent.id)
      notify.saved(null, `Moved ${agent.name} to the Trash.`)
      setConfirmTrash(false)
      onGone()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DetailPane
      title={agent.name}
      path={agent.path}
      reveal={agent.id}
      badges={<Badge tone={agent.readOnly ? 'oat' : 'neutral'}>{agent.label}</Badge>}
      actions={
        <>
          <Button variant="primary" icon={<ExternalLink size={14} />} onClick={() => void api.system.openInEditor(agent.id).catch(notify.failed)}>
            Open in editor
          </Button>
          <Button variant="secondary" onClick={() => void api.system.reveal(agent.id).catch(notify.failed)}>
            Reveal
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void duplicate()} title={agent.readOnly ? 'Make an editable copy in your own agents' : undefined}>
            {agent.readOnly ? 'Copy to my agents' : 'Duplicate'}
          </Button>
          <Spacer />
          {agent.readOnly ? null : (
            <Button variant="danger" disabled={busy} onClick={() => setConfirmTrash(true)}>
              Move to Trash
            </Button>
          )}
        </>
      }
    >
      <div className="ext-body">
        {error && !doc ? (
          <p className="ext-error" role="alert">
            {error}
          </p>
        ) : !doc ? (
          <Spinner />
        ) : agent.readOnly ? (
          <>
            <p className="ext-hint">Provided by the plugin {agent.plugin}, so it is read-only here. {formatBytes(doc.size)}.</p>
            <ReadOnlyFacts fields={doc.fields} />
            <div className="ext-card">
              <div className="ext-card__content">
                <MarkdownView source={doc.text} />
              </div>
            </div>
          </>
        ) : (
          <DocEditor<AgentFields>
            doc={doc}
            bodyLabel="Instructions"
            fileLabel="Agent file"
            validate={(f) => (!f.name.trim() ? 'Enter a name.' : null)}
            renderForm={(f, patch, disabled) => <AgentForm fields={f} patch={patch} disabled={disabled} original={doc.fields.name} />}
            saveForm={(fields, body, base) => api.agents.save(agent.id, { fields, body, baseMtimeMs: base })}
            saveRaw={(text, base) => api.agents.saveRaw(agent.id, text, base)}
            onSaved={() => {
              reload()
              onChanged()
            }}
            onDirty={setDirty}
          />
        )}
        <p className="ext-foot">Saving rewrites only the fields you changed. A snapshot of the previous file is kept in Backups.</p>
      </div>
      <ConfirmDialog
        open={confirmTrash}
        title={`Move ${agent.name} to Trash?`}
        description="The agent file goes to the Trash. You can put it back from there."
        confirmLabel="Move to Trash"
        tone="danger"
        busy={busy}
        onConfirm={() => void trash()}
        onCancel={() => setConfirmTrash(false)}
      />
    </DetailPane>
  )
}

function ReadOnlyFacts({ fields }: { fields: AgentFields }): JSX.Element {
  return (
    <dl className="ext-deflist">
      <dt>Description</dt>
      <dd>{fields.description || '—'}</dd>
      <dt>Model</dt>
      <dd>{fields.model || 'Not set'}</dd>
      <dt>Tools</dt>
      <dd>
        <ChipList items={fields.tools} empty="All tools" />
      </dd>
      {fields.color ? (
        <>
          <dt>Color</dt>
          <dd>{fields.color}</dd>
        </>
      ) : null}
    </dl>
  )
}

function AgentForm({ fields, patch, disabled, original }: { fields: AgentFields; patch: (p: Partial<AgentFields>) => void; disabled: boolean; original: string }): JSX.Element {
  const nameChanged = fields.name.trim() !== original
  const nameError = !fields.name.trim() ? 'Enter a name.' : nameChanged && !AGENT_NAME_RE.test(fields.name.trim()) ? 'Use lowercase letters, numbers and hyphens (up to 64).' : nameChanged && isReservedName(fields.name) ? RESERVED_NAME_ERROR : undefined
  const models = AGENT_MODELS.includes(fields.model) || fields.model === '' ? AGENT_MODELS : [...AGENT_MODELS, fields.model]
  const colors = AGENT_COLORS.includes(fields.color) || fields.color === '' ? AGENT_COLORS : [...AGENT_COLORS, fields.color]
  return (
    <div className="ext-form">
      <TextField label="Name" mono value={fields.name} error={nameError} disabled={disabled} spellCheck={false} onChange={(e) => patch({ name: e.target.value })} />
      <TextField
        label="Description"
        multiline
        rows={3}
        value={fields.description}
        disabled={disabled}
        hint="Claude reads this to decide when to hand work to the agent. Say what it does and when to use it."
        onChange={(e) => patch({ description: e.target.value })}
      />
      <div className="ext-form__row">
        <Select
          label="Model"
          value={fields.model}
          disabled={disabled}
          onChange={(v) => patch({ model: v })}
          options={[{ value: '', label: 'Not set' }, ...models.map((m) => ({ value: m, label: m === 'inherit' ? 'inherit (use the session model)' : m }))]}
        />
        <Select label="Color" value={fields.color} disabled={disabled} onChange={(v) => patch({ color: v })} options={[{ value: '', label: 'None' }, ...colors.map((c) => ({ value: c, label: c }))]} />
      </div>
      <div className="ext-field">
        <span className="ext-label">Tools</span>
        <ChipsInput aria-label="Tools" value={fields.tools} onChange={(tools) => patch({ tools })} suggestions={TOOL_SUGGESTIONS} placeholder="All tools. Type a name to limit them." disabled={disabled} />
        <span className="ext-hint">Leave empty and the agent can use every tool. Press Enter to add one.</span>
      </div>
    </div>
  )
}
