import { cx } from '@/lib/cx'

/** Loading indicator. Screenshot mode waits until no `.spinner` is on screen. */
export function Spinner({ size = 16, label = 'Loading', className }: { size?: number; label?: string; className?: string }): JSX.Element {
  return (
    <span
      className={cx('spinner', className)}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    />
  )
}
