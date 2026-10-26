import { useMemo, useState } from 'react'
import { Blocks, Info } from 'lucide-react'
import type { ModInfo } from '@shared/api/mods'
import { formatBytes, formatDate, tildify } from '@shared/format'
import { Badge, Button, Chip, ConfirmDialog, DetailPane, EmptyState, ListDetailLayout, ListGroup, ListPane, ListRow, MarkdownView, Spinner, Toggle } from '@/components'
import { api, useApi } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useHome, useSelectId } from '@/lib/hooks'
import { useNav, type ScreenProps } from '@/lib/nav'
import { ChipList, Dot, Spacer, useNotify } from '../_ext/ui'
import './mods.css'

type Filter = 'all' | 'on' | 'off' | 'draft'

const GROUPS: Array<{ source: ModInfo['source']; label: string }> = [
  { source: 'installed', label: 'Installed' },
  { source: 'folder', label: 'From folders' },
  { source: 'draft', label: 'Drafts' }
]

/** `AbovePrompt` -> `Above prompt`. */
function siteLabel(s: string): string {
  const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')
  return [words[0], ...words.slice(1).map((w) => (/^[A-Z]{2,}/.test(w) ? w : w.toLowerCase()))].join(' ')
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** Folder mods outside the config dir are only known through CLAUDE_CODE_PLUGIN_DIRS, so turning one off would drop it from the list. */
const canToggle = (m: ModInfo): boolean => m.source === 'installed' || (m.source === 'folder' && m.rel !== null)

type Pending = { kind: 'trash' | 'store' | 'unload'; mod: ModInfo } | null

export default function ModsScreen({ selectId }: ScreenProps): JSX.Element {
  const { data, error, loading, reload } = useApi(() => api.mods.list(), [])
  const [selected, setSelected] = useSelectId(selectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const notify = useNotify()
  const home = useHome()

  const mods = useMemo(() => data?.mods ?? [], [data])
  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      mods.filter((m) => {
        if (filter === 'draft' && m.source !== 'draft') return false
        if (filter === 'on' && (m.source === 'draft' || !m.enabled)) return false
        if (filter === 'off' && (m.source === 'draft' || m.enabled)) return false
        return !q || `${m.name} ${m.marketplace} ${m.description}`.toLowerCase().includes(q)
      }),
    [mods, filter, q]
  )
  const mod = (selected ? mods.find((m) => m.id === selected) : undefined) ?? (selected === undefined ? visible[0] : undefined)

  async function run(id: string, fn: () => Promise<void>): Promise<void> {
    setBusy(id)
    try {
      await fn()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(null)
    }
  }

  const setEnabled = (m: ModInfo, next: boolean): Promise<void> =>
    run(m.id, async () => {
      const r = await api.mods.setEnabled(m.id, next)
      notify.saved(r.snapshotId, 'Saved.', { changed: m.enabled !== next, message: 'Nothing needed to change.' })
      reload()
    })

  const keep = (m: ModInfo): Promise<void> =>
    run(m.id, async () => {
      const r = await api.mods.keepDraft(m.id)
      notify.saved(r.snapshotId, `Kept in mods/${baseName(r.id)}.`)
      setSelected(r.id)
      reload()
    })

  async function confirm(): Promise<void> {
    if (!pending) return
    const { kind, mod: m } = pending
    await run(m.id, async () => {
      if (kind === 'store') {
        await api.mods.clearStore(m.id)
        notify.info('Saved data moved to the Trash.')
      } else {
        const r = await api.mods.trash(m.id)
        notify.saved(r.snapshotId, kind === 'unload' ? 'Saved.' : 'Moved to the Trash.')
        setSelected(undefined)
      }
      reload()
    })
    setPending(null)
  }

  const count = (f: Filter): number =>
    mods.filter((m) => (f === 'all' ? true : f === 'draft' ? m.source === 'draft' : m.source !== 'draft' && m.enabled === (f === 'on'))).length

  const subtitle = (m: ModInfo): string => {
    if (m.source === 'installed') return `${m.marketplace}${m.version ? ` · v${m.version}` : ''}`
    if (m.source === 'folder') return tildify(m.dir, home)
    const d = m.draft
    return `${d?.project ? baseName(d.project) : 'unknown project'} · until ${d ? formatDate(d.expiresMs) : '—'}`
  }

  const list = (
    <ListPane
      title="Mods"
      count={data ? mods.length : undefined}
      search={{ value: query, onChange: setQuery, placeholder: 'Filter mods' }}
      filters={
        <>
          {(['all', 'on', 'off', 'draft'] as const).map((f) => (
            <Chip key={f} selected={filter === f} onClick={() => setFilter(f)} count={count(f)}>
              {f === 'all' ? 'All' : f === 'on' ? 'On' : f === 'off' ? 'Off' : 'Drafts'}
            </Chip>
          ))}
        </>
      }
      loading={loading}
      error={data?.settingsError ?? (data ? error : null)}
      isEmpty={!!data && visible.length === 0}
      empty={
        mods.length === 0 ? (
          <EmptyState icon={<Blocks />} title="No mods yet" description="Install one with /plugin in Claude Code, or ask Claude to make one." />
        ) : (
          <EmptyState title="Nothing matches" description="Try another filter or clear the search." />
        )
      }
    >
      {data
        ? GROUPS.flatMap(({ source, label }) => {
            const rows = visible.filter((m) => m.source === source)
            if (rows.length === 0) return []
            return [
              <ListGroup key={`g:${source}`}>
                {label} · {rows.length}
              </ListGroup>,
              ...rows.map((m) => (
                <ListRow
                  key={m.id}
                  leading={<Dot on={m.enabled} />}
                  title={m.name}
                  subtitle={subtitle(m)}
                  dimmed={m.source !== 'draft' && !m.enabled}
                  selected={mod?.id === m.id}
                  onSelect={() => setSelected(m.id)}
                  trailing={
                    canToggle(m) ? <Toggle aria-label={`Enable ${m.name}`} checked={m.enabled} disabled={busy === m.id} onChange={(v) => void setEnabled(m, v)} /> : undefined
                  }
                />
              ))
            ]
          })
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
        title="Could not load mods"
        description={error ?? 'Something went wrong.'}
        action={
          <Button variant="primary" onClick={reload}>
            Try again
          </Button>
        }
      />
    )
  } else if (mod) {
    detail = (
      <ModDetail
        key={mod.id}
        mod={mod}
        busy={busy === mod.id}
        hooksDisabled={data.hooksDisabled}
        onToggle={(v) => void setEnabled(mod, v)}
        onKeep={() => void keep(mod)}
        onAsk={(kind) => setPending({ kind, mod })}
      />
    )
  } else {
    detail = <EmptyState icon={<Blocks />} title="Select a mod" description="Pick a mod on the left to see what it does." />
  }

  const p = pending
  return (
    <>
      <ListDetailLayout list={list} detail={detail} />
      <ConfirmDialog
        open={!!p}
        title={
          !p ? '' : p.kind === 'store' ? `Clear the saved data of ${p.mod.name}?` : p.kind === 'unload' ? `Stop loading ${p.mod.name}?` : `Move ${p.mod.name} to the Trash?`
        }
        description={
          !p
            ? undefined
            : p.kind === 'store'
              ? 'Its $.store file goes to the Trash. The mod starts from its defaults next session.'
              : p.kind === 'unload'
                ? `Removes ${tildify(p.mod.dir, home)} from CLAUDE_CODE_PLUGIN_DIRS. The folder stays where it is.`
                : 'You can put it back from the Trash.'
        }
        confirmLabel={!p ? 'OK' : p.kind === 'store' ? 'Clear' : p.kind === 'unload' ? 'Stop loading' : 'Move to Trash'}
        tone="danger"
        busy={!!p && busy === p.mod.id}
        onConfirm={() => void confirm()}
        onCancel={() => setPending(null)}
      />
    </>
  )
}

/* ------------------------------------------------------------------ detail */

function ModDetail({
  mod,
  busy,
  hooksDisabled,
  onToggle,
  onKeep,
  onAsk
}: {
  mod: ModInfo
  busy: boolean
  hooksDisabled: boolean
  onToggle: (v: boolean) => void
  onKeep: () => void
  onAsk: (kind: 'trash' | 'store' | 'unload') => void
}): JSX.Element {
  const { navigate } = useNav()
  const notify = useNotify()
  const home = useHome()
  const u = mod.uses
  const d = mod.draft
  const reveal = mod.rel ? (
    <Button variant="secondary" onClick={() => void api.system.reveal(mod.rel as string).catch(notify.failed)}>
      Reveal
    </Button>
  ) : null

  let actions: JSX.Element | null = reveal
  if (mod.source === 'draft') {
    actions = (
      <>
        <Button variant="primary" loading={busy} onClick={onKeep}>
          Keep
        </Button>
        {reveal}
        <Spacer />
        <Button variant="danger" disabled={busy} onClick={() => onAsk('trash')}>
          Move to Trash
        </Button>
      </>
    )
  } else if (mod.source === 'folder') {
    actions = (
      <>
        {reveal}
        <Spacer />
        {mod.rel ? (
          <Button variant="danger" disabled={busy} onClick={() => onAsk('trash')}>
            Move to Trash
          </Button>
        ) : (
          <Button variant="danger" disabled={busy || !mod.enabled} onClick={() => onAsk('unload')}>
            Stop loading
          </Button>
        )}
      </>
    )
  }

  return (
    <DetailPane
      title={mod.name}
      path={tildify(mod.dir, home)}
      reveal={mod.rel ?? false}
      badges={
        <>
          {mod.version ? <Badge>v{mod.version}</Badge> : null}
          {mod.source === 'draft' ? <Badge tone="oat">draft</Badge> : null}
        </>
      }
      actions={actions ?? undefined}
    >
      <div className="ext-body">
        {hooksDisabled && mod.source !== 'draft' ? (
          <div className="ext-note">
            <Info size={16} strokeWidth={1.8} aria-hidden />
            <span>
              disableAllHooks is on in settings.json, so no mod runs.{' '}
              <button type="button" className="ext-link" onClick={() => navigate('settings')}>
                Open Settings
              </button>
            </span>
          </div>
        ) : null}

        {canToggle(mod) ? (
          <div className="ext-toggle-row">
            <Toggle checked={mod.enabled} disabled={busy} onChange={onToggle} label="Enabled" />
          </div>
        ) : null}

        <p className={mod.description ? 'ext-desc' : 'ext-desc ext-desc--muted'}>{mod.description || 'This mod has no description.'}</p>

        <section aria-label="What it does" className="ext-form">
          <h2 className="ext-section-title">What it does</h2>
          <dl className="ext-deflist mods-uses">
            {u.draws.length > 0 ? (
              <>
                <dt>Draws</dt>
                <dd>
                  <ChipList items={u.draws.map(siteLabel)} />
                </dd>
              </>
            ) : null}
            {u.commands.length > 0 ? (
              <>
                <dt>Commands</dt>
                <dd>
                  <ChipList items={u.commands.map((c) => `/${c}`)} />
                </dd>
              </>
            ) : null}
            <dt>Hooks</dt>
            <dd>
              <ChipList items={u.hooks} />
            </dd>
            <dt>Reaches</dt>
            <dd>
              {u.calls.length === 0 ? (
                <span className="ext-hint">None</span>
              ) : (
                <div className="ext-chiplist">
                  {u.calls.map((c) => (
                    <span key={c} className={cx('ext-chip ext-chip--static', u.risky.includes(c) && 'mods-chip--risky')}>
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </dd>
            {mod.storeRel ? (
              <>
                <dt>Saved data</dt>
                <dd className="mods-store">
                  <span>{formatBytes(mod.storeBytes)}</span>
                  <button type="button" className="ext-link" disabled={busy} onClick={() => onAsk('store')}>
                    Clear
                  </button>
                </dd>
              </>
            ) : null}
          </dl>
        </section>

        <section aria-label="Details" className="ext-form">
          <h2 className="ext-section-title">Details</h2>
          <dl className="ext-deflist">
            {d ? (
              <>
                <dt>Session</dt>
                <dd>
                  {d.projectId ? (
                    <button type="button" className="ext-link" onClick={() => navigate('projects', `${d.projectId}/${d.sessionId}`)}>
                      {d.sessionTitle || d.sessionId}
                    </button>
                  ) : (
                    <span className="mono">{d.sessionId}</span>
                  )}
                </dd>
                <dt>Project</dt>
                <dd className="mono">{d.project ? tildify(d.project, home) : '—'}</dd>
                <dt>Changed</dt>
                <dd>{formatDate(d.modifiedMs)}</dd>
                <dt>Cleanup</dt>
                <dd>{formatDate(d.expiresMs)}</dd>
              </>
            ) : null}
            {mod.key ? (
              <>
                <dt>Key</dt>
                <dd className="mono">{mod.key}</dd>
              </>
            ) : null}
            {mod.marketplace ? (
              <>
                <dt>Marketplace</dt>
                <dd>
                  <button type="button" className="ext-link" onClick={() => navigate('plugins', mod.key)}>
                    {mod.marketplace}
                  </button>
                </dd>
              </>
            ) : null}
            {mod.author ? (
              <>
                <dt>Author</dt>
                <dd>{mod.author}</dd>
              </>
            ) : null}
            <dt>Module</dt>
            <dd className="mono">{mod.module || '—'}</dd>
          </dl>
        </section>

        {mod.readme ? (
          <section aria-label="README" className="ext-form">
            <h2 className="ext-section-title">README</h2>
            <div className="mods-readme">
              <MarkdownView source={mod.readme} />
            </div>
          </section>
        ) : null}
      </div>
    </DetailPane>
  )
}
