import { useId, type ReactNode, type SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cx } from '@/lib/cx'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> {
  label?: ReactNode
  hint?: ReactNode
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
}

/** Native <select> with our styling (keeps OS keyboard + a11y behaviour). */
export function Select({ label, hint, options, value, onChange, className, ...rest }: SelectProps): JSX.Element {
  const id = useId()
  return (
    <div className={cx('field', className)}>
      {label ? (
        <label htmlFor={id} className="field__label">
          {label}
        </label>
      ) : null}
      <div className="field__wrap">
        <select
          id={id}
          className="field__control field__control--select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown className="field__chevron" size={16} strokeWidth={1.8} aria-hidden />
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="field__hint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
