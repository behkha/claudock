import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ContextItem } from '@shared/api/context'
import { formatEstimate } from '@shared/api/context'
import { formatRelative } from '@shared/format'
import { SCREEN_BY_ID } from '@shared/nav'
import { Button, Card, Chip, EmptyState, PageLayout, Spinner, Toggle } from '@/components'
import { api, useApi, useEvent } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useNav, type ScreenProps } from '@/lib/nav'
import { useNotify } from '../_ext/ui'
import './context.css'

type Filter = 'all' | 'skill' | 'mcp' | 'memory' | 'unused'

const DAY = 86_400_000

const MISSING: Record<NonNullable<ContextItem['missing']>, string> = {
  failed: 'failed',
  'needs-auth': 'needs login',
  pending: 'connecting',
  'not-seen': 'not seen'
}

/** On, and nothing in the last 30 days says it was used. */
function unused(i: ContextItem, now: number): boolean {
  if (!i.on) return false
  if (i.kind === 'skill') return !i.lastUsedAt || now - i.lastUsedAt > 30 * DAY
  return i.kind === 'mcp' && i.uses === 0
}

function kindLine(i: ContextItem): string {
  if (i.kind === 'memory') return 'CLAUDE.md & rules'
  if (i.kind === 'mcp') {
    const tools = i.tools === undefined ? '' : `${i.tools} tool${i.tools === 1 ? '' : 's'}`
    return ['MCP', i.source === 'user' ? '' : i.source, tools].filter(Boolean).join(' · ')
  }
  if (i.override === 'user-invocable-only') return `skill · /${i.id.slice('skill:'.length)}`
  return ['skill', i.source, i.override === 'name-only' ? 'name only' : ''].filter(Boolean).join(' · ')
}

function usedText(i: ContextItem): string {
  if (i.kind === 'memory') return ''
  const when = i.lastUsedAt ? formatRelative(i.lastUsedAt) : ''
  if (i.kind === 'mcp') return i.uses === undefined ? '…' : i.uses ? `${i.uses} · ${when}` : '0 in 30 d'
  if (!i.uses && !when) return 'never'
  return [i.uses ? String(i.uses) : '', when].filter(Boolean).join(' · ')
}

export default function ContextScreen({ selectId }: ScreenProps): JSX.Element {
  const { data, error, loading, reload } = useApi(() => api.context.list(), [])
  // the MCP tool calls are counted in the background: the list comes back once they are
  useEvent('context:usage', reload)
  const { navigate } = useNav()
  const notify = useNotify()
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(selectId ?? null)
  const [busy, setBusy] = useState<string | null>(null)
  // a switch keeps the position it was flipped to until the list it changed comes back
  const [flipped, setFlipped] = useState<{ id: string; on: boolean } | null>(null)
  useEffect(() => setFlipped(null), [data])
  // "unused" is judged at the time of the list, so it doesn't change under the reader
  const now = useMemo(() => (data ? Date.now() : 0), [data])

  const items = useMemo(() => data?.items ?? [], [data])
  const counts = useMemo(
    () => ({
      all: items.length,
      skill: items.filter((i) => i.kind === 'skill').length,
      mcp: items.filter((i) => i.kind === 'mcp').length,
      memory: items.filter((i) => i.kind === 'memory').length,
      unused: items.filter((i) => unused(i, now)).length
    }),
    [items, now]
  )
  const view = items.filter((i) => (filter === 'all' ? true : filter === 'unused' ? unused(i, now) : i.kind === filter))
  const onRows = view.filter((i) => i.on)
  const offRows = view.filter((i) => !i.on)
  const max = Math.max(1, ...items.filter((i) => i.on).map((i) => i.tokens ?? 0))
  const top = items.find((i) => i.on && i.tokens !== null && i.tokens > 0)?.id
  const segments = items.filter((i) => i.on && (i.tokens ?? 0) > 0)

  async function flip(i: ContextItem, on: boolean): Promise<void> {
    setBusy(i.id)
    try {
      const r = await api.context.setOn(i.id, on)
      notify.saved(r.snapshotId, 'Saved.', { changed: r.changed, message: 'Nothing needed to change.' })
      if (r.changed) setFlipped({ id: i.id, on })
      reload()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(null)
    }
  }

  const total = data ? (
    <div className="ctx__total">
      <b>{formatEstimate(data.tokens)}</b>
      <span>tokens per session</span>
    </div>
  ) : null

  if (!data) {
    return (
      <PageLayout title="Context">
        {error ? <EmptyState title="Could not measure the context" description={error} action={<Button onClick={reload}>Try again</Button>} /> : <Spinner />}
      </PageLayout>
    )
  }

  const row = (i: ContextItem): JSX.Element[] => {
    const expanded = open === i.id
    const out = [
      <tr key={i.id} className={cx('ctx__row', !i.on && 'ctx__row--off', expanded && 'ctx__row--open')}>
        <td className="ctx__switch">
          {i.switchable ? (
            <Toggle
              checked={flipped?.id === i.id ? flipped.on : i.on}
              disabled={busy !== null || flipped !== null || !!data.settingsError}
              onChange={(v) => void flip(i, v)}
              aria-label={`${i.name} in context`}
            />
          ) : null}
        </td>
        <td>
          <button type="button" className="ctx__name" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i.id)}>
            <span className="ctx__label">{i.name}</span>
            <span className="ctx__kind">{kindLine(i)}</span>
          </button>
        </td>
        <td className="ctx__used">{usedText(i)}</td>
        <td className="ctx__tokens">
          {i.tokens === null ? (
            <span className="ctx__muted">{MISSING[i.missing ?? 'not-seen']}</span>
          ) : (
            <span className="ctx__cost">
              <span className="ctx__track" aria-hidden>
                {i.on && i.tokens > 0 ? <span className={cx('ctx__fill', i.id === top && 'ctx__fill--top')} style={{ width: `${Math.max(2, (i.tokens / max) * 100)}%` }} /> : null}
              </span>
              <span className={cx('ctx__num', !i.on && 'ctx__muted')}>{i.on ? formatEstimate(i.tokens) : '0'}</span>
            </span>
          )}
        </td>
        <td className="ctx__chev" aria-hidden>
          {expanded ? <ChevronDown size={16} strokeWidth={1.8} /> : <ChevronRight size={16} strokeWidth={1.8} />}
        </td>
      </tr>
    ]
    if (expanded) {
      out.push(
        <tr key={`${i.id}:text`} className="ctx__detail">
          <td />
          <td colSpan={4}>
            <Counted item={i} version={data} />
            {i.open ? (
              <div className="ctx__actions">
                <Button variant="secondary" onClick={() => i.open && navigate(i.open.screen, i.open.id)}>
                  Open in {SCREEN_BY_ID[i.open.screen].label}
                </Button>
              </div>
            ) : null}
          </td>
        </tr>
      )
    }
    return out
  }

  return (
    <PageLayout
      title="Context"
      actions={total}
      toolbar={
        <div className="ctx__toolbar">
          <div className="ctx__stack" role="img" aria-label={segments.map((i) => `${i.name} ${formatEstimate(i.tokens ?? 0)}`).join(', ') || 'Nothing measured'}>
            {segments.map((i) => (
              <span key={i.id} className={cx('ctx__seg', i.id === top && 'ctx__seg--top')} style={{ flexGrow: i.tokens ?? 0 }} title={`${i.name} · ${formatEstimate(i.tokens ?? 0)}`} />
            ))}
          </div>
          <div className="ctx__filters">
            <Chip selected={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
              All
            </Chip>
            <Chip selected={filter === 'skill'} onClick={() => setFilter('skill')} count={counts.skill}>
              Skills
            </Chip>
            <Chip selected={filter === 'mcp'} onClick={() => setFilter('mcp')} count={counts.mcp}>
              MCP servers
            </Chip>
            <Chip selected={filter === 'memory'} onClick={() => setFilter('memory')} count={counts.memory}>
              CLAUDE.md &amp; rules
            </Chip>
            <Chip selected={filter === 'unused'} onClick={() => setFilter('unused')} count={counts.unused}>
              Unused
            </Chip>
          </div>
        </div>
      }
    >
      {data.settingsError ? <p className="ctx__error">{data.settingsError}</p> : null}
      {view.length === 0 ? (
        <EmptyState title={filter === 'unused' ? 'Everything here was used in the last 30 days' : 'Nothing here adds to the context'} />
      ) : (
        <Card flush className={cx('ctx__card', loading && 'ctx__card--loading')}>
          <table className="ctx__table" aria-busy={data.usesPending ? true : undefined}>
            <colgroup>
              <col className="ctx__c-switch" />
              <col />
              <col className="ctx__c-used" />
              <col className="ctx__c-tokens" />
              <col className="ctx__c-chev" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">In context</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col">Used</th>
                <th scope="col" className="ctx__tokens">
                  Tokens
                </th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {onRows.flatMap(row)}
              {offRows.length ? (
                <tr className="ctx__group">
                  <td colSpan={5}>Off · {offRows.length}</td>
                </tr>
              ) : null}
              {offRows.flatMap(row)}
            </tbody>
          </table>
        </Card>
      )}
      {data.session ? (
        <p className="ctx__from">
          From {data.session.name} · {formatRelative(data.session.at)}
        </p>
      ) : null}
    </PageLayout>
  )
}

/** The text an item's number counts, as Claude Code was (or next time will be) given it. */
function Counted({ item, version }: { item: ContextItem; version: unknown }): JSX.Element {
  const t = useApi(() => api.context.text(item.id), [item.id, version])
  if (t.error) return <p className="ctx__muted">{t.error}</p>
  if (!t.data) return <Spinner />
  if (!t.data.text) return <p className="ctx__muted">Nothing recorded for it yet.</p>
  return (
    <pre className="ctx__text">
      {t.data.text}
      {t.data.truncated ? '\n…' : ''}
    </pre>
  )
}
