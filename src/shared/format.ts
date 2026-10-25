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

/**
 * Replace the home directory prefix with "~" (display only: never pass the result to the file system).
 * A Windows home (`C:\Users\me`, `\\server\share`) matches case-insensitively and with either separator.
 */
export function tildify(p: string, home: string): string {
  const h = home.replace(/(?<=.)[\\/]+$/, '')
  if (!h || !p) return p
  const win = /^[a-zA-Z]:|^\\\\/.test(h)
  const norm = (s: string): string => (win ? s.replace(/\\/g, '/').toLowerCase() : s)
  // compare the prefix only, so lower-casing can never shift where the rest of the path starts
  if (norm(p.slice(0, h.length)) !== norm(h)) return p
  const rest = p.slice(h.length)
  return rest === '' || rest[0] === '/' || rest[0] === '\\' ? '~' + rest : p
}
