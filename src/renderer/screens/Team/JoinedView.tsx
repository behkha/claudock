import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { JoinedItem, TeamJoined } from '@shared/api/team'
import { formatEstimate } from '@shared/api/context'
import { formatRelative } from '@shared/format'
import { Card, PageLayout } from '@/components'
import { api } from '@/lib/api'
import { cx } from '@/lib/cx'
import { FetchedDiff, Total } from './parts'

const CHANGE: Record<JoinedItem['change'], string> = { new: 'New', changed: 'Changed', removed: 'Removed', same: '' }
const DOT: Record<JoinedItem['change'], string> = { new: 'new', changed: 'changed', removed: 'removed', same: 'published' }

const signed = (n: number | null): string => (n === null ? '' : n < 0 ? `≈ −${formatEstimate(-n).replace('≈ ', '')}` : formatEstimate(n))

/**
 * A teammate's Team (decision 6 A): the team plugin someone wrote with Claudock, installed here by Claude Code, with
 * what its last update changed. Claude Code brings each update by itself; this only shows what landed.
 */
export function JoinedView({ joined }: { joined: TeamJoined }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const changed = joined.items.filter((i) => i.change !== 'same')
  const same = joined.items.filter((i) => i.change === 'same')
  const updated = joined.updatedAt ? `updated ${formatRelative(joined.updatedAt)}` : ''

  const row = (i: JoinedItem): JSX.Element[] => {
    const expanded = open === i.id
    const out = [
      <tr key={i.id} className={cx('ctx__row', i.change === 'removed' && 'ctx__row--off', expanded && 'ctx__row--open')}>
        <td>
          <span className={cx('tm__dot', `tm__dot--${DOT[i.change]}`)} aria-hidden />
        </td>
        <td>
          <button type="button" className="ctx__name" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i.id)}>
            <span className="ctx__label">{i.name}</span>
            <span className="ctx__kind">{i.detail}</span>
          </button>
        </td>
        <td className="tm__state">{CHANGE[i.change]}</td>
        <td className="ctx__tokens ctx__num">{signed(i.tokens)}</td>
        <td className="ctx__chev" aria-hidden>
          {expanded ? <ChevronDown size={16} strokeWidth={1.8} /> : <ChevronRight size={16} strokeWidth={1.8} />}
        </td>
      </tr>
    ]
    if (expanded) {
      out.push(
        <tr key={`${i.id}:diff`} className="ctx__detail">
          <td />
          <td colSpan={4} className="tm__diff">
            <FetchedDiff load={() => api.team.itemDiff(i.id)} deps={[i.id, joined.updatedAt]} beforeLabel="Before" afterLabel="Now" />
          </td>
        </tr>
      )
    }
    return out
  }

  const table = (rows: JoinedItem[]): JSX.Element => (
    <Card flush>
      <table className="ctx__table">
        <colgroup>
          <col className="tm__c-dot" />
          <col />
          <col className="tm__c-state" />
          <col className="tm__c-tokens" />
          <col className="ctx__c-chev" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Change</span>
            </th>
            <th scope="col">Name</th>
            <th scope="col">Change</th>
            <th scope="col" className="ctx__tokens">
              Tokens
            </th>
            <th scope="col">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>{rows.flatMap(row)}</tbody>
      </table>
    </Card>
  )

  return (
    <PageLayout
      title="Team"
      actions={<Total tokens={joined.tokens} each={false} />}
      toolbar={
        <div className="tm__bar">
          <span className="tm__repo">{[joined.source, updated, joined.enabled ? '' : 'turned off'].filter(Boolean).join(' · ')}</span>
        </div>
      }
    >
      {changed.length ? (
        <>
          <h2 className="tm__sub">What changed</h2>
          {table(changed)}
        </>
      ) : null}
      {same.length ? (
        <>
          <h2 className="tm__sub">{changed.length ? 'The rest' : 'In the team'}</h2>
          {table(same)}
        </>
      ) : null}
    </PageLayout>
  )
}
