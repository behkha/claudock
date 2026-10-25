import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cx } from '@/lib/cx'

interface Common {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  mono?: boolean
  /** Extra element rendered inside the field on the right (e.g. a unit). */
  suffix?: ReactNode
}

export type TextFieldProps = Common &
  (
    | ({ multiline?: false } & Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>)
    | ({ multiline: true; rows?: number } & TextareaHTMLAttributes<HTMLTextAreaElement>)
  )

/** Labelled text input / textarea. Always pass `label` (or `aria-label`). */
export const TextField = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps>(function TextField(props, ref) {
  const id = useId()
  const { label, hint, error, mono, suffix, multiline, className, ...rest } = props as Common & {
    multiline?: boolean
    className?: string
  } & Record<string, unknown>
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined
  const common = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    className: cx('field__control', mono && 'field__control--mono', !!error && 'field__control--error')
  }
  return (
    <div className={cx('field', className)}>
      {label ? (
        <label htmlFor={id} className="field__label">
          {label}
        </label>
      ) : null}
      <div className="field__wrap">
        {multiline ? (
          <textarea ref={ref as React.Ref<HTMLTextAreaElement>} {...common} {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} />
        ) : (
          <input ref={ref as React.Ref<HTMLInputElement>} {...common} {...(rest as InputHTMLAttributes<HTMLInputElement>)} />
        )}
        {suffix ? <span className="field__suffix">{suffix}</span> : null}
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="field__hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-err`} className="field__error">
          {error}
        </p>
      ) : null}
    </div>
  )
})
