/** Small formatting helpers usable in main and renderer. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let v = bytes
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en').format(n)
}

export function formatDate(ms: number | string | Date): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatDateTime(ms: number | string | Date): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function formatRelative(ms: number | string | Date, now = Date.now()): string {
  const t = new Date(ms).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} d ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo} mo ago`
  return `${Math.round(mo / 12)} y ago`
}

/** Replace the home directory prefix with "~". */
export function tildify(p: string, home: string): string {
  if (home && (p === home || p.startsWith(home + '/') || p.startsWith(home + '\\'))) return '~' + p.slice(home.length)
  return p
}
