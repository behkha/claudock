/**
 * Tiny app-level signal: "something was written, the sidebar counts and the title-bar size may be stale".
 * The toast provider fires it on every success toast; the Sidebar reloads its counts, the TitleBar re-measures.
 */
type Listener = () => void
const listeners = new Set<Listener>()
let timer: ReturnType<typeof setTimeout> | undefined

/** Asks the sidebar to recount and the title bar to re-measure (debounced, so a burst of writes does it once). */
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
