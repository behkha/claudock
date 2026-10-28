import { useEffect, useState } from 'react'
import type { ConnectParts, ConnectPreview } from '@shared/api/connect'
import type { LimitsState } from '@shared/api/limits'
import type { SessionsState } from '@shared/api/sessions'
import { formatCount } from '@shared/format'
import { LIMITS_STALE_MS, formatTokens } from '@shared/limits'
import { Button, Card, ConfirmDialog, useToast } from '@/components'
import { ChangeDiff, ConnectSheet } from '@/components/ConnectSheet'
import { LimitMeter, SessionRow } from '@/components/live'
import { api, useApi, useEvent } from '@/lib/api'

const REFRESH_MS = 60_000

/**
 * Claude Code right now: sessions waiting for you, working or done (from the session hooks), the 5-hour and weekly
 * limits as Claude Code reported them (from the status line step), and today's tokens from the transcripts.
 * "Connect to Claude Code" adds both parts in one write; Disconnect removes both. Re-reads when either part reports
 * and once a minute, so "as of", resets and waiting times stay true. `disconnect` (the navigation's seq) opens the
 * Disconnect dialog, for the Hooks screen's Claudock row.
 */
export function ClaudeCodeCard({ disconnect }: { disconnect?: number }): JSX.Element {
  const limits = useApi(() => api.limits.get(), [])
  const live = useApi(() => api.sessions.get(), [])
  const [limitsState, setLimits] = useState<LimitsState | undefined>()
  const [sessionsState, setSessions] = useState<SessionsState | undefined>()
  const [now, setNow] = useState(Date.now())
  const [want, setWant] = useState<ConnectParts | null>(null)
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

  /** Open the sheet with these parts ticked (the ones that can still be added). */
  const openSheet = (parts: ConnectParts): void => setWant(parts)
  const refresh = (): void => {
    setNow(Date.now())
    reloadLimits()
    reloadSessions()
  }
  const askDisconnect = (): void => {
    void api.connect.previewDisconnect().then(setLeaving, (e: Error) => toast(e.message, { kind: 'error' }))
  }
  useEffect(() => {
    if (disconnect !== undefined) askDisconnect()
    // once per navigation; askDisconnect is recreated every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disconnect])
  const run = async (fn: () => Promise<unknown>, done: string, close: () => void): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      close()
      refresh()
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
            <LimitMeter label="5-hour" w={l?.live?.fiveHour} at={l?.live?.at} stale={stale} waiting={!l?.live} now={now} />
            <LimitMeter label="Weekly" w={l?.live?.sevenDay} at={l?.live?.at} stale={stale} waiting={!l?.live} now={now} />
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
      <ConnectSheet want={want} onClose={() => setWant(null)} onConnected={refresh} />
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
