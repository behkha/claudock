import { Folder } from 'lucide-react'
import { api, isMac } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useToast } from './Toast'

export interface PathLabelProps {
  /** Path to display (absolute or config-relative). */
  path: string
  /** Path to reveal on click, if different. `false` = plain text, not clickable. */
  reveal?: string | false
  className?: string
}

/** Split into a shrinking head and a fixed tail so the END of the path (file name) always stays visible. */
function split(p: string): [string, string] {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i <= 0) return ['', p]
  const j = Math.max(p.lastIndexOf('/', i - 1), p.lastIndexOf('\\', i - 1))
  const cut = j > 0 ? j : i
  return [p.slice(0, cut), p.slice(cut)]
}

const fm = (): string => (isMac() ? 'Finder' : window.claudock.platform === 'win32' ? 'Explorer' : 'file manager')

/** Mono path with middle truncation. Click = reveal in Finder / Explorer. */
export function PathLabel({ path, reveal, className }: PathLabelProps): JSX.Element {
  const toast = useToast()
  const [head, tail] = split(path)
  const text = (
    <span className="path__text">
      <span className="path__head">{head}</span>
      <span className="path__tail">{tail}</span>
    </span>
  )
  if (reveal === false) {
    return (
      <span className={cx('path', className)} title={path}>
        {text}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={cx('path', 'path--link', className)}
      title={`${path}\nReveal in ${fm()}`}
      aria-label={`Reveal ${path} in ${fm()}`}
      onClick={() => api.system.reveal(reveal ?? path).catch((e: Error) => toast(e.message, { kind: 'error' }))}
    >
      <Folder size={13} strokeWidth={1.8} aria-hidden className="path__icon" />
      {text}
    </button>
  )
}
