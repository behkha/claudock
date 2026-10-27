import { useMemo, useState } from 'react'
import { Settings as SettingsIcon, Share2 } from 'lucide-react'
import type { ScreenId } from '@shared/nav'
import { formatBytes, formatCount, tildify } from '@shared/format'
import { Button, Card, Spinner, SizeBar, type SizeSegment } from '@/components'
import { api, useApi } from '@/lib/api'
import { cx } from '@/lib/cx'
import { useNav, type ScreenProps } from '@/lib/nav'
import { useFolder } from '../Storage/useFolder'
import { FindingsList } from './Findings'
import { ClaudeCodeCard } from './ClaudeCodeCard'
import { ShareDialog } from './ShareDialog'
import { useFindings } from './useFindings'

/** "~/.claude" for the usual folder; a shortened form for long custom paths. */
function dirLabel(dir: string, home: string, sep: string): string {
  const t = tildify(dir, home)
  if (t.length <= 28) return t
  const parts = t.split(sep).filter(Boolean)
  return '…' + sep + parts.slice(-2).join(sep)
}

interface Tile {
  screen: ScreenId
  label: string
  value: number | undefined
  sub: string
}

export default function OverviewScreen(_props: ScreenProps): JSX.Element {
  const { navigate } = useNav()
  const info = useApi(() => api.system.configInfo(), [])
  const summary = useApi(() => api.overview.summary(), [])
  const folder = useFolder('')
  const found = useFindings()
  const wrapped = useApi(() => api.overview.wrapped(), [])
  const [sharing, setSharing] = useState(false)

  const known = useMemo(() => folder.entries.filter((e) => e.bytes !== null && !e.locked), [folder.entries])
  const total = known.reduce((n, e) => n + (e.bytes ?? 0), 0)
  const flagged = found.findings.reduce((n, f) => n + (f.bytes ?? 0), 0)

  const segments = useMemo<SizeSegment[]>(() => {
    const sorted = [...known].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    const head = sorted.slice(0, 7).map((e) => ({ key: e.rel, label: e.isDir ? `${e.name}/` : e.name, bytes: e.bytes ?? 0 }))
    const rest = sorted.slice(7)
    if (rest.length > 0) head.push({ key: '\0other', label: `${rest.length} other items`, bytes: rest.reduce((n, e) => n + (e.bytes ?? 0), 0) })
    return head
  }, [known])

  const label = info.data ? dirLabel(info.data.configDir, info.data.home, info.data.sep) : '~/.claude'
  const c = summary.data?.counts
  const tiles: Tile[] = [
    {
      screen: 'skills',
      label: 'Skills',
      // "your skills", the same number as the sidebar badge; plugin skills are named in the sub line
      value: c?.skills,
      sub: c ? [c.skills === 0 ? 'none yet' : 'yours', c.pluginSkills ? `${c.pluginSkills} in plugins` : ''].filter(Boolean).join(' · ') : ''
    },
    { screen: 'hooks', label: 'Hooks', value: c?.hooks, sub: c ? `across ${c.hookEvents} ${c.hookEvents === 1 ? 'event' : 'events'}` : '' },
    { screen: 'plugins', label: 'Plugins', value: c?.plugins, sub: c ? `${c.pluginsEnabled} enabled` : '' },
    { screen: 'rules', label: 'Rules', value: c?.rules, sub: 'CLAUDE.md and rules/' },
    { screen: 'projects', label: 'Projects', value: c?.projects, sub: 'with saved sessions' },
    { screen: 'history', label: 'Prompts', value: c?.prompts, sub: 'in history' }
  ]
  const g = summary.data?.glance

  const reloadAll = (): void => {
    folder.reload()
    found.rescan()
  }

  return (
    <div className="page">
      <div className="page__inner ov">
        <ClaudeCodeCard />

        <header className="ov__head">
          <div className="ov__headrow">
            <h1 className="ov__headline">
              <span className="ov__total">{folder.loading ? '…' : formatBytes(total)}</span> in <span className="ov__dir">{label}</span>
              {folder.scanning ? <Spinner size={16} label="Measuring" className="ov__spin" /> : null}
            </h1>
            <Button icon={<Share2 size={16} strokeWidth={1.8} />} onClick={() => setSharing(true)} disabled={wrapped.loading && !wrapped.data}>
              Share stats
            </Button>
          </div>
          <p className="ov__sub" aria-live="polite">
            {found.scanning && found.findings.length === 0
              ? 'Checking for things worth a look…'
              : flagged > 0
                ? `${formatBytes(flagged)} of it is flagged below${found.scanning ? ' so far' : ''}`
                : found.findings.length > 0
                  ? 'Nothing big is flagged, but a few things are worth a look below.'
                  : 'Nothing is flagged. The folder looks tidy.'}
          </p>
        </header>

        <section className="ov__bar" aria-label="Storage by top-level item">
          {folder.error ? (
            <p className="find__error" role="alert">
              {folder.error}
            </p>
          ) : segments.length > 0 ? (
            <SizeBar segments={segments} total={total} height={14} onSelect={(key) => navigate('storage', key === '\0other' ? undefined : key)} />
          ) : (
            <div className="ov__barplaceholder" aria-hidden />
          )}
        </section>

        <div className="ov__grid">
          <Card title="Worth a look" description="Found by looking at your real files. Nothing changes until you press a button." className="ov__find">
            <FindingsList findings={found.findings} scanning={found.scanning} error={found.error} onChanged={reloadAll} />
          </Card>

          <div className="ov__side">
            <Card title="What you have">
              <ul role="list" className="ov__tiles">
                {tiles.map((t) => (
                  <li key={t.screen}>
                    <button type="button" className="ov__tile" onClick={() => navigate(t.screen)} aria-label={`${t.label}: ${t.value === undefined ? 'loading' : formatCount(t.value)}. Open ${t.label}`}>
                      <span className="ov__tilevalue">{t.value === undefined ? '–' : formatCount(t.value)}</span>
                      <span className="ov__tilelabel">{t.label}</span>
                      <span className="ov__tilesub">{t.sub || ' '}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            <Card
              title="Settings at a glance"
              actions={
                <Button variant="ghost" icon={<SettingsIcon size={16} strokeWidth={1.8} />} onClick={() => navigate('settings')}>
                  Open settings
                </Button>
              }
            >
              <dl className="ov__glance">
                <GlanceRow term="Model" value={g?.model} loading={summary.loading && !g} />
                <GlanceRow term="Effort" value={g?.effort} loading={summary.loading && !g} />
                <GlanceRow term="Terminal theme" value={g?.theme} loading={summary.loading && !g} />
                <GlanceRow term="Status line" value={g?.statusLine} mono loading={summary.loading && !g} />
              </dl>
              {summary.error ? (
                <p className="find__error" role="alert">
                  {summary.error}
                </p>
              ) : null}
            </Card>
          </div>
        </div>
      </div>
      <ShareDialog open={sharing} stats={wrapped.data} onClose={() => setSharing(false)} />
    </div>
  )
}

function GlanceRow({ term, value, mono, loading }: { term: string; value: string | null | undefined; mono?: boolean; loading?: boolean }): JSX.Element {
  return (
    <div className="ov__glancerow">
      <dt>{term}</dt>
      <dd className={cx(mono && 'ov__mono', !value && 'ov__unset')} title={value ?? undefined}>
        {value ?? (loading ? '…' : 'Not set')}
      </dd>
    </div>
  )
}
