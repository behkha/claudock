import type { ConnectStatus } from '@shared/api/connect'

/**
 * Who sees the first-run reveal (checklist item 9, decision 3 A): anyone who hasn't left it yet and has neither Connect
 * part on, once. Screenshot mode never shows it on its own, so the other shots see the usual window; CLAUDOCK_REVEAL=1
 * shows it always (and the flag is then not written). No Electron here, so `npm test` can load it.
 */
export function shouldReveal(o: { revealed: boolean; connect: ConnectStatus; forced: boolean; shot: boolean }): boolean {
  if (o.forced) return true
  if (o.shot || o.revealed) return false
  return o.connect.statusLine !== 'on' && o.connect.hooks !== 'on'
}
