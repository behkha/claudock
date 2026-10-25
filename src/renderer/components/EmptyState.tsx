import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'

export interface EmptyStateProps {
  title: string
  description?: ReactNode
  /** A lucide icon element, drawn in a soft oat circle. */
  icon?: ReactNode
  /** Button(s). */
  action?: ReactNode
  className?: string
}

export function EmptyState({ title, description, icon, action, className }: EmptyStateProps): JSX.Element {
  return (
    <div className={cx('empty', className)}>
      {icon ? <div className="empty__icon">{icon}</div> : null}
      <h2 className="empty__title">{title}</h2>
      {description ? <p className="empty__description">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  )
}
