import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { DiskCost } from '@shared/api/storage'
import { formatBytes, formatCount, tildify } from '@shared/format'
import { Card } from '@/components'
import { cx } from '@/lib/cx'

interface LedgerProps {
  cost: DiskCost | undefined
  home: string
  /** Finder, Explorer or "file manager". */
  fm: string
}

const pct = (bytes: number, scale: number): string => `${scale > 0 ? (bytes / scale) * 100 : 0}%`

/**
 * Claude Code's folder and Claudock's own folder on one scale. Claudock's bar is its real disk (clay) and, hatched, the
 * Claude Code files its archive links to, which take no extra space; the file manager's sum is shown struck through.
 */
export function DiskLedger({ cost, home, fm }: LedgerProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const breakdownId = useId()
  const d = cost?.data
  const scale = cost ? Math.max(cost.config.bytes, d ? d.real + d.linked : 0, 1) : 1
  const tiles = d
    ? [
        { label: 'Search text', bytes: d.searchText },
        { label: `${formatCount(d.keptSessions)} ${d.keptSessions === 1 ? 'session' : 'sessions'} only Claudock keeps`, bytes: d.keptBytes },
        ...(d.app !== null ? [{ label: 'The app (npx copy)', bytes: d.app }] : []),
        { label: 'Snapshots', bytes: d.snapshots },
        { label: 'Caches and settings', bytes: d.other }
      ]
    : []

  return (
    <Card flush className="ledger">
      <div className="ledger__body">
        <div className="ledger__row">
          <div className="ledger__name">
            Claude Code<small>{cost ? tildify(cost.config.path, home) : '~/.claude'}</small>
          </div>
          <div className="ledger__bar" aria-hidden>
            {cost ? <span className="ledger__seg ledger__seg--cc" style={{ width: pct(cost.config.bytes, scale) }} /> : null}
          </div>
          <div className="ledger__size">{cost ? formatBytes(cost.config.bytes) : <span className="stor__muted">…</span>}</div>
          <span />
        </div>
        <div className="ledger__row">
          <div className="ledger__name">
            Claudock<small>App data</small>
          </div>
          <div className="ledger__bar" aria-hidden>
            {d ? (
              <>
                <span className="ledger__seg ledger__seg--real" style={{ width: pct(d.real, scale) }} />
                <span className="ledger__seg ledger__seg--link" style={{ width: pct(d.linked, scale) }} />
              </>
            ) : null}
          </div>
          <div className="ledger__size">
            {d ? formatBytes(d.real) : <span className="stor__muted">…</span>}
            {d && d.naive > d.real ? (
              <small className="ledger__finder">
                {fm[0].toUpperCase() + fm.slice(1)}: <s>{formatBytes(d.naive)}</s>
                <span className="sr-only">, counting linked files again</span>
              </small>
            ) : null}
          </div>
          <button
            type="button"
            className={cx('ledger__more', open && 'ledger__more--open')}
            aria-expanded={open}
            aria-controls={breakdownId}
            aria-label={d ? `Show what Claudock's ${formatBytes(d.real)} holds` : "Show what Claudock's folder holds"}
            disabled={!d}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown size={16} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
        {open && d ? (
          <ul className="ledger__break" id={breakdownId}>
            {tiles.map((t) => (
              <li key={t.label} className="ledger__tile">
                <b>{formatBytes(t.bytes)}</b>
                <span>{t.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="ledger__legend">
          <span>
            <i className="ledger__sw ledger__seg--cc" />
            Claude Code
          </span>
          <span>
            <i className="ledger__sw ledger__seg--real" />
            Claudock, on disk
          </span>
          {d && d.linked > 0 ? (
            <span>
              <i className="ledger__sw ledger__seg--link" />
              Linked to Claude Code&apos;s files, no extra space
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  )
}
