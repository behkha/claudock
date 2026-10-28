import type { HookEntry } from '@shared/api/hooks'
import { Button, DetailPane } from '@/components'

/** The app icon in small: slate tile, ivory tilde, clay cursor (build/icon.svg). Inverts in dark, like primary buttons. */
export function ClaudockMark({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg className="hk-mark" width={size} height={size} viewBox="100 100 824 824" aria-hidden>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="var(--primary-bg)" />
      <path d="M 236 552 C 282 458, 372 452, 442 512 C 512 572, 602 568, 650 474" fill="none" stroke="var(--primary-fg)" strokeWidth="80" strokeLinecap="round" />
      <rect x="716" y="372" width="100" height="284" rx="16" fill="var(--accent)" />
    </svg>
  )
}

/**
 * Claudock's own hooks (Connect to Claude Code), as one read-only entry. They are added and removed together, so the
 * only action is Disconnect, which opens the Disconnect dialog on Today.
 */
export function ClaudockHooks({
  entries,
  filePath,
  fileName,
  onDisconnect
}: {
  entries: HookEntry[]
  filePath: string
  fileName: string
  onDisconnect: () => void
}): JSX.Element {
  return (
    <DetailPane
      title={
        <span className="hk-ours__title">
          <ClaudockMark size={26} />
          Connect to Claude Code
        </span>
      }
      path={filePath}
      reveal={fileName}
      actions={<Button onClick={onDisconnect}>Disconnect…</Button>}
    >
      <dl className="hk-ours">
        {entries.map((e) => (
          <div key={e.id} className="hk-ours__row">
            <dt>{e.event}</dt>
            <dd>{e.matcher ?? 'all'}</dd>
          </div>
        ))}
      </dl>
    </DetailPane>
  )
}
