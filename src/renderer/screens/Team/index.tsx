import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { TeamItem, TeamState, Written } from '@shared/api/team'
import { Button, Card, EmptyState, PageLayout, Spinner } from '@/components'
import { api } from '@/lib/api'
import { refreshCounts } from '@/lib/counts'
import { cx } from '@/lib/cx'
import { useNav, type ScreenProps } from '@/lib/nav'
import { ChooseView } from './ChooseView'
import { NewTeamSheet } from './NewTeamSheet'
import { ReviewSheet } from './ReviewSheet'
import { WrittenSheet } from './WrittenSheet'
import { FetchedDiff, STATE_LABEL, Total, dotOf, kindLine, tokensText } from './parts'
import '../Context/context.css'
import './team.css'

/**
 * Team (Team mode, decision 1 A): what the team gets from this profile, each item's state against the repo and what it
 * adds to every teammate's sessions. Choose ticks items, Review checks and writes them into the team folder.
 */
export default function TeamScreen(_props: ScreenProps): JSX.Element {
  const [data, setData] = useState<TeamState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(() => {
    api.team.get().then(
      (s) => {
        setData(s)
        setError(null)
        refreshCounts()
      },
      (e: Error) => setError(e.message)
    )
  }, [])
  useEffect(reload, [reload])
  const [view, setView] = useState<'team' | 'choose'>('team')
  const [sheet, setSheet] = useState<'new' | 'review' | null>(null)
  const [written, setWritten] = useState<Written | null>(null)

  const update = (s: TeamState): void => {
    setData(s)
    refreshCounts()
  }

  if (!data) {
    return (
      <PageLayout title="Team">
        {error ? <EmptyState title="Could not read the team setup" description={error} action={<Button onClick={reload}>Try again</Button>} /> : <Spinner />}
      </PageLayout>
    )
  }

  const sheets = (
    <>
      <NewTeamSheet
        open={sheet === 'new'}
        onClose={() => setSheet(null)}
        onCreated={(s) => {
          setSheet(null)
          update(s)
        }}
      />
      <ReviewSheet
        open={sheet === 'review'}
        onClose={() => {
          setSheet(null)
          reload()
        }}
        onTicked={update}
        onWritten={(w) => {
          setSheet(null)
          setWritten(w)
          reload()
          refreshCounts()
        }}
      />
      <WrittenSheet written={written} onClose={() => setWritten(null)} />
    </>
  )

  if (!data.setup) {
    return (
      <PageLayout title="Team">
        <EmptyState
          title="No team setup"
          action={
            <Button variant="primary" onClick={() => setSheet('new')}>
              New team setup
            </Button>
          }
        />
        {sheets}
      </PageLayout>
    )
  }

  if (view === 'choose') {
    return (
      <>
        <ChooseView state={data} onChange={update} onDone={() => setView('team')} />
        {sheets}
      </>
    )
  }

  return (
    <>
      <TeamView state={data} onChoose={() => setView('choose')} onReview={() => setSheet('review')} onForget={() => api.team.forget().then(reload)} />
      {sheets}
    </>
  )
}

function repoLine(s: TeamState): string {
  const setup = s.setup
  if (!setup) return ''
  const where = setup.remote ? setup.remote.text : setup.dir
  const sent = setup.sentAt ? `sent ${new Date(setup.sentAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : 'not sent yet'
  return setup.remote ? `${where} · ${sent}` : `${where} · No remote yet · ${sent}`
}

function TeamView({ state, onChoose, onReview, onForget }: { state: TeamState; onChoose: () => void; onReview: () => void; onForget: () => void }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const { navigate } = useNav()
  const rows = state.items.filter((i) => i.ticked || i.state === 'removed' || i.state === 'repo-only')
  const setup = state.setup
  if (!setup) return <></>

  const row = (i: TeamItem): JSX.Element[] => {
    const expanded = open === i.id
    const k = kindLine(i)
    const out = [
      <tr key={i.id} className={cx('ctx__row', i.state === 'removed' && 'ctx__row--off', expanded && 'ctx__row--open')}>
        <td>
          <span className={cx('tm__dot', `tm__dot--${dotOf(i.state)}`)} aria-hidden />
        </td>
        <td>
          <button type="button" className="ctx__name" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : i.id)}>
            <span className="ctx__label">{i.name}</span>
            <span className={cx('ctx__kind', k.tone && `tm__kind--${k.tone}`)}>{k.text}</span>
          </button>
        </td>
        <td className="tm__state">{i.state ? STATE_LABEL[i.state] : ''}</td>
        <td className="ctx__tokens ctx__num">{tokensText(i.tokens)}</td>
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
            <FetchedDiff load={() => api.team.itemDiff(i.id)} deps={[i.id, state]} beforeLabel="In the repo" afterLabel="Yours" />
            {i.open ? (
              <div className="ctx__actions">
                <Button onClick={() => i.open && navigate(i.open.screen, i.open.id)}>Open</Button>
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
      title="Team"
      actions={<Total tokens={state.tokens} />}
      toolbar={
        <div className="tm__bar">
          <span className="tm__repo" title={setup.dir}>
            {repoLine(state)}
          </span>
          <div className="tm__buttons">
            <Button onClick={onChoose}>Choose</Button>
            <Button variant="primary" disabled={state.changes === 0 || setup.missing} onClick={onReview}>
              {state.changes === 1 ? 'Review 1 change' : `Review ${state.changes} changes`}
            </Button>
          </div>
        </div>
      }
    >
      {setup.missing ? (
        <p className="tm__error">
          The team folder is gone or is no longer a git repo. <Button onClick={onForget}>Forget it</Button>
        </p>
      ) : null}
      {!state.writable ? <p className="tm__error">This development build may not write to that folder.</p> : null}
      {rows.length === 0 ? (
        <EmptyState title="Nothing chosen yet" action={<Button onClick={onChoose}>Choose</Button>} />
      ) : (
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
                  <span className="sr-only">State</span>
                </th>
                <th scope="col">Name</th>
                <th scope="col">State</th>
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
      )}
    </PageLayout>
  )
}
