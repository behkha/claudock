import type { ReactNode } from 'react'
import { cx } from '@/lib/cx'

/**
 * The three-pane pattern: [sidebar] | list pane (300-360px) | detail pane (flex).
 *   <ListDetailLayout list={<ListPane .../>} detail={<DetailPane .../> or <EmptyState .../>} />
 */
export function ListDetailLayout({ list, detail, className }: { list: ReactNode; detail: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={cx('ldl', className)}>
      <div className="ldl__list">{list}</div>
      <div className="ldl__detail">{detail}</div>
    </div>
  )
}

export interface PageLayoutProps {
  /** Serif 28px page title. */
  title: string
  description?: ReactNode
  actions?: ReactNode
  /** Tabs / Segmented under the header. */
  toolbar?: ReactNode
  children: ReactNode
  className?: string
}

/** Full-width screen frame (Overview, Settings, Storage): scrolling page with a header. */
export function PageLayout({ title, description, actions, toolbar, children, className }: PageLayoutProps): JSX.Element {
  return (
    <div className={cx('page', className)}>
      <div className="page__inner">
        <header className="page__header">
          <div className="page__headtext">
            <h1 className="page__title">{title}</h1>
            {description ? <p className="page__description">{description}</p> : null}
          </div>
          {actions ? <div className="page__actions">{actions}</div> : null}
        </header>
        {toolbar ? <div className="page__toolbar">{toolbar}</div> : null}
        {children}
      </div>
    </div>
  )
}

export interface CardProps {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  /** Remove inner padding (tables, lists). */
  flush?: boolean
  className?: string
}

/** 12px-radius surface with a 0.5px border. */
export function Card({ title, description, actions, children, flush, className }: CardProps): JSX.Element {
  return (
    <section className={cx('card', className)}>
      {title || actions ? (
        <header className="card__header">
          <div>
            {title ? <h2 className="card__title">{title}</h2> : null}
            {description ? <p className="card__description">{description}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('card__body', flush && 'card__body--flush')}>{children}</div>
    </section>
  )
}
