import { useMemo, useState } from 'react'
import { Info, Puzzle, Store } from 'lucide-react'
import type { MarketplaceInfo, PluginInfo } from '@shared/api/plugins'
import { formatDate, tildify } from '@shared/format'
import { Badge, Button, Chip, DetailPane, EmptyState, ListDetailLayout, ListGroup, ListPane, ListRow, Spinner, Toggle } from '@/components'
import { api, useApi } from '@/lib/api'
import { useHome, useSelectId } from '@/lib/hooks'
import { useNav, type ScreenProps } from '@/lib/nav'
import { ChipList, Dot, useNotify } from '../_ext/ui'

type Filter = 'all' | 'on' | 'off' | 'market'

const marketId = (name: string): string => `market:${name}`

function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function contributes(p: PluginInfo): string {
  const c = p.contents
  if (!c) return ''
  const bits: string[] = []
  if (c.skills.length) bits.push(pluralize(c.skills.length, 'skill'))
  if (c.agents.length) bits.push(pluralize(c.agents.length, 'agent'))
  if (c.commands.length) bits.push(pluralize(c.commands.length, 'command'))
  if (c.hooks) bits.push(pluralize(c.hooks, 'hook'))
  return bits.join(', ')
}

export default function PluginsScreen({ selectId }: ScreenProps): JSX.Element {
  const { data, error, loading, reload } = useApi(() => api.plugins.list(), [])
  const [selected, setSelected] = useSelectId(selectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const notify = useNotify()
  const home = useHome()

  const plugins = useMemo(() => data?.plugins ?? [], [data])
  const markets = useMemo(() => data?.marketplaces ?? [], [data])
  const q = query.trim().toLowerCase()
  const vp = useMemo(
    () =>
      plugins.filter((p) => {
        if (filter === 'market') return false
        if (filter === 'on' && !p.enabled) return false
        if (filter === 'off' && p.enabled) return false
        return !q || `${p.name} ${p.marketplace} ${p.description}`.toLowerCase().includes(q)
      }),
    [plugins, filter, q]
  )
  const vm = useMemo(
    () => (filter === 'all' || filter === 'market' ? markets.filter((m) => !q || `${m.name} ${m.sourceText}`.toLowerCase().includes(q)) : []),
    [markets, filter, q]
  )

  const sel = selected
  const currentPlugin = sel ? (plugins.find((p) => p.key === sel) ?? plugins.find((p) => p.name === sel)) : undefined
  const currentMarket = sel?.startsWith('market:') ? markets.find((m) => marketId(m.name) === sel) : sel && !currentPlugin ? markets.find((m) => m.name === sel) : undefined
  const fallbackPlugin = sel === undefined ? vp[0] : undefined
  const fallbackMarket = sel === undefined && !fallbackPlugin ? vm[0] : undefined
  const plugin = currentPlugin ?? fallbackPlugin
  const market = currentMarket ?? fallbackMarket

  async function setEnabled(p: PluginInfo, next: boolean): Promise<void> {
    setBusyKey(p.key)
    try {
      const r = await api.plugins.setEnabled(p.key, next)
      notify.saved(r.snapshotId, 'Saved.', { changed: p.state !== (next ? 'on' : 'off'), message: 'Nothing needed to change.' })
      reload()
    } catch (e) {
      notify.failed(e)
    } finally {
      setBusyKey(null)
    }
  }

  const nOn = plugins.filter((p) => p.enabled).length

  const list = (
    <ListPane
      title="Plugins"
      count={data ? plugins.length : undefined}
      search={{ value: query, onChange: setQuery, placeholder: 'Filter plugins' }}
      filters={
        <>
          <Chip selected={filter === 'all'} onClick={() => setFilter('all')} count={plugins.length}>
            All
          </Chip>
          <Chip selected={filter === 'on'} onClick={() => setFilter('on')} count={nOn}>
            On
          </Chip>
          <Chip selected={filter === 'off'} onClick={() => setFilter('off')} count={plugins.length - nOn}>
            Off
          </Chip>
          <Chip selected={filter === 'market'} onClick={() => setFilter('market')} count={markets.length}>
            Marketplaces
          </Chip>
        </>
      }
      loading={loading}
      error={data?.settingsError ?? (data ? error : null)}
      isEmpty={!!data && vp.length === 0 && vm.length === 0}
      empty={
        plugins.length === 0 && markets.length === 0 ? (
          <EmptyState icon={<Puzzle />} title="No plugins installed" description="Plugins bundle skills, agents, commands and hooks. Install one with /plugin in Claude Code and it will show up here." />
        ) : (
          <EmptyState title="Nothing matches" description="Try another filter or clear the search." />
        )
      }
      footer={data ? 'Install and remove plugins with /plugin in Claude Code.' : undefined}
    >
      {data
        ? [
            ...(vp.length > 0
              ? [
                  <ListGroup key="g:plugins">Installed plugins · {vp.length}</ListGroup>,
                  ...vp.map((p) => (
                    <ListRow
                      key={p.key}
                      leading={<Dot on={p.enabled} />}
                      title={p.name}
                      subtitle={`${p.marketplace || 'no marketplace'}${p.version ? ` · v${p.version}` : ''}`}
                      meta={contributes(p) || undefined}
                      dimmed={!p.enabled}
                      selected={plugin?.key === p.key && !market}
                      onSelect={() => setSelected(p.key)}
                      trailing={<Toggle aria-label={`Enable ${p.name}`} checked={p.enabled} disabled={busyKey === p.key} onChange={(v) => void setEnabled(p, v)} />}
                    />
                  ))
                ]
              : []),
            ...(vm.length > 0
              ? [
                  <ListGroup key="g:markets">Marketplaces · {vm.length}</ListGroup>,
                  ...vm.map((m) => (
                    <ListRow
                      key={marketId(m.name)}
                      leading={<Store size={16} strokeWidth={1.8} />}
                      title={m.name}
                      subtitle={m.sourceText ? `${m.sourceKind}: ${tildify(m.sourceText, home)}` : m.sourceKind}
                      meta={m.pluginCount !== null ? pluralize(m.pluginCount, 'plugin') : undefined}
                      selected={market?.name === m.name}
                      onSelect={() => setSelected(marketId(m.name))}
                    />
                  ))
                ]
              : [])
          ]
        : undefined}
    </ListPane>
  )

  let detail: JSX.Element
  if (!data && loading) {
    detail = (
      <div className="empty">
        <Spinner />
      </div>
    )
  } else if (!data) {
    detail = (
      <EmptyState
        title="Could not load plugins"
        description={error ?? 'Something went wrong.'}
        action={
          <Button variant="primary" onClick={reload}>
            Try again
          </Button>
        }
      />
    )
  } else if (market) {
    detail = <MarketDetail key={market.name} market={market} plugins={plugins} onOpen={(k) => setSelected(k)} />
  } else if (plugin) {
    detail = <PluginDetail key={plugin.key} plugin={plugin} busy={busyKey === plugin.key} onToggle={(v) => void setEnabled(plugin, v)} onOpenMarket={(n) => setSelected(marketId(n))} />
  } else {
    detail = <EmptyState icon={<Puzzle />} title="Select a plugin" description="Pick a plugin on the left to see what it adds and turn it on or off." />
  }

  return <ListDetailLayout list={list} detail={detail} />
}

/* ------------------------------------------------------------------ plugin */

function PluginDetail({ plugin, busy, onToggle, onOpenMarket }: { plugin: PluginInfo; busy: boolean; onToggle: (v: boolean) => void; onOpenMarket: (name: string) => void }): JSX.Element {
  const { navigate } = useNav()
  const notify = useNotify()
  const c = plugin.contents
  const stats: Array<{ label: string; n: number; screen?: 'skills' | 'agents' | 'commands' | 'hooks' | 'mcp' }> = c
    ? [
        { label: 'Skills', n: c.skills.length, screen: 'skills' },
        { label: 'Agents', n: c.agents.length, screen: 'agents' },
        { label: 'Commands', n: c.commands.length, screen: 'commands' },
        { label: 'Hooks', n: c.hooks },
        { label: 'MCP servers', n: c.mcpServers.length }
      ]
    : []
  return (
    <DetailPane
      title={plugin.name}
      path={plugin.dir || undefined}
      reveal={plugin.rel ?? false}
      badges={
        <>
          {plugin.version ? <Badge>v{plugin.version}</Badge> : null}
          {c?.mod ? <Badge tone="oat">mod</Badge> : null}
          {!plugin.installed ? <Badge tone="oat">{plugin.marketplace === 'builtin' ? 'built in' : 'not installed'}</Badge> : null}
          {plugin.state === 'unset' ? <Badge tone="oat">not in enabledPlugins</Badge> : null}
        </>
      }
      actions={
        plugin.rel || c?.mod ? (
          <>
            {c?.mod ? (
              <Button variant="secondary" onClick={() => navigate('mods', plugin.key)}>
                Open in Mods
              </Button>
            ) : null}
            {plugin.rel ? (
              <Button variant="secondary" onClick={() => void api.system.reveal(plugin.rel as string).catch(notify.failed)}>
                Reveal
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div className="ext-body">
        <div className="ext-toggle-row">
          <Toggle checked={plugin.enabled} disabled={busy} onChange={onToggle} label="Enabled" />
        </div>

        <p className={plugin.description ? 'ext-desc' : 'ext-desc ext-desc--muted'}>{plugin.description || 'This plugin has no description.'}</p>

        {c ? (
          <section aria-label="What this plugin adds" className="ext-form">
            <h2 className="ext-section-title">What it adds</h2>
            <div className="ext-stats">
              {stats.map((s) => (
                <div key={s.label} className="ext-stat">
                  <span className="ext-stat__n">{s.n}</span>
                  <span className="ext-stat__label">{s.label}</span>
                  {s.screen && s.n > 0 ? (
                    <button type="button" className="ext-link ext-hint" onClick={() => navigate(s.screen as 'skills' | 'agents' | 'commands')}>
                      View in {s.label}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {c.skills.length > 0 ? <NameBlock title="Skills" items={c.skills} /> : null}
            {c.commands.length > 0 ? <NameBlock title="Commands" items={c.commands.map((x) => `/${plugin.name}:${x}`)} /> : null}
            {c.agents.length > 0 ? <NameBlock title="Agents" items={c.agents} /> : null}
            {c.hookEvents.length > 0 ? <NameBlock title="Hook events" items={c.hookEvents} /> : null}
            {c.mcpServers.length > 0 ? <NameBlock title="MCP servers" items={c.mcpServers} /> : null}
          </section>
        ) : plugin.installed ? (
          <div className="ext-note">
            <Info size={16} strokeWidth={1.8} aria-hidden />
            <span>The plugin folder is missing from the cache, so its contents cannot be listed. Reinstall it with /plugin in Claude Code.</span>
          </div>
        ) : null}

        <section aria-label="Details" className="ext-form">
          <h2 className="ext-section-title">Details</h2>
          <dl className="ext-deflist">
            <dt>Key</dt>
            <dd className="mono">{plugin.key}</dd>
            <dt>Marketplace</dt>
            <dd>
              {plugin.marketplace ? (
                <button type="button" className="ext-link" onClick={() => onOpenMarket(plugin.marketplace)}>
                  {plugin.marketplace}
                </button>
              ) : (
                '—'
              )}
            </dd>
            {plugin.version ? (
              <>
                <dt>Version</dt>
                <dd>{plugin.version}</dd>
              </>
            ) : null}
            <dt>Scope</dt>
            <dd>{plugin.scope}</dd>
            {plugin.installedAt ? (
              <>
                <dt>Installed</dt>
                <dd>{formatDate(plugin.installedAt)}</dd>
              </>
            ) : null}
            {plugin.lastUpdated ? (
              <>
                <dt>Updated</dt>
                <dd>{formatDate(plugin.lastUpdated)}</dd>
              </>
            ) : null}
            {plugin.gitCommitSha ? (
              <>
                <dt>Commit</dt>
                <dd className="mono">{plugin.gitCommitSha.slice(0, 10)}</dd>
              </>
            ) : null}
            {plugin.author ? (
              <>
                <dt>Author</dt>
                <dd>{plugin.author}</dd>
              </>
            ) : null}
            {plugin.homepage ? (
              <>
                <dt>Homepage</dt>
                <dd className="mono">{plugin.homepage}</dd>
              </>
            ) : null}
            {plugin.license ? (
              <>
                <dt>License</dt>
                <dd>{plugin.license}</dd>
              </>
            ) : null}
          </dl>
        </section>

        <div className="ext-note">
          <Info size={16} strokeWidth={1.8} aria-hidden />
          <span>Install and remove plugins with /plugin in Claude Code. Here you can only turn them on or off.</span>
        </div>
        <p className="ext-foot">Turning a plugin on or off writes enabledPlugins in settings.json. A snapshot is kept in Backups.</p>
      </div>
    </DetailPane>
  )
}

function NameBlock({ title, items }: { title: string; items: string[] }): JSX.Element {
  const shown = items.slice(0, 40)
  return (
    <div className="ext-field">
      <span className="ext-label">{title}</span>
      <ChipList items={shown} />
      {items.length > shown.length ? <span className="ext-hint">and {items.length - shown.length} more</span> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ marketplace */

function MarketDetail({ market, plugins, onOpen }: { market: MarketplaceInfo; plugins: PluginInfo[]; onOpen: (key: string) => void }): JSX.Element {
  const home = useHome()
  const installed = plugins.filter((p) => market.installed.includes(p.key))
  return (
    <DetailPane
      title={market.name}
      path={market.installLocation || undefined}
      reveal={false}
      badges={<Badge tone="oat">marketplace</Badge>}
    >
      <div className="ext-body">
        <dl className="ext-deflist">
          <dt>Source</dt>
          <dd>
            {market.sourceKind}
            {market.sourceText ? <span className="mono"> · {tildify(market.sourceText, home)}</span> : null}
          </dd>
          <dt>Last updated</dt>
          <dd>{market.lastUpdated ? formatDate(market.lastUpdated) : '—'}</dd>
          <dt>Plugins listed</dt>
          <dd>{market.pluginCount ?? 'Unknown (its catalog could not be read)'}</dd>
          <dt>Known to Claude Code</dt>
          <dd>{market.known ? 'Yes (plugins/known_marketplaces.json)' : 'No'}</dd>
          <dt>Declared in settings</dt>
          <dd>{market.inSettings ? 'Yes (extraKnownMarketplaces)' : 'No'}</dd>
        </dl>
        <section aria-label="Installed from this marketplace" className="ext-form">
          <h2 className="ext-section-title">Installed from here</h2>
          {installed.length === 0 ? (
            <p className="ext-hint">No installed plugins come from this marketplace.</p>
          ) : (
            <div className="ext-chiplist">
              {installed.map((p) => (
                <Button key={p.key} variant="secondary" onClick={() => onOpen(p.key)}>
                  {p.name}
                </Button>
              ))}
            </div>
          )}
        </section>
        <div className="ext-note">
          <Info size={16} strokeWidth={1.8} aria-hidden />
          <span>Add and remove marketplaces with /plugin in Claude Code. This list is read-only.</span>
        </div>
      </div>
    </DetailPane>
  )
}
