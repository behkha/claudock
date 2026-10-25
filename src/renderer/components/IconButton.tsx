import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from '@/lib/cx'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'> {
  /** Required: icon-only buttons need an accessible name. Also used as the tooltip. */
  'aria-label': string
  icon: ReactNode
  variant?: 'ghost' | 'secondary' | 'danger'
  /** sm = 28px visual (hit area still 32px), md = 32px. */
  size?: 'sm' | 'md'
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, variant = 'ghost', size = 'md', className, type = 'button', title, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      title={title ?? rest['aria-label']}
      className={cx('icon-btn', `icon-btn--${variant}`, size === 'sm' && 'icon-btn--sm', className)}
      {...rest}
    >
      {icon}
    </button>
  )
})
