import { useEffect, useState } from 'react'
import type { ConnectParts, ConnectPreview, HookLine } from '@shared/api/connect'
import type { LimitWindow, LimitsState } from '@shared/api/limits'
import type { LiveSession, SessionsState } from '@shared/api/sessions'
import { formatCount } from '@shared/format'
import { LIMITS_STALE_MS, formatResetTime, formatTokens, limitView } from '@shared/limits'
import { waitText } from '@shared/sessions'
import { Button, Card, ConfirmDialog, DiffView, useToast } from '@/components'
import { api, useApi, useEvent } from '@/lib/api'
import { cx } from '@/lib/cx'

const REFRESH_MS = 60_000
const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * Claude Code right now: sessions waiting for you, working or done (from the session hooks), the 5-hour and weekly
 * limits as Claude Code reported them (from the status line step), and today's tokens from the transcripts.
 * "Connect to Claude Code" adds both parts in one write; Disconnect removes both. Re-reads when either part reports
 * and once a minute, so "as of", resets and waiting times stay true.
 */
export function ClaudeCodeCard(): JSX.Element {
  const limits = useApi(() => api.limits.get(), [])
  const live = useApi(() => api.sessions.get(), [])
  const [limitsState, setLimits] = useState<LimitsState | undefined>()
  const [sessionsState, setSessions] = useState<SessionsState | undefined>()
  const [now, setNow] = useState(Date.now())
  const [sheet, setSheet] = useState<{ preview: ConnectPreview; parts: ConnectParts } | null>(null)
  const [leaving, setLeaving] = useState<ConnectPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => setLimits(limits.data), [limits.data])
  useEffect(() => setSessions(live.data), [live.data])
  useEvent('limits:changed', setLimits)
  useEvent('sessions:changed', setSessions)
  const reloadLimits = limits.reload
  const reloadSessions = live.reload
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now())
      reloadLimits()
      reloadSessions()
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [reloadLimits, reloadSessions])

  const l = limitsState ?? limits.data
  const s = sessionsState ?? live.data
  const limitsOn = l?.step === 'on'
  const hooksOn = s?.hooks === 'on'
  // decide which buttons to offer only once both parts have answered, so a connected card never flashes "Connect"
  const known = l !== undefined && s !== undefined
  const supported = known && l.step !== 'unsupported'
  const today = l?.tokens.today

  /** Open the sheet with `want` ticked (the parts that can be added). */
  const openSheet = (want: ConnectParts): void => {
    void api.connect.previewConnect().then(
      (preview) =>
        setSheet({
          preview,
          parts: { statusLine: want.statusLine && preview.statusLine !== null, hooks: want.hooks && preview.hooks.length > 0 }
        }),
      (e: Error) => toast(e.message, { kind: 'error' })
    )
  }
  const askDisconnect = (): void => {
    void api.connect.previewDisconnect().then(setLeaving, (e: Error) => toast(e.message, { kind: 'error' }))
  }
  const run = async (fn: () => Promise<unknown>, done: string, close: () => void): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      close()
      setNow(Date.now())
      reloadLimits()
      reloadSessions()
      toast(done, { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const stale = limitsOn && l?.live ? now - l.live.at > LIMITS_STALE_MS : false
  const sessions = hooksOn ? (s?.sessions ?? []) : []

  return (
    <Card
      title="Claude Code"
      className="lim"
      actions={
        limitsOn || hooksOn ? (
          <Button variant="ghost" onClick={askDisconnect}>
            Disconnect
          </Button>
        ) : null
      }
    >
      <div className="lim__body" aria-busy={(limits.loading && !l) || (live.loading && !s)}>
        {supported && !limitsOn && !hooksOn ? (
          <Button variant="primary" className="lim__show" onClick={() => openSheet({ statusLine: true, hooks: true })}>
            Connect to Claude Code
          </Button>
        ) : null}
        {sessions.length > 0 ? (
          <ul className="cc__sessions" aria-label="Sessions">
            {sessions.map((x) => (
              <SessionRow key={x.id} s={x} now={now} />
            ))}
          </ul>
        ) : null}
        {known && limitsOn && !hooksOn ? (
          <Button className="lim__show" onClick={() => openSheet({ statusLine: false, hooks: true })}>
            Show waiting sessions
          </Button>
        ) : null}
        {limitsOn ? (
          <div className="lim__meters">
            <Meter label="5-hour" w={l?.live?.fiveHour} at={l?.live?.at} stale={stale} waiting={!l?.live} now={now} />
            <Meter label="Weekly" w={l?.live?.sevenDay} at={l?.live?.at} stale={stale} waiting={!l?.live} now={now} />
          </div>
        ) : known && hooksOn ? (
          <Button className="lim__show" onClick={() => openSheet({ statusLine: true, hooks: false })}>
            Show live limits
          </Button>
        ) : null}
        <div className="lim__today">
          <span>Today</span>
          <span className="lim__mono">
            {today ? `${formatTokens(today.tokens)} tokens · ${formatCount(today.sessions)} ${today.sessions === 1 ? 'session' : 'sessions'}` : '…'}
          </span>
        </div>
        {limits.error || live.error ? (
          <p className="find__error" role="alert">
            {limits.error ?? live.error}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={sheet !== null}
        title="Connect to Claude Code"
        confirmLabel="Connect"
        busy={busy}
        confirmDisabled={!sheet || (!sheet.parts.statusLine && !sheet.parts.hooks)}
        description={sheet ? <ConnectChoice preview={sheet.preview} parts={sheet.parts} onChange={(parts) => setSheet({ ...sheet, parts })} /> : null}
        onConfirm={() => sheet && void run(() => api.connect.connect(sheet.parts), 'Connected to Claude Code', () => setSheet(null))}
        onCancel={() => setSheet(null)}
      />
      <ConfirmDialog
        open={leaving !== null}
        title="Disconnect from Claude Code"
        confirmLabel="Disconnect"
        busy={busy}
        description={leaving ? <ChangeDiff preview={leaving} parts={{ statusLine: true, hooks: true }} removing /> : null}
        onConfirm={() => void run(() => api.connect.disconnect(), 'Disconnected from Claude Code', () => setLeaving(null))}
        onCancel={() => setLeaving(null)}
      />
    </Card>
  )
}

/** "now", "4 min", "2 h". */
function waited(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'now'
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h`
}

function SessionRow({ s, now }: { s: LiveSession; now: number }): JSX.Element {
  const toast = useToast()
  const show = (): void => void api.sessions.show(s.id).catch((e: Error) => toast(e.message, { kind: 'error' }))
  return (
    <li>
      <button
        type="button"
        className={cx('cc__row', `cc__row--${s.status}`)}
        onClick={show}
        title={s.cwd ?? undefined}
        aria-label={s.status === 'waiting' ? `${s.name}, waiting ${waited(now - s.since)}: ${waitText(s)}` : `${s.name}, ${s.status}`}
      >
        <span className="cc__dot" aria-hidden />
        <span className="cc__name">{s.name}</span>
        <span className="cc__when">{s.status === 'waiting' ? waited(now - s.since) : s.status}</span>
        {s.status === 'waiting' ? <span className="cc__what">{waitText(s)}</span> : null}
      </button>
    </li>
  )
}

/** The checkboxes, and the change the ticked parts make to settings.json. */
function ConnectChoice({ preview, parts, onChange }: { preview: ConnectPreview; parts: ConnectParts; onChange: (p: ConnectParts) => void }): JSX.Element {
  const canLimits = preview.statusLine !== null
  const canHooks = preview.hooks.length > 0
  // one shared reason (disableAllHooks) is shown once and describes both boxes
  const sharedProblem = preview.hooksProblem !== null && preview.hooksProblem === preview.statusLineProblem
  return (
    <div className="cc__sheet">
      {canLimits || preview.statusLineProblem ? (
        <label className="cc__check">
          <input
            type="checkbox"
            checked={parts.statusLine}
            disabled={!canLimits}
            aria-describedby={preview.statusLineProblem ? 'cc-limits-problem' : undefined}
            onChange={(e) => onChange({ ...parts, statusLine: e.target.checked })}
          />
          <span>Live limits</span>
        </label>
      ) : null}
      {preview.statusLineProblem ? (
        <p id="cc-limits-problem" className="find__error">
          {preview.statusLineProblem}
        </p>
      ) : null}
      {canHooks || preview.hooksProblem ? (
        <label className="cc__check">
          <input
            type="checkbox"
            checked={parts.hooks}
            disabled={!canHooks}
            aria-describedby={preview.hooksProblem ? (sharedProblem ? 'cc-limits-problem' : 'cc-hooks-problem') : undefined}
            onChange={(e) => onChange({ ...parts, hooks: e.target.checked })}
          />
          <span>Waiting sessions</span>
        </label>
      ) : null}
      {preview.hooksProblem && !sharedProblem ? (
        <p id="cc-hooks-problem" className="find__error">
          {preview.hooksProblem}
        </p>
      ) : null}
      {parts.statusLine || parts.hooks ? <ChangeDiff preview={preview} parts={parts} /> : null}
    </div>
  )
}

const hookText = (h: HookLine): string => `"${h.event}"${h.matcher ? ` (${h.matcher})` : ''}: ${h.command}`

/** settings.json lines before and after: statusLine, then one line per hook. */
function ChangeDiff({ preview, parts, removing }: { preview: ConnectPreview; parts: ConnectParts; removing?: boolean }): JSX.Element {
  const sl = parts.statusLine ? preview.statusLine : null
  const hooks = parts.hooks ? preview.hooks.map(hookText) : []
  const line = (cmd: string | null): string[] => (cmd === null ? [] : [`"statusLine": ${cmd}`])
  const before = [...line(sl ? sl.before : null), ...(removing ? hooks : [])]
  const after = [...line(sl ? sl.after : null), ...(removing ? [] : hooks)]
  return <DiffView className="lim__diff cc__diff" before={before.join('\n')} after={after.join('\n')} beforeLabel="settings.json now" afterLabel="after" />
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
