import type { WrappedStats } from '@shared/api/overview'
import { formatCount } from '@shared/format'
import { heatLevels } from '@shared/heat'
import { HEATMAP_WEEKS, REPO_LABEL, addDays, formatDuration, formatHour, formatSince, heatmapStart, weekday } from '@shared/wrapped'

/**
 * The share card, drawn on a canvas at 2x (2400x1350) from a 1200x675 layout. The modal shows this same canvas scaled
 * down, so what you see is what Copy / Save / Post send. Fixed dark look (the app's dark tokens), whatever the app theme.
 */

export const CARD_W = 1200
export const CARD_H = 675
const SCALE = 2
const PAD = Math.round(CARD_W * 0.06)

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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** Draws the card into `canvas` (sets its size). Resolves when fonts are ready and the drawing is done. */
export async function drawCard(canvas: HTMLCanvasElement, stats: WrappedStats): Promise<void> {
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

  const inner = CARD_W - PAD * 2

  // top line
  ctx.fillStyle = TEXT_3
  ctx.font = `20px ${f.mono}`
  const since = stats.since ? formatSince(stats.since) : ''
  ctx.fillText(since ? `~/.claude · since ${since}` : '~/.claude', PAD, PAD + 16)

  // the big number: shrink the type until number + unit fit the card
  const number = formatCount(stats.total ?? 0)
  let size = 148
  const measure = (px: number): number => {
    ctx.font = `330 ${px}px ${f.serif}`
    const a = ctx.measureText(number).width
    ctx.font = `330 ${Math.round(px * 0.4)}px ${f.serif}`
    return a + ctx.measureText(` ${stats.unit}`).width
  }
  while (size > 60 && measure(size) > inner) size -= 4
  const baseline = PAD + 16 + 28 + Math.round(size * 0.78)
  ctx.font = `330 ${size}px ${f.serif}`
  ctx.fillStyle = TEXT
  ctx.fillText(number, PAD, baseline)
  const numberW = ctx.measureText(number).width
  ctx.font = `330 ${Math.round(size * 0.4)}px ${f.serif}`
  ctx.fillStyle = TEXT_2
  ctx.fillText(` ${stats.unit}`, PAD + numberW, baseline)

  // stats row
  const rowTop = baseline + 40
  ctx.fillStyle = LINE
  ctx.fillRect(PAD, rowTop, inner, 1)
  const cells: Array<[string, string]> = [
    [stats.sessions === null ? '–' : formatCount(stats.sessions), 'sessions'],
    [stats.longestSessionMs === null ? '–' : formatDuration(stats.longestSessionMs), 'longest session'],
    [stats.peakHour === null ? '–' : formatHour(stats.peakHour), 'peak hour'],
    [stats.topModel ?? '–', 'top model']
  ]
  const colW = inner / cells.length
  cells.forEach(([value, label], i) => {
    const x = PAD + i * colW
    ctx.fillStyle = TEXT
    ctx.font = `330 46px ${f.serif}`
    let v = value
    while (v.length > 1 && ctx.measureText(v).width > colW - 24) v = v.slice(0, -1)
    ctx.fillText(v === value ? v : `${v.trimEnd()}…`, x, rowTop + 62)
    ctx.fillStyle = TEXT_3
    ctx.font = `18px ${f.sans}`
    ctx.fillText(label, x, rowTop + 92)
  })

  // heat map: 26 weeks (columns) x 7 weekdays (rows), Sunday on top
  const footerBase = CARD_H - PAD
  const gap = 5
  const cellH = 18
  const gridH = 7 * cellH + 6 * gap
  const gridTop = footerBase - 44 - gridH
  const cellW = (inner - (HEATMAP_WEEKS - 1) * gap) / HEATMAP_WEEKS
  const start = heatmapStart(stats.asOf)
  const days = (HEATMAP_WEEKS - 1) * 7 + weekday(stats.asOf) + 1
  const level = heatLevels(Object.values(stats.daily))
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i)
    const col = Math.floor(i / 7)
    const row = i % 7
    ctx.fillStyle = HEAT[level(stats.daily[date] ?? 0) - 1] ?? LINE
    roundRect(ctx, PAD + col * (cellW + gap), gridTop + row * (cellH + gap), cellW, cellH, 3)
    ctx.fill()
  }

  // footer
  ctx.fillStyle = TEXT_3
  ctx.font = `18px ${f.sans}`
  ctx.fillText(REPO_LABEL, PAD, footerBase)
  ctx.fillStyle = TEXT
  ctx.font = `330 28px ${f.serif}`
  ctx.textAlign = 'right'
  ctx.fillText('Claudock', CARD_W - PAD, footerBase + 2)
  ctx.textAlign = 'left'
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
