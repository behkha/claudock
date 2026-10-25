import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'
import { PathLabel } from './PathLabel'

export interface DetailPaneProps {
  /** Serif 28px title. */
  title: ReactNode
  /** Mono path line (middle-truncated; click reveals). Absolute or config-relative. */
  path?: string
  /** Path passed to Reveal if different from `path`. Pass `false` to make the path non-clickable (e.g. plugin cache). */
  reveal?: string | false
  /** Badges next to the title. */
  badges?: ReactNode
  /** Row of Buttons under the path. */
  actions?: ReactNode
  children?: ReactNode
  /** Remove the body padding (for full-bleed editors). */
  flush?: boolean
  className?: string
}

export function DetailPane({ title, path, reveal, badges, actions, children, flush, className }: DetailPaneProps): JSX.Element {
  return (
    <article className={cx('detail-pane', className)}>
      <header className="detail-pane__header">
        <div className="detail-pane__titlerow">
          <h1 className="detail-pane__title">{title}</h1>
          {badges ? <div className="detail-pane__badges">{badges}</div> : null}
        </div>
        {path ? <PathLabel path={path} reveal={reveal} /> : null}
        {actions ? <div className="detail-pane__actions">{actions}</div> : null}
      </header>
      <div className={cx('detail-pane__body', flush && 'detail-pane__body--flush')}>{children}</div>
    </article>
  )
}
