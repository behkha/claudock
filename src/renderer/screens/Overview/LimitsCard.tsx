import { useEffect, useState } from 'react'
import type { LimitWindow, LimitsPreview, LimitsState } from '@shared/api/limits'
import { formatCount } from '@shared/format'
import { LIMITS_STALE_MS, formatResetTime, formatTokens, limitView } from '@shared/limits'
import { Button, Card, ConfirmDialog, DiffView, useToast } from '@/components'
import { api, useApi, useEvent } from '@/lib/api'
import { cx } from '@/lib/cx'

const REFRESH_MS = 60_000
const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * The 5-hour and weekly limits as Claude Code reported them (once the status line step is on), and today's tokens
 * from the transcripts. Re-reads when Claude Code sends new limits and once a minute, so "as of" and resets stay true.
 */
export function LimitsCard(): JSX.Element {
  const limits = useApi(() => api.limits.get(), [])
  const [state, setState] = useState<LimitsState | undefined>()
  const [now, setNow] = useState(Date.now())
  const [confirm, setConfirm] = useState<LimitsPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => setState(limits.data), [limits.data])
  useEvent('limits:changed', setState)
  const { reload } = limits
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now())
      reload()
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [reload])

  const s = state ?? limits.data
  const on = s?.step === 'on'
  const today = s?.tokens.today

  const ask = (): void => {
    void api.limits.preview().then(setConfirm, (e: Error) => toast(e.message, { kind: 'error' }))
  }
  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      if (on) await api.limits.disable()
      else await api.limits.enable()
      setConfirm(null)
      setNow(Date.now())
      reload()
      toast(on ? 'Live limits off' : 'Live limits on', { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const stale = on && s?.live ? now - s.live.at > LIMITS_STALE_MS : false

  return (
    <Card
      title="Limits"
      className="lim"
      actions={
        on ? (
          <Button variant="ghost" onClick={ask}>
            Turn off
          </Button>
        ) : null
      }
    >
      <div className="lim__body" aria-busy={limits.loading && !s}>
        {on ? (
          <div className="lim__meters">
            <Meter label="5-hour" w={s?.live?.fiveHour} at={s?.live?.at} stale={stale} waiting={!s?.live} now={now} />
            <Meter label="Weekly" w={s?.live?.sevenDay} at={s?.live?.at} stale={stale} waiting={!s?.live} now={now} />
          </div>
        ) : s?.step === 'off' ? (
          <Button variant="primary" className="lim__show" onClick={ask}>
            Show live limits
          </Button>
        ) : null}
        <div className="lim__today">
          <span>Today</span>
          <span className="lim__mono">
            {today ? `${formatTokens(today.tokens)} tokens · ${formatCount(today.sessions)} ${today.sessions === 1 ? 'session' : 'sessions'}` : '…'}
          </span>
        </div>
        {limits.error ? (
          <p className="find__error" role="alert">
            {limits.error}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={on ? 'Turn off live limits' : 'Show live limits'}
        confirmLabel={on ? 'Turn off' : 'Turn on'}
        busy={busy}
        description={confirm ? <DiffView className="lim__diff" before={confirm.before ?? ''} after={confirm.after ?? ''} beforeLabel="statusLine now" afterLabel="after" /> : null}
        onConfirm={() => void apply()}
        onCancel={() => setConfirm(null)}
      />
    </Card>
  )
}

function Meter({
  label,
  w,
  at,
  stale,
  waiting,
  now
}: {
  label: string
  w: LimitWindow | null | undefined
  at: number | undefined
  stale: boolean
  waiting: boolean
  now: number
}): JSX.Element {
  const v = limitView(w, now)
  // a window Claude Code did not send (dropped after its reset, or not yet) waits for the next message
  const foot =
    waiting || !v.resetsAt
      ? 'Waiting for Claude Code'
      : v.reset
        ? `reset at ${formatResetTime(v.resetsAt, now)}`
        : `resets ${formatResetTime(v.resetsAt, now)}${stale && at ? ` · as of ${time(at)}` : ''}`
  return (
    <div className="lim__meter">
      <div className="lim__top">
        <span>{label}</span>
        <b className={cx(v.percent === null && 'lim__none')}>{v.percent === null ? '–' : `${v.percent}%`}</b>
      </div>
      <div
        className="lim__track"
        role="meter"
        aria-label={`${label} limit`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v.percent ?? undefined}
        aria-valuetext={v.percent === null ? foot : `${v.percent}% used, ${foot}`}
      >
        <div className={cx('lim__fill', stale && 'lim__fill--stale')} style={{ width: `${v.fill}%` }} />
      </div>
      <div className="lim__foot">{foot}</div>
    </div>
  )
}
