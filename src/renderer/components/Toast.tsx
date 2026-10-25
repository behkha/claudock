import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, Info, X } from 'lucide-react'
import { refreshCounts } from '@/lib/counts'
import { cx } from '@/lib/cx'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastOptions {
  kind?: ToastKind
  /** ms; default 4000 (8000 for errors). 0 = stay until dismissed. */
  duration?: number
  action?: { label: string; onClick: () => void }
}

interface ToastItem extends ToastOptions {
  id: number
  message: string
}

type ToastFn = (message: string, opts?: ToastOptions) => void
const Ctx = createContext<ToastFn>(() => undefined)

/** `const toast = useToast(); toast('Saved', { kind: 'success' })`. Safe outside a provider (no-op). */
export const useToast = (): ToastFn => useContext(Ctx)

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), [])
  const toast = useCallback<ToastFn>(
    (message, opts = {}) => {
      const id = ++seq.current
      if (opts.kind === 'success') refreshCounts() // a write happened: sidebar counts may have changed
      setItems((l) => [...l.slice(-3), { id, message, ...opts }])
      const ms = opts.duration ?? (opts.kind === 'error' ? 8000 : 4000)
      if (ms > 0) setTimeout(() => dismiss(id), ms)
    },
    [dismiss]
  )
  const value = useMemo(() => toast, [toast])

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('toast', `toast--${t.kind ?? 'info'}`)} role={t.kind === 'error' ? 'alert' : 'status'}>
            <span className="toast__icon" aria-hidden>
              {t.kind === 'success' ? <Check size={16} strokeWidth={1.8} /> : t.kind === 'error' ? <AlertTriangle size={16} strokeWidth={1.8} /> : <Info size={16} strokeWidth={1.8} />}
            </span>
            <span className="toast__message">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action?.onClick()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={14} strokeWidth={1.8} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
