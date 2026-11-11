import { useMemo, useState } from 'react'
import type { TeamItem, TeamKind, TeamState } from '@shared/api/team'
import { Button, Card, Chip, EmptyState, PageLayout } from '@/components'
import { api } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useNotify } from '../_ext/ui'
import { Total, kindLine, tokensText, usedText } from './parts'

type Filter = 'all' | TeamKind | 'fix' | 'stays'

const KINDS: { id: TeamKind; label: string }[] = [
  { id: 'skill', label: 'Skills' },
  { id: 'agent', label: 'Agents' },
  { id: 'command', label: 'Commands' },
  { id: 'hook', label: 'Hooks' },
  { id: 'mcp', label: 'MCP' }
]

/**
 * Choose (decision 2 A): everything of the profile's own that can travel, biggest first, with a tick, what it was
 * used, what it costs and the problem it has; "Stays yours" lists what a plugin cannot carry (decision 7 A).
 */
export function ChooseView({ state, onChange, onDone }: { state: TeamState; onChange: (s: TeamState) => void; onDone: () => void }): JSX.Element {
  const notify = useNotify()
  const [filter, setFilter] = useState<Filter>('all')
  const [busy, setBusy] = useState(false)
  // only what the user has: items that are only in the repo are shown on Team
  const items = useMemo(() => state.items.filter((i) => i.state !== 'removed' && i.state !== 'repo-only'), [state.items])
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: items.length, fix: items.filter((i) => i.problem).length, stays: state.stays.length }
    for (const k of KINDS) c[k.id] = items.filter((i) => i.kind === k.id).length
    return c
  }, [items, state.stays])
  const view = items.filter((i) => (filter === 'all' ? true : filter === 'fix' ? !!i.problem : i.kind === filter))

  async function tick(ids: string[], on: boolean): Promise<void> {
    setBusy(true)
    try {
      onChange(await api.team.setTicked(ids, on))
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusy(false)
    }
  }

  const row = (i: TeamItem): JSX.Element => {
    const k = kindLine(i)
    const id = `tick-${i.id}`
    return (
      <tr key={i.id} className={cx('ctx__row', !i.ticked && 'ctx__row--off')}>
        <td className="ctx__switch">
          <input id={id} type="checkbox" className="tm__tick" checked={i.ticked} disabled={busy} onChange={(e) => void tick([i.id], e.target.checked)} />
        </td>
        <td>
          <label htmlFor={id} className="ctx__name">
            <span className="ctx__label">{i.name}</span>
            <span className={cx('ctx__kind', k.tone && `tm__kind--${k.tone}`)}>{k.text}</span>
          </label>
        </td>
        <td className="ctx__used">{usedText(i)}</td>
        <td className="ctx__tokens ctx__num">{tokensText(i.tokens)}</td>
      </tr>
    )
  }

  return (
    <PageLayout
      title="Choose"
      actions={<Total tokens={state.tokens} />}
      toolbar={
        <div className="tm__bar">
          <div className="ctx__filters">
            <Chip selected={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
              All
            </Chip>
            {KINDS.filter((k) => counts[k.id] > 0).map((k) => (
              <Chip key={k.id} selected={filter === k.id} onClick={() => setFilter(k.id)} count={counts[k.id]}>
                {k.label}
              </Chip>
            ))}
            <Chip selected={filter === 'fix'} onClick={() => setFilter('fix')} count={counts.fix}>
              To fix
            </Chip>
            <Chip selected={filter === 'stays'} onClick={() => setFilter('stays')} count={counts.stays}>
              Stays yours
            </Chip>
          </div>
          <div className="tm__buttons">
            <Button variant="primary" onClick={onDone}>
              Done
            </Button>
          </div>
        </div>
      }
    >
      {filter === 'stays' ? (
        state.stays.length === 0 ? (
          <EmptyState title="Nothing here" />
        ) : (
          <Card flush>
            <table className="ctx__table">
              <colgroup>
                <col />
                <col className="tm__c-tokens" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="ctx__tokens">
                    Tokens
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.stays.map((s) => (
                  <tr key={s.name} className="ctx__row ctx__row--off">
                    <td>
                      <span className="ctx__name">
                        <span className="ctx__label">{s.name}</span>
                        <span className="ctx__kind">{s.reason}</span>
                      </span>
                    </td>
                    <td className="ctx__tokens ctx__num">{tokensText(s.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )
      ) : view.length === 0 ? (
        <EmptyState title={filter === 'fix' ? 'Nothing to fix' : 'Nothing here'} />
      ) : (
        <Card flush>
          <table className="ctx__table">
            <colgroup>
              <col className="ctx__c-switch" />
              <col />
              <col className="ctx__c-used" />
              <col className="tm__c-tokens" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">For the team</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col">Used</th>
                <th scope="col" className="ctx__tokens">
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>{view.map(row)}</tbody>
          </table>
        </Card>
      )}
    </PageLayout>
  )
}
