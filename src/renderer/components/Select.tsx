import { useId, type ReactNode, type SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { cx } from '@/lib/cx'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
  /** Options with the same group are listed under that heading, in the order the groups first appear. */
  group?: string
}

function renderOptions(options: SelectOption[]): JSX.Element[] {
  const option = (o: SelectOption): JSX.Element => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  )
  const seen = new Set<string>()
  return options.flatMap((o) => {
    if (!o.group) return [option(o)]
    if (seen.has(o.group)) return []
    seen.add(o.group)
    return [
      <optgroup key={`group:${o.group}`} label={o.group}>
        {options.filter((x) => x.group === o.group).map(option)}
      </optgroup>
    ]
  })
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
          {renderOptions(options)}
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
