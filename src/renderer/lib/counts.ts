/**
 * Tiny app-level signal: "something was written, the sidebar counts may be stale".
 * The toast provider fires it on every success toast; the Sidebar listens and reloads its counts.
 */
type Listener = () => void
const listeners = new Set<Listener>()
let timer: ReturnType<typeof setTimeout> | undefined

/** Asks the sidebar to recount (debounced, so a burst of writes recounts once). */
export function refreshCounts(): void {
  clearTimeout(timer)
  timer = setTimeout(() => listeners.forEach((l) => l()), 250)
}

export function onRefreshCounts(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
