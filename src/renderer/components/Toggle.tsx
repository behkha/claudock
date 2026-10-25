import { useId, type ReactNode } from 'react'
import { cx } from '@/lib/cx'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Visible label (to the right). If omitted, pass `aria-label`. */
  label?: ReactNode
  'aria-label'?: string
  disabled?: boolean
  className?: string
}

/** Switch. Clay track when on. */
export function Toggle({ checked, onChange, label, disabled, className, ...rest }: ToggleProps): JSX.Element {
  const id = useId()
  return (
    <span className={cx('toggle-wrap', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={rest['aria-label']}
        disabled={disabled}
        className={cx('toggle', checked && 'toggle--on')}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle__knob" />
      </button>
      {label ? (
        <label htmlFor={id} className="toggle__label">
          {label}
        </label>
      ) : null}
    </span>
  )
}
