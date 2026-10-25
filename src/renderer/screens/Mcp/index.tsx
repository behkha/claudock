import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, Info, Plug, Plus } from 'lucide-react'
import { hasProblems, validateMcp, type McpServer, type McpServerConfig, type McpTransport } from '@shared/api/mcp'
import { tildify } from '@shared/format'
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
  Segmented,
  Spinner,
  TextField
} from '@/components'
import { api, useApi } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import { useNavGuard, type ScreenProps } from '@/lib/nav'
import { KeyValueEditor, ListEditor, Spacer, fromRows, toRows, useDirtyGuard, useNotify, type Rows } from '../_ext/ui'

type Filter = 'all' | 'user' | 'project'

const NEW_ID = 'new'
const userId = (name: string): string => `user:${name}`
const projectId = (path: string, name: string): string => `project:${path}\u0000${name}`

export default function McpScreen({ selectId }: ScreenProps): JSX.Element {
  const { data, error, loading, reload } = useApi(() => api.mcp.list(), [])
  const { data: info } = useApi(() => api.system.configInfo(), [])
  const [selected, setSelected] = useSelectId(selectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const guard = useDirtyGuard(setSelected)

  const user = useMemo(() => data?.user ?? [], [data])
  const projects = useMemo(() => data?.projects ?? [], [data])
  const nProject = projects.reduce((n, p) => n + p.servers.length, 0)
  const q = query.trim().toLowerCase()
  const match = (s: McpServer): boolean => !q || `${s.name} ${s.summary} ${s.transport}`.toLowerCase().includes(q)
  const vu = filter === 'project' ? [] : user.filter(match)
  const vpr = filter === 'user' ? [] : projects.map((p) => ({ ...p, servers: p.servers.filter(match) })).filter((p) => p.servers.length > 0)

  // selection: user:<name>, project:<path>\0<name>, "new", or a bare server name (from the palette)
  const sel = selected
  let selUser: McpServer | undefined
  let selProject: McpServer | undefined
  if (sel?.startsWith('project:')) {
    selProject = projects.flatMap((p) => p.servers).find((s) => projectId(s.projectPath ?? '', s.name) === sel)
  } else if (sel && sel !== NEW_ID) {
    const name = sel.startsWith('user:') ? sel.slice(5) : sel
    selUser = user.find((s) => s.name === name)
  } else if (sel === undefined) {
    selUser = vu[0]
    if (!selUser) selProject = vpr[0]?.servers[0]
  }

  const home = info?.home ?? ''

  const list = (
    <ListPane
      title="MCP servers"
      count={data ? user.length + nProject : undefined}
      actions={<IconButton aria-label="Add MCP server" icon={<Plus />} onClick={() => guard.request(NEW_ID)} />}
      search={{ value: query, onChange: setQuery, placeholder: 'Filter servers' }}
      filters={
        <>
          <Chip selected={filter === 'all'} onClick={() => setFilter('all')} count={user.length + nProject}>
            All
          </Chip>
          <Chip selected={filter === 'user'} onClick={() => setFilter('user')} count={user.length}>
            User
          </Chip>
          <Chip selected={filter === 'project'} onClick={() => setFilter('project')} count={nProject}>
            Project
          </Chip>
        </>
      }
      loading={loading}
      error={data?.error ?? (data ? error : null)}
      isEmpty={!!data && vu.length === 0 && vpr.length === 0}
      empty={
        user.length === 0 && nProject === 0 ? (
          <EmptyState
            icon={<Plug />}
            title="No MCP servers"
            description="An MCP server gives Claude extra tools, such as a database or a browser. Add one and every project can use it."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => guard.request(NEW_ID)}>
                Add server
              </Button>
            }
          />
        ) : (
          <EmptyState title="No servers match" description="Try another filter or clear the search." />
        )
      }
      footer={data ? <span className="ext-mono ext-ellipsis" title={tildify(data.stateFile, home)}>{tildify(data.stateFile, home)}</span> : undefined}
    >
      {data
        ? [
            ...(vu.length > 0
              ? [
                  <ListGroup key="g:user">User servers · {vu.length}</ListGroup>,
                  ...vu.map((s) => (
                    <ListRow
                      key={userId(s.name)}
                      leading={<Plug size={16} strokeWidth={1.8} />}
                      title={s.name}
                      subtitle={s.summary || 'No command or URL'}
                      meta={s.transport}
                      selected={sel === NEW_ID ? false : selUser?.name === s.name}
                      onSelect={() => guard.request(userId(s.name))}
                    />
                  ))
                ]
              : []),
            ...vpr.flatMap((p) => [
              <ListGroup key={`g:${p.path}`}>{tildify(p.path, home)}</ListGroup>,
              ...p.servers.map((s) => (
                <ListRow
                  key={projectId(p.path, s.name)}
                  leading={<Plug size={16} strokeWidth={1.8} />}
                  title={s.name}
                  subtitle={s.summary || 'No command or URL'}
                  meta={s.transport}
                  selected={selProject !== undefined && projectId(selProject.projectPath ?? '', selProject.name) === projectId(p.path, s.name)}
                  onSelect={() => guard.request(projectId(p.path, s.name))}
                />
              ))
            ])
          ]
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
        title="Could not load MCP servers"
        description={error ?? 'Something went wrong.'}
        action={
          <Button variant="primary" onClick={reload}>
            Try again
          </Button>
        }
      />
    )
  } else if (data.error) {
    detail = <EmptyState title="Cannot read the state file" description={data.error} />
  } else if (sel === NEW_ID) {
    detail = (
      <ServerEditor
        key="new"
        server={null}
        stateFile={data.stateFile}
        names={user.map((s) => s.name)}
        setDirty={guard.setDirty}
        onSaved={(name) => {
          reload()
          setSelected(userId(name))
        }}
        onCancel={() => guard.request(undefined)}
      />
    )
  } else if (selUser) {
    detail = (
      <ServerEditor
        key={userId(selUser.name)}
        server={selUser}
        stateFile={data.stateFile}
        names={user.map((s) => s.name)}
        setDirty={guard.setDirty}
        onSaved={(name) => {
          reload()
          setSelected(userId(name))
        }}
        onRemoved={() => {
          reload()
          setSelected(undefined)
        }}
      />
    )
  } else if (selProject) {
    detail = <ProjectServer key={projectId(selProject.projectPath ?? '', selProject.name)} server={selProject} home={home} />
  } else {
    detail = <EmptyState icon={<Plug />} title="Select a server" description="Pick a server on the left to see how it starts, or add a new one." />
  }

  return (
    <>
      <ListDetailLayout list={list} detail={detail} />
      {guard.dialog}
    </>
  )
}

/* ------------------------------------------------------------------ editor */

const KNOWN = ['type', 'command', 'args', 'env', 'url', 'headers']

interface FormState {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  env: Rows
  url: string
  headers: Rows
}

function initial(server: McpServer | null): FormState {
  const c = server?.config ?? {}
  const t: McpTransport = server && server.transport !== 'unknown' ? server.transport : 'stdio'
  return {
    name: server?.name ?? '',
    transport: t,
    command: typeof c.command === 'string' ? c.command : '',
    args: Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [],
    env: toRows(c.env as Record<string, string> | undefined),
    url: typeof c.url === 'string' ? c.url : '',
    headers: toRows(c.headers as Record<string, string> | undefined)
  }
}

function buildConfig(f: FormState, server: McpServer | null): McpServerConfig {
  const extras: McpServerConfig = {}
  for (const [k, v] of Object.entries(server?.config ?? {})) if (!KNOWN.includes(k)) extras[k] = v
  if (f.transport === 'stdio') {
    const c: McpServerConfig = { ...extras, type: 'stdio', command: f.command.trim() }
    const args = f.args.filter((a) => a !== '')
    if (args.length) c.args = args
    const env = fromRows(f.env)
    if (Object.keys(env).length) c.env = env
    return c
  }
  const c: McpServerConfig = { ...extras, type: f.transport, url: f.url.trim() }
  const headers = fromRows(f.headers)
  if (Object.keys(headers).length) c.headers = headers
  return c
}

const dupKeys = (rows: Rows): boolean => {
  const keys = rows.map(([k]) => k.trim()).filter(Boolean)
  return new Set(keys).size !== keys.length
}

function ServerEditor({
  server,
  stateFile,
  names,
  setDirty,
  onSaved,
  onRemoved,
  onCancel
}: {
  server: McpServer | null
  stateFile: string
  names: string[]
  setDirty: (d: boolean) => void
  onSaved: (name: string) => void
  onRemoved?: () => void
  onCancel?: () => void
}): JSX.Element {
  const notify = useNotify()
  const original = useMemo(() => initial(server), [server])
  const [f, setF] = useState<FormState>(original)
  const [reveal, setReveal] = useState(false)
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const patch = (p: Partial<FormState>): void => {
    setTouched(true)
    setF((s) => ({ ...s, ...p }))
  }

  useEffect(() => setF(original), [original])

  const config = useMemo(() => buildConfig(f, server), [f, server])
  const base = useMemo(() => buildConfig(original, server), [original, server])
  const dirty = server === null ? touched : f.name.trim() !== original.name || JSON.stringify(config) !== JSON.stringify(base)
  useNavGuard(dirty)
  useEffect(() => {
    setDirty(dirty)
    return () => setDirty(false)
  }, [dirty, setDirty])

  const problems = validateMcp(f.name.trim(), config, names, server?.name)
  const envDup = dupKeys(f.env) ? 'Two variables have the same name.' : undefined
  const headerDup = dupKeys(f.headers) ? 'Two headers have the same name.' : undefined
  const blocked = hasProblems(problems) || !!envDup || !!headerDup
  const show = touched || server !== null

  async function save(): Promise<void> {
    setTouched(true)
    if (blocked || saving) return
    setSaving(true)
    try {
      const r = await api.mcp.save({ originalName: server?.name, name: f.name.trim(), config })
      notify.saved(r.snapshotId, `Added ${f.name.trim()}.`)
      setDirty(false)
      onSaved(f.name.trim())
    } catch (e) {
      notify.failed(e)
    } finally {
      setSaving(false)
    }
  }

  async function remove(): Promise<void> {
    if (!server) return
    setSaving(true)
    try {
      const r = await api.mcp.remove(server.name)
      notify.saved(r.snapshotId, `Removed ${server.name}.`)
      setConfirmRemove(false)
      onRemoved?.()
    } catch (e) {
      notify.failed(e)
    } finally {
      setSaving(false)
    }
  }

  const secrets = f.env.length + f.headers.length > 0

  return (
    <DetailPane
      title={server ? server.name : 'New server'}
      path={stateFile}
      reveal=".claude.json"
      badges={server ? <Badge>{server.transport}</Badge> : undefined}
      actions={
        <>
          <Button variant="secondary" onClick={() => void api.system.reveal('.claude.json').catch(notify.failed)}>
            Reveal
          </Button>
          <Spacer />
          {server ? (
            <Button variant="danger" disabled={saving} onClick={() => setConfirmRemove(true)}>
              Remove server
            </Button>
          ) : null}
        </>
      }
    >
      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__content ext-form">
            <TextField label="Name" mono value={f.name} disabled={saving} spellCheck={false} placeholder="my-server" error={show ? problems.name : undefined} hint="Letters, numbers, hyphens and underscores." onChange={(e) => patch({ name: e.target.value })} />
            <div className="ext-field">
              <span className="ext-label">Type</span>
              <div>
                <Segmented
                  aria-label="Server type"
                  value={f.transport}
                  onChange={(t) => patch({ transport: t })}
                  options={[
                    { value: 'stdio', label: 'stdio (runs a command)' },
                    { value: 'http', label: 'http' },
                    { value: 'sse', label: 'sse' }
                  ]}
                />
              </div>
            </div>

            {f.transport === 'stdio' ? (
              <>
                <TextField label="Command" mono value={f.command} disabled={saving} spellCheck={false} placeholder="npx" error={show ? problems.command : undefined} onChange={(e) => patch({ command: e.target.value })} />
                <div className="ext-field">
                  <span className="ext-label">Arguments</span>
                  <ListEditor aria-label="Argument" items={f.args} onChange={(args) => patch({ args })} placeholder="-y" addLabel="Add argument" emptyText="No arguments." disabled={saving} />
                  {show && problems.args ? <span className="ext-error">{problems.args}</span> : null}
                </div>
              </>
            ) : (
              <TextField label="URL" mono value={f.url} disabled={saving} spellCheck={false} placeholder="https://example.com/mcp" error={show ? problems.url : undefined} onChange={(e) => patch({ url: e.target.value })} />
            )}

            <div className="ext-field">
              <div className="ext-kv__head">
                <span className="ext-label">{f.transport === 'stdio' ? 'Environment variables' : 'Headers'}</span>
                <Spacer />
                {secrets ? (
                  <Button variant="ghost" icon={reveal ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setReveal((r) => !r)} aria-pressed={reveal}>
                    {reveal ? 'Hide values' : 'Show values'}
                  </Button>
                ) : null}
              </div>
              {f.transport === 'stdio' ? (
                <KeyValueEditor aria-label="Environment variable" rows={f.env} onChange={(env) => patch({ env })} reveal={reveal} addLabel="Add variable" emptyText="No environment variables." disabled={saving} />
              ) : (
                <KeyValueEditor aria-label="Header" rows={f.headers} onChange={(headers) => patch({ headers })} reveal={reveal} keyPlaceholder="Authorization" addLabel="Add header" emptyText="No headers." disabled={saving} />
              )}
              {show && (problems.env || problems.headers || envDup || headerDup) ? <span className="ext-error">{problems.env ?? problems.headers ?? envDup ?? headerDup}</span> : null}
            </div>
            {server && Object.keys(server.config).some((k) => !KNOWN.includes(k)) ? (
              <p className="ext-hint">
                Also set on this server and kept as it is: <span className="ext-mono">{Object.keys(server.config).filter((k) => !KNOWN.includes(k)).join(', ')}</span>.
              </p>
            ) : null}
          </div>
          <div className="ext-savebar">
            <Button variant="primary" loading={saving} disabled={!dirty || (show && blocked)} onClick={() => void save()}>
              {server ? 'Save' : 'Add server'}
            </Button>
            <Button variant="secondary" disabled={saving || (!dirty && !!server)} onClick={() => (server ? setF(original) : onCancel?.())}>
              {server ? 'Revert' : 'Cancel'}
            </Button>
            <span className="ext-savebar__status">{dirty ? 'Unsaved changes' : 'No changes'}</span>
          </div>
        </div>
        <p className="ext-foot">Saving changes only mcpServers in .claude.json. Claude Code keeps writing that file, so Claudock reads it again right before it writes. A snapshot is kept in Backups.</p>
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${server?.name ?? 'this server'}?`}
        description="This takes the server out of mcpServers in .claude.json. A snapshot of the file is kept in Backups, so you can bring it back."
        confirmLabel="Remove server"
        tone="danger"
        busy={saving}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      />
    </DetailPane>
  )
}

/* ------------------------------------------------------------------ project servers (read-only) */

function ProjectServer({ server, home }: { server: McpServer; home: string }): JSX.Element {
  const [reveal, setReveal] = useState(false)
  const c = server.config
  const mask = (v: string): string => (reveal ? v : '•'.repeat(Math.min(Math.max(v.length, 6), 14)))
  const pairs = (o: unknown): Array<[string, string]> => (typeof o === 'object' && o !== null ? Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, String(v)] as [string, string]) : [])
  const env = pairs(c.env)
  const headers = pairs(c.headers)
  return (
    <DetailPane title={server.name} badges={<><Badge>{server.transport}</Badge><Badge tone="oat">project</Badge></>}>
      <div className="ext-body">
        <dl className="ext-deflist">
          <dt>Project</dt>
          <dd className="mono">{tildify(server.projectPath ?? '', home)}</dd>
          {server.transport === 'stdio' || server.transport === 'unknown' ? (
            <>
              <dt>Command</dt>
              <dd className="mono">{typeof c.command === 'string' ? c.command : '—'}</dd>
              <dt>Arguments</dt>
              <dd className="mono">{Array.isArray(c.args) && c.args.length ? c.args.join(' ') : '—'}</dd>
            </>
          ) : (
            <>
              <dt>URL</dt>
              <dd className="mono">{typeof c.url === 'string' ? c.url : '—'}</dd>
            </>
          )}
          {env.length > 0 ? (
            <>
              <dt>Environment</dt>
              <dd className="mono">
                {env.map(([k, v]) => (
                  <div key={k}>
                    {k}={mask(v)}
                  </div>
                ))}
              </dd>
            </>
          ) : null}
          {headers.length > 0 ? (
            <>
              <dt>Headers</dt>
              <dd className="mono">
                {headers.map(([k, v]) => (
                  <div key={k}>
                    {k}: {mask(v)}
                  </div>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
        {env.length + headers.length > 0 ? (
          <div>
            <Button variant="ghost" icon={reveal ? <EyeOff size={14} /> : <Eye size={14} />} onClick={() => setReveal((r) => !r)} aria-pressed={reveal}>
              {reveal ? 'Hide values' : 'Show values'}
            </Button>
          </div>
        ) : null}
        <div className="ext-note">
          <Info size={16} strokeWidth={1.8} aria-hidden />
          <span>This server belongs to one project, so it is shown here but not editable. Manage it with claude mcp inside that project.</span>
        </div>
      </div>
    </DetailPane>
  )
}
