import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, X } from 'lucide-react'
import type { ShareCard, ShareSettings, WeekStats, WrappedStats } from '@shared/api/overview'
import { PLANS, type PlanChoice } from '@shared/prices'
import { formatDay, formatRange, formatSince } from '@shared/wrapped'
import { Button, EmptyState, IconButton, Segmented, Select, Spinner, Toggle } from '@/components'
import { api, useApi } from '@/lib/api'
import { cardPng, drawCard, drawWeekCard } from './wrappedCard'
import './share.css'

type Action = 'copy' | 'save' | 'post'
type Status = { kind: 'ok' | 'error'; text: string }
export type ShareTab = 'week' | 'all'

const DONE: Record<Action, string> = {
  copy: 'Copied',
  save: 'Saved',
  post: 'Image copied. Paste it into your post.'
}

const PLAN_OPTIONS = [{ value: 'value', label: 'Value only' }, ...PLANS.map((p) => ({ value: p.id, label: `${p.name} · $${p.usd}/mo` })), { value: 'hide', label: 'Hide value' }]

/** A rate per million tokens: "$4", "$0.20", "$2.50", "$0.125", "$55". */
function rate(n: number): string {
  const v = Number(n.toFixed(4))
  return `$${!Number.isInteger(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-9 ? v.toFixed(2) : v}`
}

/**
 * Modal with the share cards: the week (Monday to Sunday, at API prices, ‹ › back as far as the transcripts reach) and
 * all time. The canvas is drawn at 2400x1350 and shown scaled down by CSS, so the preview is the exported image. What
 * goes beside the week's value and the Monday recap are per profile. Feedback sits in the dialog because the toast layer
 * is underneath a modal <dialog>.
 */
export function ShareDialog({
  open,
  stats,
  onClose,
  tab: firstTab = 'week',
  week: firstWeek = null
}: {
  open: boolean
  stats: WrappedStats | null | undefined
  onClose: () => void
  tab?: ShareTab
  /** Monday of the week to open on; null for the current one. */
  week?: string | null
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [tab, setTab] = useState<ShareTab>(firstTab)
  const [start, setStart] = useState<string | null>(firstWeek)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState<Action | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [prices, setPrices] = useState(false)
  const [settings, setSettings] = useState<ShareSettings | null>(null)

  const week = useApi<WeekStats | null>(() => (open ? api.overview.week(start) : Promise.resolve(null)), [open, start])
  const w = week.data && (start === null || week.data.start === start) ? week.data : null

  useEffect(() => {
    const d = dialogRef.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  useEffect(() => {
    if (!open) return
    setTab(firstTab)
    setStart(firstWeek)
    setStatus(null)
    setBusy(null)
    setPrices(false)
    let stale = false
    api.overview.shareSettings().then(
      (s) => void (stale || setSettings(s)),
      () => void (stale || setSettings({ plan: 'value', recap: false }))
    )
    return () => {
      stale = true
    }
  }, [open, firstTab, firstWeek])

  const plan: PlanChoice = settings?.plan ?? 'value'
  const showWeek = tab === 'week'
  const weekEmpty = !!w && w.sessions === 0
  const drawable = open && settings !== null && (showWeek ? !!w && !weekEmpty : !!stats)

  useEffect(() => {
    const canvas = canvasRef.current
    setReady(false)
    if (!drawable || !canvas) return
    canvas.dataset.ready = 'false'
    let stale = false
    const drawing = showWeek && w ? drawWeekCard(canvas, w, plan) : stats ? drawCard(canvas, stats) : Promise.resolve()
    drawing.then(
      () => {
        if (stale) return
        canvas.dataset.ready = 'true'
        setReady(true)
      },
      (e: unknown) => {
        if (!stale)
          setStatus({
            kind: 'error',
            text: e instanceof Error ? e.message : String(e)
          })
      }
    )
    return () => {
      stale = true
    }
  }, [drawable, showWeek, w, stats, plan])

  async function change(patch: Partial<ShareSettings>): Promise<void> {
    const before = settings
    if (before) setSettings({ ...before, ...patch })
    try {
      setSettings(await api.overview.setShareSettings(patch))
    } catch (e) {
      setSettings(before)
      setStatus({
        kind: 'error',
        text: e instanceof Error ? e.message : String(e)
      })
    }
  }

  async function run(action: Action): Promise<void> {
    const canvas = canvasRef.current
    if (!canvas || !ready) return
    const card: ShareCard = showWeek && w ? { kind: 'week', start: w.start, plan } : { kind: 'all' }
    setBusy(action)
    setStatus(null)
    try {
      const png = await cardPng(canvas)
      if (action === 'copy') await api.overview.copyImage(png)
      else if (action === 'post') await api.overview.postOnX(png, card)
      else if (!(await api.overview.saveImage(png, card)).saved) return
      setStatus({ kind: 'ok', text: DONE[action] })
    } catch (e) {
      setStatus({
        kind: 'error',
        text: e instanceof Error ? e.message : String(e)
      })
    } finally {
      setBusy(null)
    }
  }

  const step = (days: number): void => {
    if (!w) return
    const [y, m, d] = w.start.split('-').map(Number)
    const next = new Date(y, m - 1, d + days)
    setStart(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`)
    setStatus(null)
  }

  const disabled = !ready || busy !== null
  const range = w ? formatRange(w.start, w.end) : ''
  const unpriced = w ? w.models.filter((m) => m.usd === null) : []

  let body: JSX.Element
  if (showWeek && week.error && !w) body = <EmptyState title="Couldn’t read this week" description={week.error} />
  else if (showWeek && !w) body = <div className="share__wait">{week.loading ? <Spinner /> : null}</div>
  else if (showWeek && weekEmpty) body = <EmptyState title="No sessions this week" />
  else if (!showWeek && !stats) body = <EmptyState title="No stats yet" />
  else
    body = (
      <div className="share__frame">
        <canvas
          ref={canvasRef}
          className="share__canvas"
          aria-label={showWeek ? `Your Claude Code week, ${range}` : `Your Claude Code since ${stats?.since ? formatSince(stats.since) : 'the start'}`}
          role="img"
        />
      </div>
    )

  return (
    <dialog
      ref={dialogRef}
      className="dialog share"
      aria-labelledby="share-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose()
      }}
    >
      {open ? (
        <div className="dialog__panel share__panel">
          <header className="share__head">
            <h2 id="share-title" className="dialog__title">
              Share stats
            </h2>
            <IconButton aria-label="Close" icon={<X size={16} strokeWidth={1.8} />} onClick={onClose} />
          </header>
          <div className="share__bar">
            <Segmented<ShareTab>
              aria-label="Card"
              options={[
                { value: 'week', label: 'Week' },
                { value: 'all', label: 'All time' }
              ]}
              value={tab}
              onChange={(t) => {
                setTab(t)
                setStatus(null)
              }}
            />
            {showWeek ? (
              <>
                <div className="share__step">
                  <IconButton aria-label="Previous week" icon={<ChevronLeft size={16} strokeWidth={1.8} />} disabled={!w || w.start <= w.earliest} onClick={() => step(-7)} />
                  <span className="share__range" aria-live="polite">
                    {range}
                  </span>
                  <IconButton aria-label="Next week" icon={<ChevronRight size={16} strokeWidth={1.8} />} disabled={!w || w.current} onClick={() => step(7)} />
                </div>
                <Select
                  className="share__plan"
                  aria-label="Beside the value"
                  options={PLAN_OPTIONS}
                  value={plan}
                  disabled={!settings}
                  onChange={(v) => void change({ plan: v as PlanChoice })}
                />
              </>
            ) : null}
          </div>
          {body}
          <div className="share__foot">
            {showWeek && prices && w ? (
              <div className="share__prices">
                <table>
                  <caption>Anthropic API prices, {formatDay(w.prices.asOf)}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Per million tokens</th>
                      <th scope="col">Input</th>
                      <th scope="col">Output</th>
                      <th scope="col">5-min write</th>
                      <th scope="col">1-hour write</th>
                      <th scope="col">Cache read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.prices.rows.map((r) => (
                      <tr key={r.name}>
                        <th scope="row">{r.name}</th>
                        <td>{rate(r.input)}</td>
                        <td>{rate(r.output)}</td>
                        <td>{rate(r.write5m)}</td>
                        <td>{rate(r.write1h)}</td>
                        <td>{rate(r.read)}</td>
                      </tr>
                    ))}
                    {w.prices.searches > 0 ? (
                      <tr className="share__unpriced">
                        <th scope="row">Web search</th>
                        <td colSpan={5}>$10 per 1,000 searches</td>
                      </tr>
                    ) : null}
                    {unpriced.map((m) => (
                      <tr key={m.name} className="share__unpriced">
                        <th scope="row">{m.name}</th>
                        <td colSpan={5}>No price</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <div className="share__actions">
              {showWeek ? (
                <Toggle className="share__recap" label="Monday recap" checked={settings?.recap ?? false} disabled={!settings} onChange={(on) => void change({ recap: on })} />
              ) : null}
              <p className={status?.kind === 'error' ? 'share__status share__status--error' : 'share__status'} role={status?.kind === 'error' ? 'alert' : 'status'}>
                {status?.kind === 'ok' ? <Check size={14} strokeWidth={1.8} aria-hidden /> : null}
                {status?.text}
              </p>
              {showWeek ? (
                <Button variant="ghost" aria-expanded={prices} onClick={() => setPrices(!prices)} disabled={!w || w.usd === null}>
                  Prices
                </Button>
              ) : null}
              <Button icon={<Copy size={15} strokeWidth={1.8} />} onClick={() => void run('copy')} disabled={disabled} loading={busy === 'copy'}>
                Copy image
              </Button>
              <Button icon={<Download size={15} strokeWidth={1.8} />} onClick={() => void run('save')} disabled={disabled} loading={busy === 'save'}>
                Save PNG
              </Button>
              <Button variant="primary" icon={<ExternalLink size={15} strokeWidth={1.8} />} onClick={() => void run('post')} disabled={disabled} loading={busy === 'post'}>
                Post on X
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  )
}
