import { useCallback, useEffect, useRef, useState } from 'react'
import { Share2 } from 'lucide-react'
import type { SessionsState } from '@shared/api/sessions'
import type { TodayDay, TodaySession } from '@shared/api/today'
import { formatBytes, formatCount } from '@shared/format'
import { formatTokens } from '@shared/limits'
import { Button, Card } from '@/components'
import { api, useApi, useEvent } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useNav, type ScreenProps } from '@/lib/nav'
import { useFindings } from '../Storage/useFindings'
import { NowCard } from './NowCard'
import { ShareDialog } from './ShareDialog'
import './today.css'

const REFRESH_MS = 60_000
/** Sessions report every tool they run: today's list follows them at most this often. */
const FOLLOW_MS = 10_000

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * The home screen (checklist item 10): today's tokens with the last 7 days beside them, what is running now (waiting,
 * working, done) with both limits, then today's other sessions. Cleanup is one chip that opens Storage. `selectId`
 * 'disconnect' opens the Disconnect dialog (the Hooks screen's Claudock row).
 */
export default function TodayScreen({ selectId }: ScreenProps): JSX.Element {
  const { navigate, seq } = useNav()
  const today = useApi(() => api.today.get(), [])
  const wrapped = useApi(() => api.overview.wrapped(), [])
  const found = useFindings()
  const [sharing, setSharing] = useState(false)
  const [live, setLive] = useState<Set<string>>(new Set())

  const reload = today.reload
  const loadedAt = useRef(Date.now())
  const follow = useCallback(() => {
    if (Date.now() - loadedAt.current < FOLLOW_MS) return
    loadedAt.current = Date.now()
    reload()
  }, [reload])
  useEffect(() => {
    const t = setInterval(() => {
      loadedAt.current = Date.now()
      reload()
    }, REFRESH_MS)
    return () => clearInterval(t)
  }, [reload])
  useEvent('sessions:changed', follow)
  const onSessions = useCallback((s: SessionsState) => setLive(new Set(s.hooks === 'on' ? s.sessions.map((x) => x.id) : [])), [])

  const t = today.data
  const earlier = t ? t.sessions.filter((s) => !live.has(s.id)) : []
  const flagged = found.findings.reduce((n, f) => n + (f.bytes ?? 0), 0)
  const look = found.findings.length > 0 ? `Worth a look · ${flagged > 0 ? formatBytes(flagged) : formatCount(found.findings.length)}` : null

  return (
    <div className="page">
      <div className="page__inner today">
        <header className="today__head">
          <div className="today__lead">
            <h1 className="today__title">Today</h1>
            <p className="today__sum" aria-live="polite">
              {t ? `${formatTokens(t.tokens)} tokens · ${formatCount(t.sessions.length)} ${t.sessions.length === 1 ? 'session' : 'sessions'}` : ' '}
            </p>
            <div className="today__actions">
              {look ? (
                <button type="button" className="chip chip--button today__chip" onClick={() => navigate('storage')}>
                  <span className="today__chipdot" aria-hidden />
                  {look}
                </button>
              ) : null}
              <Button variant="ghost" icon={<Share2 size={16} strokeWidth={1.8} />} onClick={() => setSharing(true)} disabled={!wrapped.data?.total}>
                Share
              </Button>
            </div>
          </div>
          {t ? <Week days={t.days} /> : <div className="week" aria-hidden />}
        </header>

        <NowCard disconnect={selectId === 'disconnect' ? seq : undefined} onSessions={onSessions} />

        {today.error ? (
          <p className="find__error" role="alert">
            {today.error}
          </p>
        ) : t && t.sessions.length === 0 ? (
          <p className="today__none">No sessions yet today</p>
        ) : earlier.length > 0 ? (
          <Card title={live.size > 0 ? 'Earlier today' : 'Sessions'}>
            <ul className="hist" aria-label="Today's sessions">
              {earlier.map((s) => (
                <HistoryRow key={s.id} s={s} onOpen={() => navigate('projects', `${s.projectId}/${s.id}`)} />
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
      <ShareDialog open={sharing} stats={wrapped.data} onClose={() => setSharing(false)} />
    </div>
  )
}

/** One of today's sessions; opens its transcript in Projects. */
function HistoryRow({ s, onOpen }: { s: TodaySession; onOpen: () => void }): JSX.Element {
  const span = s.last - s.first < 60_000 ? time(s.first) : `${time(s.first)}–${time(s.last)}`
  return (
    <li>
      <button type="button" className="hist__row" onClick={onOpen} aria-label={`${s.title || s.folder} in ${s.folder}, ${span}, ${formatTokens(s.tokens)} tokens. Open transcript`}>
        <span className="hist__name">
          {s.title || s.folder}
          {s.title ? <span className="hist__folder">{s.folder}</span> : null}
        </span>
        <span className="hist__time">{span}</span>
        <span className="hist__tokens">{formatTokens(s.tokens)}</span>
      </button>
    </li>
  )
}

/** Tokens per day for the last 7 days, to scale, today in clay. */
function Week({ days }: { days: TodayDay[] }): JSX.Element {
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const named = days.map((d, i) => {
    const [y, m, day] = d.date.split('-').map(Number)
    const date = new Date(y, m - 1, day)
    return { ...d, short: date.toLocaleDateString(undefined, { weekday: 'narrow' }), long: date.toLocaleDateString(undefined, { weekday: 'long' }), today: i === days.length - 1 }
  })
  return (
    <figure className="week" role="img" aria-label={`Tokens this week: ${named.map((d) => `${d.long} ${formatTokens(d.tokens)}`).join(', ')}`}>
      <div className="week__bars">
        {named.map((d) => (
          <span key={d.date} className="week__col" title={`${d.long}: ${formatTokens(d.tokens)} tokens`}>
            <i className={cx('week__bar', d.today && 'week__bar--today')} style={{ height: `${(d.tokens / max) * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="week__days" aria-hidden>
        {named.map((d) => (
          <span key={d.date} className={cx(d.today && 'week__day--today')}>
            {d.short}
          </span>
        ))}
      </div>
    </figure>
  )
}
