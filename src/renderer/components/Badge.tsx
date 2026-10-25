import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'

export interface BadgeProps {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'oat'
  className?: string
}

export function Badge({ children, tone = 'neutral', className }: BadgeProps): JSX.Element {
  return <span className={cx('badge', `badge--${tone}`, className)}>{children}</span>
}
