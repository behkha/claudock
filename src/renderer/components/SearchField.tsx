import { forwardRef, type KeyboardEvent, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { cx } from '@/lib/cx'

export interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  'aria-label'?: string
  autoFocus?: boolean
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void
  /** Trailing hint, e.g. <Kbd>⌘K</Kbd>. Hidden while there is text. */
  hint?: ReactNode
  className?: string
}

export const SearchField = forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { value, onChange, placeholder = 'Search', autoFocus, onKeyDown, hint, className, ...rest },
  ref
) {
  return (
    <div className={cx('search-field', className)}>
      <Search size={15} strokeWidth={1.8} aria-hidden className="search-field__icon" />
      <input
        ref={ref}
        type="text"
        role="searchbox"
        autoComplete="off"
        spellCheck={false}
        className="search-field__input"
        value={value}
        placeholder={placeholder}
        aria-label={rest['aria-label'] ?? placeholder}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            e.stopPropagation()
            onChange('')
          }
          onKeyDown?.(e)
        }}
      />
      {value ? (
        <button type="button" className="search-field__clear" aria-label="Clear search" onClick={() => onChange('')}>
          <X size={14} strokeWidth={1.8} />
        </button>
      ) : (
        hint
      )}
    </div>
  )
})
