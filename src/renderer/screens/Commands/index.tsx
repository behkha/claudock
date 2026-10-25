import { useMemo, useState } from 'react'
import { ExternalLink, Plus, Terminal } from 'lucide-react'
import { COMMAND_MODELS, parseCommandName, type CommandFields, type CommandInfo } from '@shared/api/commands'
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
import { PromptDialog, Spacer, useDirtyGuard, useNotify } from '../_ext/ui'

type Filter = 'all' | 'user' | 'plugin'

function findCommand(list: CommandInfo[], sel: string): CommandInfo | undefined {
  const bare = sel.replace(/^\//, '')
  return list.find((c) => c.id === sel) ?? list.find((c) => c.name === bare)
}

const nameProblem = (v: string, existing: string[], self?: string): string | null => {
  const p = parseCommandName(v)
  if ('error' in p) return p.error
  const name = p.parts.join(':')
  return name !== self && existing.includes(name) ? `/${name} already exists.` : null
}

export default function CommandsScreen({ selectId }: ScreenProps): JSX.Element {
  const { data, error, loading, reload } = useApi(() => api.commands.list(), [])
  const [selected, setSelected] = useSelectId(selectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const notify = useNotify()
  const guard = useDirtyGuard(setSelected)

  const commands = useMemo(() => data?.commands ?? [], [data])
  const userNames = useMemo(() => commands.filter((c) => c.source === 'user').map((c) => c.name), [commands])
  const q = query.trim().toLowerCase()
  const view = useMemo(
    () =>
      commands.filter((c) => {
        if (filter !== 'all' && c.source !== filter) return false
        return !q || `${c.name} ${c.description}`.toLowerCase().includes(q)
      }),
    [commands, filter, q]
  )
  const current = useMemo(() => (selected === undefined ? view[0] : findCommand(commands, selected)), [selected, view, commands])
  const nUser = userNames.length

  async function create(name: string): Promise<void> {
    setBusy(true)
    try {
      const r = await api.commands.create(name)
      notify.saved(null, `Created ${r.id}.`)
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
    { key: 'user', title: 'Your commands', items: view.filter((c) => c.source === 'user') },
    { key: 'plugin', title: 'Plugin commands', items: view.filter((c) => c.source === 'plugin') }
  ].filter((g) => g.items.length > 0)

  const list = (
    <ListPane
      title="Commands"
      count={data ? commands.length : undefined}
      actions={<IconButton aria-label="New command" icon={<Plus />} onClick={() => setCreating(true)} />}
      search={{ value: query, onChange: setQuery, placeholder: 'Filter commands' }}
      filters={
        <>
          <Chip selected={filter === 'all'} onClick={() => setFilter('all')} count={commands.length}>
            All
          </Chip>
          <Chip selected={filter === 'user'} onClick={() => setFilter('user')} count={nUser}>
            Yours
          </Chip>
          <Chip selected={filter === 'plugin'} onClick={() => setFilter('plugin')} count={commands.length - nUser}>
            Plugin
          </Chip>
        </>
      }
      loading={loading}
      error={data ? error : null}
      isEmpty={!!data && view.length === 0}
      empty={
        commands.length === 0 ? (
          <EmptyState
            icon={<Terminal />}
            title="No commands yet"
            description="A command is a saved prompt you run by typing a slash and its name in Claude Code."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                New command
              </Button>
            }
          />
        ) : (
          <EmptyState title="No commands match" description="Try another filter or clear the search." />
        )
      }
    >
      {data
        ? groups.flatMap((g) => [
            <ListGroup key={`g:${g.key}`}>
              {g.title} · {g.items.length}
            </ListGroup>,
            ...g.items.map((c) => (
              <ListRow
                key={c.id}
                leading={<Terminal size={16} strokeWidth={1.8} />}
                title={`/${c.name}`}
                subtitle={c.description || 'No description'}
                meta={c.model || undefined}
                selected={current?.id === c.id}
                onSelect={() => guard.request(c.id)}
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
        title="Could not load commands"
        description={error ?? 'Something went wrong.'}
        action={
          <Button variant="primary" onClick={reload}>
            Try again
          </Button>
        }
      />
    )
  } else if (!current) {
    detail = <EmptyState icon={<Terminal />} title="Select a command" description="A command is a saved prompt you run with a slash. Pick one on the left to read or edit it." />
  } else {
    detail = (
      <CommandDetail
        key={current.id}
        command={current}
        userNames={userNames}
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
        title="New command"
        label="Command name"
        hint="Use a colon for folders: frontend:review is saved as commands/frontend/review.md."
        placeholder="review"
        mono
        confirmLabel="Create command"
        busy={busy}
        validate={(v) => nameProblem(v, userNames)}
        onSubmit={(v) => void create(v)}
        onCancel={() => setCreating(false)}
      />
    </>
  )
}

function CommandDetail({
  command,
  userNames,
  setDirty,
  onChanged,
  onGone,
  onOpen
}: {
  command: CommandInfo
  userNames: string[]
  setDirty: (d: boolean) => void
  onChanged: () => void
  onGone: () => void
  onOpen: (id: string) => void
}): JSX.Element {
  const notify = useNotify()
  const { data: doc, error, reload } = useApi(() => api.commands.read(command.id), [command.id])
  const [confirmTrash, setConfirmTrash] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function rename(name: string): Promise<void> {
    setBusy(true)
    try {
      const r = await api.commands.rename(command.id, name)
      notify.saved(null, `Renamed to /${name.replace(/^\//, '').replace(/\//g, ':')}. The old file is in the Trash.`)
      setRenaming(false)
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
      await api.commands.trash(command.id)
      notify.saved(null, `Moved /${command.name} to the Trash.`)
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
      title={`/${command.name}`}
      path={command.path}
      reveal={command.id}
      badges={<Badge tone={command.readOnly ? 'oat' : 'neutral'}>{command.label}</Badge>}
      actions={
        <>
          <Button variant="primary" icon={<ExternalLink size={14} />} onClick={() => void api.system.openInEditor(command.id).catch(notify.failed)}>
            Open in editor
          </Button>
          <Button variant="secondary" onClick={() => void api.system.reveal(command.id).catch(notify.failed)}>
            Reveal
          </Button>
          {command.readOnly ? null : (
            <Button variant="secondary" disabled={busy} onClick={() => setRenaming(true)}>
              Rename
            </Button>
          )}
          <Spacer />
          {command.readOnly ? null : (
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
        ) : command.readOnly ? (
          <>
            <p className="ext-hint">Provided by the plugin {command.plugin}, so it is read-only here. {formatBytes(doc.size)}.</p>
            <div className="ext-card">
              <div className="ext-card__content">
                <MarkdownView source={doc.text} />
              </div>
            </div>
          </>
        ) : (
          <DocEditor<CommandFields>
            doc={doc}
            bodyLabel="Prompt"
            fileLabel="Command file"
            renderForm={(f, patch, disabled) => <CommandForm fields={f} patch={patch} disabled={disabled} />}
            saveForm={(fields, body, base) => api.commands.save(command.id, { fields, body, baseMtimeMs: base })}
            saveRaw={(text, base) => api.commands.saveRaw(command.id, text, base)}
            onSaved={() => {
              reload()
              onChanged()
            }}
            onDirty={setDirty}
          />
        )}
        <p className="ext-foot">Saving rewrites only the fields you changed. A snapshot of the previous file is kept in Backups.</p>
      </div>
      <PromptDialog
        open={renaming}
        title="Rename command"
        label="New name"
        hint="Use a colon for folders: frontend:review. The old file goes to the Trash."
        initial={command.name}
        mono
        confirmLabel="Rename"
        busy={busy}
        validate={(v) => nameProblem(v, userNames, command.name)}
        onSubmit={(v) => void rename(v)}
        onCancel={() => setRenaming(false)}
      />
      <ConfirmDialog
        open={confirmTrash}
        title={`Move /${command.name} to Trash?`}
        description="The command file goes to the Trash. You can put it back from there."
        confirmLabel="Move to Trash"
        tone="danger"
        busy={busy}
        onConfirm={() => void trash()}
        onCancel={() => setConfirmTrash(false)}
      />
    </DetailPane>
  )
}

function CommandForm({ fields, patch, disabled }: { fields: CommandFields; patch: (p: Partial<CommandFields>) => void; disabled: boolean }): JSX.Element {
  const models = COMMAND_MODELS.includes(fields.model) || fields.model === '' ? COMMAND_MODELS : [...COMMAND_MODELS, fields.model]
  return (
    <div className="ext-form">
      <TextField label="Description" value={fields.description} disabled={disabled} hint="Shown next to the command in the slash menu." onChange={(e) => patch({ description: e.target.value })} />
      <div className="ext-form__row">
        <TextField label="Argument hint" mono value={fields.argumentHint} disabled={disabled} placeholder="[message]" hint="Shown after the command name." onChange={(e) => patch({ argumentHint: e.target.value })} />
        <Select label="Model" value={fields.model} disabled={disabled} onChange={(v) => patch({ model: v })} options={[{ value: '', label: 'Not set' }, ...models.map((m) => ({ value: m, label: m }))]} />
      </div>
      <TextField
        label="Allowed tools"
        mono
        multiline
        rows={2}
        value={fields.allowedTools}
        disabled={disabled}
        placeholder="Bash(git add:*), Bash(git commit:*)"
        hint="Tools the command may use without asking, separated by commas."
        onChange={(e) => patch({ allowedTools: e.target.value })}
      />
    </div>
  )
}
