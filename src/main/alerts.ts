import { Notification } from 'electron'

/**
 * Posting a native alert: the "needs me" alerts (src/main/domains/sessions.ts) and the limit alerts
 * (src/main/menubar.ts). Native notifications follow Focus / Do Not Disturb by themselves. In screenshot mode nothing
 * is shown: titles are kept for src/main/shot.ts to check and printed as `ALERT <title> | <body>`.
 */

const SHOT = process.env.CLAUDOCK_SHOT === '1'
const shotAlerts: string[] = []
/** Notifications stay referenced until closed, or Electron may collect them before a click arrives. */
const shown = new Set<Notification>()

export function postAlert(text: { title: string; body: string }, opts: { sound: boolean; onClick: () => void }): void {
  if (SHOT) {
    shotAlerts.push(text.title)
    console.log(`ALERT ${text.title} | ${text.body}`)
    return
  }
  if (!Notification.isSupported()) return
  const n = new Notification({ title: text.title, body: text.body, silent: !opts.sound })
  shown.add(n)
  n.on('click', opts.onClick)
  n.on('close', () => shown.delete(n))
  n.show()
}

/** Alert titles posted so far in screenshot mode. */
export const postedAlerts = (): string[] => [...shotAlerts]
