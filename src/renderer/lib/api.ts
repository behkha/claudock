import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import { DOMAINS, type ClaudockApi, type ClaudockBridge, type ClaudockEvents } from '@shared/ipc'

declare global {
  interface Window {
    /** Generic bridge from the preload script. Use the typed `api` below instead. */
    claudock: ClaudockBridge
  }
}

/** Strip Electron's "Error invoking remote method 'x': Error: " wrapper so messages are user-readable. */
function clean(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  return new Error(msg.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ''))
}

function domainFacade(domain: string): unknown {
  return new Proxy(
    {},
    {
      get(_t, method) {
        // `then` must stay undefined or `await api.x` would treat the facade as a thenable.
        if (typeof method !== 'string' || method === 'then') return undefined
        return (...args: unknown[]) => window.claudock.invoke(`${domain}:${method}`, ...args).catch((e) => Promise.reject(clean(e)))
      }
    }
  )
}

/**
 * Typed facade: `api.<domain>.<method>(...args)` calls `ipcRenderer.invoke('<domain>:<method>', ...args)`.
 * Types come from `src/shared/api/<domain>.ts`; nothing here needs editing when a method is added.
 */
export const api = Object.fromEntries(DOMAINS.map((d) => [d, domainFacade(d)])) as unknown as ClaudockApi

/** Subscribe to a main->renderer event. Returns the unsubscribe function. */
export function onEvent<K extends keyof ClaudockEvents>(name: K, cb: (payload: ClaudockEvents[K]) => void): () => void {
  return window.claudock.on(name as string, (p) => cb(p as ClaudockEvents[K]))
}

/** Subscribe for the lifetime of the component. `cb` may change every render. */
export function useEvent<K extends keyof ClaudockEvents>(name: K, cb: (payload: ClaudockEvents[K]) => void): void {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => onEvent(name, (p) => ref.current(p)), [name])
}

export const isMac = (): boolean => window.claudock?.platform === 'darwin'

export interface ApiState<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  /** Refetch. Keeps the previous `data` visible while loading. */
  reload: () => void
}

/**
 * Fetch on mount and whenever `deps` change. Out-of-order responses are dropped.
 *   const { data, error, loading, reload } = useApi(() => api.skills.list(), [])
 */
export function useApi<T>(fn: () => Promise<T>, deps: DependencyList = []): ApiState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({
    data: undefined,
    error: null,
    loading: true
  })
  const fnRef = useRef(fn)
  fnRef.current = fn
  const seq = useRef(0)
  const alive = useRef(true)

  const run = useCallback(() => {
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null }))
    fnRef.current().then(
      (data) => {
        if (alive.current && id === seq.current) setState({ data, error: null, loading: false })
      },
      (e: unknown) => {
        if (alive.current && id === seq.current)
          setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false }))
      }
    )
  }, [])

  useEffect(() => {
    alive.current = true
    run()
    return () => {
      alive.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { ...state, reload: run }
}
