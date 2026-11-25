import { useId, useState } from 'react'
import { AUTO_DELETE_DAYS, type AgeStep, type AutoDelete, type AutoDeleteRun } from '@shared/api/archive'
import { formatBytes, formatCount, formatDate } from '@shared/format'
import { Button, Card, ConfirmDialog, Select, Toggle, useToast } from '@/components'
import { api } from '@/lib/api'
import { useNav } from '@/lib/nav'

interface AgeCardProps {
  steps: AgeStep[]
  /** When the steps were counted: what the dialog confirms. */
  at: number
  /** Claude Code's folder plus the sessions only the archive keeps: everything the slider can move. */
  total: number
  /** A development build looking at a real folder: nothing may be moved. */
  readOnly: boolean
  auto: AutoDelete
  onTrashed: () => void
}

const plural = (n: number): string => `${formatCount(n)} ${n === 1 ? 'session' : 'sessions'}`

/** Pick an age, see what goes, move those sessions to the Trash (Claude Code's files and the archive's together). */
export function AgeCard({ steps, at: countedAt, total, readOnly, auto, onTrashed }: AgeCardProps): JSX.Element {
  const toast = useToast()
  const { navigate } = useNav()
  const rangeId = useId()
  // the age picked, kept by days: after a move to the Trash the steps change, and a step that is gone falls back to the first
  const [days, setDays] = useState(30)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const at = Math.max(0, steps.findIndex((s) => s.days === days))
  const step = steps[at] ?? { days, sessions: 0, bytes: 0 }
  const scale = Math.max(total, step.bytes, 1)
  const goes = (step.bytes / scale) * 100

  async function confirm(): Promise<void> {
    setBusy(true)
    try {
      const r = await api.archive.trashOlderThan(step.days, countedAt, step.sessions)
      toast(`Moved ${plural(r.sessions)} (${formatBytes(r.bytes)}) to Trash.`, { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      // some may have gone before a failure: count again either way
      setAsking(false)
      onTrashed()
      setBusy(false)
    }
  }

  return (
    <Card flush className="ages">
      {steps.length > 0 ? (
        <div className="ages__body">
          <p className="ages__q" aria-live="polite">
            Sessions untouched for <b>{step.days} days</b>: <b>{formatCount(step.sessions)}</b> {step.sessions === 1 ? 'session' : 'sessions'}, <b>{formatBytes(step.bytes)}</b>
          </p>
          <div className="ages__acts">
            <Button onClick={() => navigate('archive', `older:${step.days}`)}>See them</Button>
            <Button variant="danger" disabled={readOnly} onClick={() => setAsking(true)}>
              Move {formatCount(step.sessions)} to Trash
            </Button>
          </div>
          <div className="ages__gauge">
            {steps.length > 1 ? (
              <>
                <label htmlFor={rangeId} className="ages__label">
                  Older than
                </label>
                <input
                  id={rangeId}
                  type="range"
                  className="ages__range"
                  min={0}
                  max={steps.length - 1}
                  step={1}
                  value={at}
                  aria-valuetext={`${step.days} days`}
                  onChange={(e) => setDays(steps[Number(e.target.value)]?.days ?? days)}
                />
                <div className="ages__ticks" aria-hidden>
                  {steps.map((s) => (
                    <span key={s.days}>{s.days} days</span>
                  ))}
                </div>
              </>
            ) : null}
            <div className="ledger__bar ages__bar" aria-hidden>
              <span className="ledger__seg ledger__seg--cc" style={{ width: `${100 - goes}%` }} />
              <span className="ledger__seg ages__seg--goes" style={{ width: `${goes}%` }} />
            </div>
            <div className="ledger__legend">
              <span>
                <i className="ledger__sw ledger__seg--cc" />
                <span>
                  Stays: <b className="ages__num">{formatBytes(Math.max(0, total - step.bytes))}</b>
                </span>
              </span>
              <span>
                <i className="ledger__sw ages__seg--goes" />
                Goes to the Trash
              </span>
            </div>
          </div>
        </div>
      ) : null}
      <AutoRow steps={steps} at={countedAt} readOnly={readOnly} auto={auto} onFailed={onTrashed} />
      <ConfirmDialog
        open={asking}
        title={`Move ${plural(step.sessions)} to Trash?`}
        description={`${plural(step.sessions)} untouched for ${step.days} days or more (${formatBytes(step.bytes)}) go to the Trash: Claude Code's files and Claudock's archive copies together. You can put them back from there.`}
        confirmLabel="Move to Trash"
        tone="danger"
        busy={busy}
        onConfirm={() => void confirm()}
        onCancel={() => setAsking(false)}
      />
    </Card>
  )
}

const AGE_LABEL = (d: number): string => (d === 365 ? '1 year' : `${d} days`)
const AUTO_OPTIONS = AUTO_DELETE_DAYS.map((d) => ({ value: String(d), label: AGE_LABEL(d) }))

/** "today at 09:10", "yesterday at 09:10", "on Nov 20 at 09:10". */
function whenRan(ms: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const back = Math.round((day(new Date()) - day(d)) / 86_400_000)
  if (back === 0) return `today at ${time}`
  if (back === 1) return `yesterday at ${time}`
  return `on ${formatDate(ms)} at ${time}`
}

function lastLine(r: AutoDeleteRun): string {
  if (r.error) return `Last run ${whenRan(r.at)} failed: ${r.error}`
  if (r.sessions === 0) return `Last run ${whenRan(r.at)}: nothing to move`
  return `Last run ${whenRan(r.at)}: ${plural(r.sessions)}, ${formatBytes(r.bytes)}`
}

interface AutoRowProps {
  steps: AgeStep[]
  at: number
  readOnly: boolean
  auto: AutoDelete
  /** Storage counts again after a run through `archive:autoDeleted`; this is for a request that failed before one. */
  onFailed: () => void
}

/** Auto delete: a switch and an age; turning it on, or a younger age that moves more, asks first and moves them now. */
function AutoRow({ steps, at, readOnly, auto, onFailed }: AutoRowProps): JSX.Element {
  const toast = useToast()
  // what the user picked while the dialog or the request is open; null = what the main process holds
  const [want, setWant] = useState<{ on: boolean; days: number } | null>(null)
  // what the open dialog asks about; the switch and the select keep showing what is saved until it is confirmed
  const [asking, setAsking] = useState<{ on: boolean; days: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const shown = want ?? { on: auto.on, days: auto.days }
  const goes = (d: number): AgeStep => steps.find((s) => s.days === d) ?? { days: d, sessions: 0, bytes: 0 }

  async function apply(next: { on: boolean; days: number }): Promise<void> {
    setBusy(true)
    setWant(next)
    try {
      const g = goes(next.days)
      await api.archive.setAutoDelete(next.on, next.days, at, g.sessions)
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
      onFailed()
    } finally {
      setAsking(null)
      setBusy(false)
      setWant(null)
    }
  }

  function pick(next: { on: boolean; days: number }): void {
    // turning on asks; a younger age asks when it moves more than the age before; turning off never asks
    const more = next.on && (!auto.on || goes(next.days).sessions > goes(auto.days).sessions)
    if (more) setAsking(next)
    else void apply(next)
  }

  const g = goes((asking ?? shown).days)
  const age = AGE_LABEL((asking ?? shown).days)
  const turningOn = !auto.on
  return (
    <div className="ages__auto">
      <Toggle checked={shown.on} aria-label="Auto delete" disabled={readOnly || busy} onChange={(on) => pick({ on, days: shown.days })} />
      <div className="ages__autotext">
        Every day, move sessions untouched for{' '}
        <Select
          className="ages__sel"
          aria-label="Age"
          options={AUTO_OPTIONS}
          value={String(shown.days)}
          disabled={readOnly || busy}
          onChange={(v) => pick({ on: shown.on, days: Number(v) })}
        />{' '}
        to the Trash
      </div>
      {shown.on && auto.on && auto.last ? <span className="ages__last">{lastLine(auto.last)}</span> : null}
      <ConfirmDialog
        open={asking !== null}
        title={turningOn ? 'Turn on auto delete?' : `Move sessions untouched for ${age}?`}
        description={
          g.sessions === 0
            ? `Nothing is ${age} old yet. Every day, sessions that reach ${age} go to the Trash: Claude Code's files and Claudock's archive copies together.`
            : `${plural(g.sessions)} untouched for ${age} or more (${formatBytes(g.bytes)}) go to the Trash now: Claude Code's files and Claudock's archive copies together. After that, every day, sessions that reach ${age} go too.`
        }
        confirmLabel={turningOn ? 'Turn on' : 'Move to Trash'}
        tone="danger"
        busy={busy}
        onConfirm={() => asking && void apply(asking)}
        onCancel={() => setAsking(null)}
      />
    </div>
  )
}
