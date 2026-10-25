import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'

export interface ChipProps {
  children: ReactNode
  /** Makes the chip a toggle button (filter chip). Without it the chip is a static label. */
  onClick?: () => void
  selected?: boolean
  count?: number | string
  disabled?: boolean
  className?: string
}

export function Chip({ children, onClick, selected, count, disabled, className }: ChipProps): JSX.Element {
  const inner = (
    <>
      {children}
      {count !== undefined ? <span className="chip__count">{count}</span> : null}
    </>
  )
  if (!onClick) return <span className={cx('chip', className)}>{inner}</span>
  return (
    <button
      type="button"
      aria-pressed={!!selected}
      disabled={disabled}
      className={cx('chip', 'chip--button', selected && 'chip--selected', className)}
      onClick={onClick}
    >
      {inner}
    </button>
  )
}
