import { useEffect, useMemo, useState } from 'react'
import { FileText, Plus } from 'lucide-react'
import { formatBytes } from '@shared/format'
import { Badge, EmptyState, IconButton, ListDetailLayout, ListGroup, ListPane, ListRow, useToast } from '@/components'
import { api, useApi } from '@/lib/api'
import { useSelectId } from '@/lib/hooks'
import type { ScreenProps } from '@/lib/nav'
import { PromptDialog } from './PromptDialog'
import { RuleDetail } from './RuleDetail'
import { hasDraft } from './store'
import './rules.css'

export default function RulesScreen({ selectId }: ScreenProps): JSX.Element {
  const toast = useToast()
  const [sel, setSel] = useSelectId(selectId?.replace(/\\/g, '/'))
  const { data, error, loading, reload } = useApi(() => api.rules.list(), [])
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [focusTick, setFocusTick] = useState(0)
  const [, setDraftTick] = useState(0)

  useEffect(() => {
    const onFocus = (): void => {
      reload()
      setFocusTick((t) => t + 1)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  const items = useMemo(() => data ?? [], [data])
  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () => (q ? items.filter((i) => i.name.toLowerCase().includes(q) || (i.title ?? '').toLowerCase().includes(q)) : items),
    [items, q]
  )
  const claude = visible.find((i) => i.kind === 'claude')
  const rules = visible.filter((i) => i.kind === 'rule')
  const selected = items.find((i) => i.id === sel) ?? items[0]
  const ruleCount = items.filter((i) => i.kind === 'rule').length

  function changed(next?: string): void {
    reload()
    if (next) setSel(next)
  }

  const row = (i: (typeof items)[number]): JSX.Element => (
    <ListRow
      key={i.id}
      selected={selected?.id === i.id}
      leading={i.kind === 'claude' ? <FileText size={16} strokeWidth={1.8} aria-hidden /> : undefined}
      title={
        <>
          {i.name}
          {hasDraft(i.id) ? <span className="rl-dot" role="img" aria-label="unsaved changes" /> : null}
        </>
      }
      subtitle={i.missing ? 'Not created yet' : (i.title ?? undefined)}
      meta={
        i.kind === 'claude' && (i.missing || i.size === 0) ? (
          <Badge tone="oat">{i.missing ? 'not created' : 'empty'}</Badge>
        ) : i.missing ? undefined : (
          formatBytes(i.size)
        )
      }
      onSelect={() => setSel(i.id)}
    />
  )

  return (
    <>
      <ListDetailLayout
        list={
          <ListPane
            title="CLAUDE.md & rules"
            count={items.length ? ruleCount + (claude ? 1 : 0) : undefined}
            actions={<IconButton variant="secondary" aria-label="New rule" icon={<Plus />} onClick={() => setCreating(true)} />}
            search={{ value: query, onChange: setQuery, placeholder: 'Filter rules' }}
            loading={loading && !data}
            error={error}
            isEmpty={!!data && visible.length === 0}
            empty={<EmptyState title="Nothing matches" description="Try a different word." />}
          >
            {claude ? row(claude) : null}
            {claude || rules.length ? <ListGroup>Rules{rules.length ? ` · ${rules.length}` : ''}</ListGroup> : null}
            {rules.map(row)}
            {!q && data && rules.length === 0 ? (
              <li className="rl-none" role="presentation">
                No rules yet. A rule is a Markdown file in the rules folder that Claude Code loads in every session.
              </li>
            ) : null}
          </ListPane>
        }
        detail={
          selected ? (
            <RuleDetail key={selected.id} item={selected} onChanged={changed} focusTick={focusTick} onDraft={() => setDraftTick((t) => t + 1)} />
          ) : (
            <EmptyState icon={<FileText />} title="CLAUDE.md & rules" description={loading ? 'Loading…' : (error ?? 'Select a file to read or edit it.')} />
          )
        }
      />
      <PromptDialog
        open={creating}
        title="New rule"
        label="Name"
        hint="Letters, numbers, spaces, dots, dashes and underscores. The .md ending is added for you."
        confirmLabel="Create"
        onCancel={() => setCreating(false)}
        onSubmit={async (name) => {
          const made = await api.rules.create(name)
          setCreating(false)
          toast(`Created ${made.fileName}.`, { kind: 'success' })
          changed(made.id)
        }}
      />
    </>
  )
}
