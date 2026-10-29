import type { WeekStats, WrappedStats } from '@shared/api/overview'
import { formatCount } from '@shared/format'
import { heatLevels } from '@shared/heat'
import { formatTokens } from '@shared/limits'
import { formatUsd, type PlanChoice } from '@shared/prices'
import { HEATMAP_WEEKS, REPO_LABEL, addDays, formatDuration, formatHour, formatRange, formatSince, heatmapStart, planLabel, weekValue, weekday } from '@shared/wrapped'

/**
 * The share cards, drawn on a canvas at 2x (2400x1350) from a 1200x675 layout: all time (drawCard) and one week at API
 * prices (drawWeekCard). The dialog shows this same canvas scaled down, so what you see is what Copy / Save / Post send.
 * Fixed dark look (the app's dark tokens), whatever the app theme.
 */

export const CARD_W = 1200
export const CARD_H = 675
const SCALE = 2
const PAD = Math.round(CARD_W * 0.06)
const INNER = CARD_W - PAD * 2

const BG = '#1f1e1d'
const TEXT = '#faf9f5'
const TEXT_2 = '#c2c0b6'
const TEXT_3 = '#9c9a92'
const CLAY = '#d97757'
const LINE = 'rgba(222, 220, 209, 0.15)'
const HEAT = ['rgba(217, 119, 87, 0.35)', 'rgba(217, 119, 87, 0.65)', CLAY]

interface Stack {
  serif: string
  sans: string
  mono: string
}

function stacks(): Stack {
  const css = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback
  return {
    serif: get('--font-serif', 'Georgia, serif'),
    sans: get('--font-sans', 'system-ui, sans-serif'),
    mono: get('--font-mono', 'Menlo, monospace')
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[]): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** Fonts ready, canvas sized, background painted, the top line written. */
async function begin(canvas: HTMLCanvasElement, top: string): Promise<{ ctx: CanvasRenderingContext2D; f: Stack }> {
  await document.fonts.ready
  const f = stacks()
  canvas.width = CARD_W * SCALE
  canvas.height = CARD_H * SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available')
  ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, CARD_W, CARD_H)
  ctx.fillStyle = TEXT_3
  ctx.font = `20px ${f.mono}`
  ctx.fillText(top, PAD, PAD + 16)
  return { ctx, f }
}

/** The big number and its unit on one baseline, shrunk until both fit in `width`. Returns the baseline. */
function hero(ctx: CanvasRenderingContext2D, f: Stack, number: string, unit: string, width: number, from = 148): number {
  let size = from
  const measure = (px: number): number => {
    ctx.font = `330 ${px}px ${f.serif}`
    const a = ctx.measureText(number).width
    ctx.font = `330 ${Math.round(px * 0.4)}px ${f.serif}`
    return a + ctx.measureText(` ${unit}`).width
  }
  while (size > 60 && measure(size) > width) size -= 4
  const baseline = PAD + 16 + 28 + Math.round(size * 0.78)
  ctx.font = `330 ${size}px ${f.serif}`
  ctx.fillStyle = TEXT
  ctx.fillText(number, PAD, baseline)
  const numberW = ctx.measureText(number).width
  ctx.font = `330 ${Math.round(size * 0.4)}px ${f.serif}`
  ctx.fillStyle = TEXT_2
  ctx.fillText(` ${unit}`, PAD + numberW, baseline)
  return baseline
}

/** A rule, then one column per cell: the value in serif, its label under it. */
function cells(ctx: CanvasRenderingContext2D, f: Stack, top: number, list: Array<[string, string]>): void {
  ctx.fillStyle = LINE
  ctx.fillRect(PAD, top, INNER, 1)
  const colW = INNER / list.length
  list.forEach(([value, label], i) => {
    const x = PAD + i * colW
    ctx.fillStyle = TEXT
    ctx.font = `330 46px ${f.serif}`
    let v = value
    while (v.length > 1 && ctx.measureText(v).width > colW - 24) v = v.slice(0, -1)
    ctx.fillText(v === value ? v : `${v.trimEnd()}…`, x, top + 62)
    ctx.fillStyle = TEXT_3
    ctx.font = `18px ${f.sans}`
    ctx.fillText(label, x, top + 92)
  })
}

function footer(ctx: CanvasRenderingContext2D, f: Stack): void {
  const base = CARD_H - PAD
  ctx.fillStyle = TEXT_3
  ctx.font = `18px ${f.sans}`
  ctx.fillText(REPO_LABEL, PAD, base)
  ctx.fillStyle = TEXT
  ctx.font = `330 28px ${f.serif}`
  ctx.textAlign = 'right'
  ctx.fillText('Claudock', CARD_W - PAD, base + 2)
  ctx.textAlign = 'left'
}

const dash = (v: number | null, fmt: (n: number) => string): string => (v === null ? '–' : fmt(v))

/** Draws the all-time card into `canvas` (sets its size). Resolves when fonts are ready and the drawing is done. */
export async function drawCard(canvas: HTMLCanvasElement, stats: WrappedStats): Promise<void> {
  const since = stats.since ? formatSince(stats.since) : ''
  const { ctx, f } = await begin(canvas, since ? `~/.claude · since ${since}` : '~/.claude')
  const baseline = hero(ctx, f, formatCount(stats.total ?? 0), stats.unit, INNER)

  cells(ctx, f, baseline + 40, [
    [dash(stats.sessions, formatCount), 'sessions'],
    [dash(stats.longestSessionMs, formatDuration), 'longest session'],
    [dash(stats.longestRunDays, (n) => `${formatCount(n)} ${n === 1 ? 'day' : 'days'}`), 'longest run'],
    [dash(stats.peakHour, formatHour), 'peak hour'],
    [stats.topModel ?? '–', 'top model']
  ])

  // heat map: 26 weeks (columns) x 7 weekdays (rows), Sunday on top
  const gap = 5
  const cellH = 18
  const gridH = 7 * cellH + 6 * gap
  const gridTop = CARD_H - PAD - 44 - gridH
  const cellW = (INNER - (HEATMAP_WEEKS - 1) * gap) / HEATMAP_WEEKS
  const start = heatmapStart(stats.asOf)
  const days = (HEATMAP_WEEKS - 1) * 7 + weekday(stats.asOf) + 1
  const level = heatLevels(Object.values(stats.daily))
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i)
    ctx.fillStyle = HEAT[level(stats.daily[date] ?? 0) - 1] ?? LINE
    roundRect(ctx, PAD + Math.floor(i / 7) * (cellW + gap), gridTop + (i % 7) * (cellH + gap), cellW, cellH, 3)
    ctx.fill()
  }
  footer(ctx, f)
}

/** Draws one week's card: its value at API prices (or its tokens), the days, the models, the week's numbers. */
export async function drawWeekCard(canvas: HTMLCanvasElement, w: WeekStats, plan: PlanChoice): Promise<void> {
  const { ctx, f } = await begin(canvas, `~/.claude · ${formatRange(w.start, w.end, true)}`)
  const value = weekValue(w, plan)
  const usd = value !== null

  // the plan beside the value, as a pill at the right of the hero line
  const label = planLabel(w, plan)
  let pillW = 0
  if (label) {
    ctx.font = `20px ${f.sans}`
    pillW = ctx.measureText(label).width + 40
  }
  const baseline = hero(ctx, f, value ?? formatTokens(w.tokens), usd ? 'at API prices' : 'tokens', INNER - (pillW ? pillW + 32 : 0), 132)
  if (label) {
    const h = 40
    const y = baseline - 34 - h / 2
    ctx.strokeStyle = LINE
    ctx.lineWidth = 1.5
    roundRect(ctx, CARD_W - PAD - pillW, y, pillW, h, h / 2)
    ctx.stroke()
    ctx.fillStyle = TEXT_2
    ctx.font = `20px ${f.sans}`
    ctx.fillText(label, CARD_W - PAD - pillW + 20, y + 27)
  }

  // the days (left) and the models (right), between the hero and the numbers
  const cellsTop = CARD_H - PAD - 44 - 104
  const top = baseline + 36
  const bottom = cellsTop - 30
  const metric = (d: { usd: number; tokens: number }): number => (usd ? d.usd : d.tokens)
  const daysW = Math.round(INNER * 0.52)
  const gap = 14
  const barW = (daysW - 6 * gap) / 7
  const labelH = 26
  const barsH = bottom - top - labelH
  const max = Math.max(...w.days.map(metric)) || 1
  const today = w.current ? w.days.filter((d) => !d.future).length - 1 : -1
  w.days.forEach((d, i) => {
    const x = PAD + i * (barW + gap)
    if (d.future) {
      ctx.strokeStyle = LINE
      ctx.lineWidth = 1.5
      ctx.setLineDash([5, 5])
      roundRect(ctx, x + 0.75, bottom - labelH - 14, barW - 1.5, 14, [4, 4, 0, 0])
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      const h = Math.max(2, Math.round((metric(d) / max) * barsH))
      ctx.fillStyle = metric(d) > 0 ? (i === today ? CLAY : HEAT[1]) : LINE
      roundRect(ctx, x, bottom - labelH - h, barW, h, h > 8 ? [6, 6, 0, 0] : 0)
      ctx.fill()
    }
    const [y, m, day] = d.date.split('-').map(Number)
    ctx.fillStyle = i === today ? TEXT : TEXT_3
    ctx.font = `16px ${f.sans}`
    ctx.textAlign = 'center'
    ctx.fillText(new Date(y, m - 1, day).toLocaleDateString('en', { weekday: 'narrow' }), x + barW / 2, bottom)
    ctx.textAlign = 'left'
  })

  // models: a split bar by value (or tokens), the top three named, the rest as "Other"
  const shown = w.models.filter((m) => (usd ? m.usd !== null && m.usd > 0 : m.tokens > 0))
  const amount = (m: { usd: number | null; tokens: number }): number => (usd ? (m.usd ?? 0) : m.tokens)
  const keys = shown.slice(0, 3).map((m) => ({ name: m.name, v: amount(m) }))
  const rest = shown.slice(3).reduce((n, m) => n + amount(m), 0)
  if (rest > 0) keys.push({ name: 'Other', v: rest })
  const total = keys.reduce((n, k) => n + k.v, 0)
  if (total > 0) {
    const x0 = PAD + daysW + Math.round(INNER * 0.08)
    const width = PAD + INNER - x0
    const rows = keys.length
    const keyTop = bottom - rows * 34 + 6
    const barY = keyTop - 34
    const colors = [CLAY, HEAT[1], HEAT[0], LINE]
    let x = x0
    keys.forEach((k, i) => {
      const segW = i === keys.length - 1 ? x0 + width - x : Math.max(3, (k.v / total) * width - 3)
      ctx.fillStyle = colors[i]
      roundRect(ctx, x, barY, Math.max(2, segW), 16, i === 0 && keys.length === 1 ? 8 : i === 0 ? [8, 0, 0, 8] : i === keys.length - 1 ? [0, 8, 8, 0] : 0)
      ctx.fill()
      x += segW + 3
    })
    keys.forEach((k, i) => {
      const y = keyTop + i * 34 + 14
      ctx.fillStyle = colors[i]
      ctx.beginPath()
      ctx.arc(x0 + 7, y - 6, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = TEXT_2
      ctx.font = `20px ${f.sans}`
      ctx.fillText(k.name, x0 + 26, y)
      ctx.textAlign = 'right'
      ctx.fillText(usd ? formatUsd(k.v) : formatTokens(k.v), x0 + width, y)
      ctx.textAlign = 'left'
    })
  }

  const list: Array<[string, string]> = [
    [formatCount(w.sessions), w.sessions === 1 ? 'session' : 'sessions'],
    [formatCount(w.prompts), w.prompts === 1 ? 'prompt' : 'prompts']
  ]
  if (usd) list.push([formatTokens(w.tokens), 'tokens'])
  list.push([dash(w.longestSessionMs, formatDuration), 'longest session'], [w.topModel ?? '–', 'top model'])
  cells(ctx, f, cellsTop, list)
  footer(ctx, f)
}

/** PNG bytes of the drawn card. */
export function cardPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Could not make the image'))
      blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject)
    }, 'image/png')
  })
}
