import { useState } from 'react'
import { formatEstimate } from '@shared/api/context'
import { formatRelative } from '@shared/format'
import type { TeamDiff, TeamItem, TeamItemState } from '@shared/api/team'
import { Button, DiffView, Spinner } from '@/components'
import { useApi } from '@/lib/api'

export const STATE_LABEL: Record<TeamItemState, string> = {
  new: 'New',
  published: 'Published',
  'changed-here': 'Changed here',
  'changed-repo': 'Changed in the repo',
  'changed-both': 'Changed in both',
  removed: 'Removed',
  'repo-only': 'Only in the repo'
}

/** The dot's colour group. */
export const dotOf = (s: TeamItemState | null): string => (s === null ? '' : s.startsWith('changed') ? 'changed' : s)

export const tokensText = (n: number | null): string => (n === null ? '' : formatEstimate(n))

export function usedText(i: TeamItem): string {
  if (i.uses === undefined) return ''
  const when = i.lastUsedAt ? formatRelative(i.lastUsedAt) : ''
  if (i.kind === 'mcp') return i.uses ? `${i.uses} · ${when}` : '0 in 30 d'
  if (!i.uses && !when) return 'never'
  return [i.uses ? String(i.uses) : '', when].filter(Boolean).join(' · ')
}

/** A row's second line: its kind, or its kind and the problem it has. */
export function kindLine(i: TeamItem): { text: string; tone?: 'danger' | 'warning' } {
  if (!i.problem) return { text: i.detail }
  const kind = i.detail.split(' · ')[0]
  return { text: `${kind} · ${i.problem.text.charAt(0).toLowerCase()}${i.problem.text.slice(1)}`, tone: i.problem.blocks ? 'danger' : 'warning' }
}

/** A command to copy, in a mono box with its Copy button. */
export function CommandRow({ text, label = 'Copy', onCopy }: { text: string; label?: string; onCopy: () => Promise<void> }): JSX.Element {
  const [done, setDone] = useState(false)
  return (
    <div className="tm-cmd">
      <code>{text}</code>
      <Button
        onClick={() =>
          void onCopy().then(() => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          })
        }
      >
        {done ? 'Copied' : label}
      </Button>
    </div>
  )
}

/** A diff fetched on open. */
export function FetchedDiff({ load, deps, beforeLabel, afterLabel }: { load: () => Promise<TeamDiff>; deps: unknown[]; beforeLabel: string; afterLabel: string }): JSX.Element {
  const d = useApi(load, deps)
  if (d.error) return <p className="tm-sheet__muted">{d.error}</p>
  if (!d.data) return <Spinner />
  if (d.data.binary) return <p className="tm-sheet__muted">Not text, or too big to show.</p>
  if (d.data.before === d.data.after) return <p className="tm-sheet__muted">The same in both.</p>
  return <DiffView before={d.data.before} after={d.data.after} beforeLabel={beforeLabel} afterLabel={afterLabel} />
}

/** The ≈ total of tokens every session gets from the team. */
export function Total({ tokens, each = true }: { tokens: number; each?: boolean }): JSX.Element {
  return (
    <div className="ctx__total">
      <b>{tokens > 0 ? formatEstimate(tokens) : '0'}</b>
      <span>{each ? 'tokens per session, each' : 'tokens per session'}</span>
    </div>
  )
}
