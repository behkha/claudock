import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cx } from '@/lib/cx'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  'aria-label': string
  className?: string
}

/** Radio-group style segmented control (e.g. Form · JSON · History). Arrow keys move the selection. */
export function Segmented<T extends string>({ options, value, onChange, className, ...rest }: SegmentedProps<T>): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  function onKeyDown(e: KeyboardEvent): void {
    const enabled = options.filter((o) => !o.disabled)
    const i = enabled.findIndex((o) => o.value === value)
    let next = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % enabled.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + enabled.length) % enabled.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = enabled.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(enabled[next].value)
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
  }

  return (
    <div ref={ref} role="radiogroup" aria-label={rest['aria-label']} className={cx('segmented', className)} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={o.disabled}
          className={cx('segmented__item', o.value === value && 'segmented__item--active')}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  )
}
