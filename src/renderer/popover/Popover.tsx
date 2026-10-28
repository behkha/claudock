import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, Settings } from 'lucide-react'
import type { MenubarState } from '@shared/api/menubar'
import type { Glance } from '@shared/api/profiles'
import type { AlertPrefs } from '@shared/api/sessions'
import { formatCount } from '@shared/format'
import { LIMITS_STALE_MS, formatTokens, limitsLine } from '@shared/limits'
import { Button } from '@/components/Button'
import { IconButton } from '@/components/IconButton'
import { Kbd } from '@/components/Kbd'
import { useToast } from '@/components/Toast'
import { Toggle } from '@/components/Toggle'
import { LimitMeter, SessionRow } from '@/components/live'
import { api, isMac, useEvent } from '@/lib/api'
import { useThemeSync } from '@/lib/theme'

/**
 * The menu bar popover (src/main/menubar.ts opens it): what needs you first, then both limits, today's tokens, search,
 * and the alert settings behind the gear. Opening it again always starts on the first view with fresh data. With
 * several profiles (item 42, decision 2 A) the sessions are every profile's, each naming its profile, the meters are
 * the profile open in the window, and each other profile is one line that opens it there.
 */

const TICK_MS = 30_000
const PAUSE_MS = 3_600_000
const REMINDERS = [null, 5, 10, 15, 30]
const LIMIT_LINES = [null, 70, 80, 90, 95]

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function Popover(): JSX.Element {
  useThemeSync()
  const [view, setView] = useState<'main' | 'settings'>('main')
  const [glance, setGlance] = useState<Glance>()
  const [prefs, setPrefs] = useState<AlertPrefs>()
  const [bar, setBar] = useState<MenubarState>()
  const [now, setNow] = useState(Date.now())
  const toast = useToast()
  const root = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    setNow(Date.now())
    const fail = (e: Error): void => toast(e.message, { kind: 'error' })
    void api.profiles.glance().then(setGlance, fail)
    void api.sessions.alertPrefs().then(setPrefs, fail)
    void api.menubar.get().then(setBar, fail)
  }, [toast])

  useEffect(load, [load])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [])
  // a new reading moves "just now" and the waiting times along with it
  useEvent('profiles:glance', (v) => {
    setNow(Date.now())
    setGlance(v)
  })
  useEvent('menubar:changed', setBar)
  useEvent('menubar:opened', () => {
    setView('main')
    load()
  })

  // the window takes the height of what it shows
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const fit = (): void => void api.menubar.fit(el.getBoundingClientRect().height).catch(() => undefined)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (view === 'settings') setView('main')
        else void api.menubar.close()
      } else if (e.key.toLowerCase() === 'k' && (isMac() ? e.metaKey : e.ctrlKey)) {
        e.preventDefault()
        void api.menubar.openPalette()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  const change = (patch: Partial<AlertPrefs>): void =>
    void api.sessions.setAlertPrefs(patch).then(setPrefs, (e: Error) => toast(e.message, { kind: 'error' }))
  const changeBar = (patch: { shown?: boolean; openAtLogin?: boolean }): void =>
    void api.menubar.set(patch).then(setBar, (e: Error) => toast(e.message, { kind: 'error' }))

  return (
    <div className="pop" ref={root}>
      {view === 'main' ? (
        <Main glance={glance} prefs={prefs} now={now} onPause={change} onSettings={() => setView('settings')} />
      ) : (
        <SettingsView glance={glance} prefs={prefs} bar={bar} onChange={change} onBar={changeBar} onBack={() => setView('main')} />
      )}
    </div>
  )
}

function Main({
  glance,
  prefs,
  now,
  onPause,
  onSettings
}: {
  glance: Glance | undefined
  prefs: AlertPrefs | undefined
  now: number
  onPause: (patch: Partial<AlertPrefs>) => void
  onSettings: () => void
}): JSX.Element {
  const open = glance?.profiles.find((p) => p.open)
  const others = glance?.profiles.filter((p) => !p.open) ?? []
  const limits = open?.limits
  const limitsOn = limits?.step === 'on'
  const hooksOn = open?.hooks === 'on'
  const known = open !== undefined
  const canConnect = known && limits?.step !== 'unsupported' && !limitsOn && !hooksOn
  const list = glance?.sessions ?? []
  const today = limits?.tokens.today
  const stale = limitsOn && limits.live ? now - limits.live.at > LIMITS_STALE_MS : false
  const paused = prefs?.pausedUntil != null && prefs.pausedUntil > now

  return (
    <div className="pop__view" aria-busy={!known}>
      {canConnect ? (
        <Button variant="primary" onClick={() => void api.menubar.openWindow()}>
          Connect to Claude Code
        </Button>
      ) : null}
      {list.length > 0 ? (
        <ul className="cc__sessions pop__sessions" aria-label="Sessions">
          {list.map((s) => (
            <SessionRow key={s.id} s={s} now={now} />
          ))}
        </ul>
      ) : null}
      {limitsOn && others.length ? <div className="pop__label">{open?.name}</div> : null}
      {limitsOn ? (
        <div className="pop__meters">
          <LimitMeter label="5-hour" w={limits.live?.fiveHour} at={limits.live?.at} stale={stale} hit={limits.hits.fiveHour} tokens={limits.tokens.fiveHour.tokens} span="last 5 hours" now={now} />
          <LimitMeter label="Weekly" w={limits.live?.sevenDay} at={limits.live?.at} stale={stale} hit={limits.hits.sevenDay} tokens={limits.tokens.sevenDay.tokens} span="last 7 days" now={now} />
        </div>
      ) : null}
      {others.length ? (
        <ul className="pop__others" aria-label="Other profiles">
          {others.map((p) => (
            <li key={p.id}>
              <button type="button" className="pop__other" onClick={() => void api.profiles.openInWindow(p.id)}>
                <span className="pop__other-name">
                  {p.waiting > 0 ? <span className="pop__other-dot" role="img" aria-label={`${p.waiting} waiting`} /> : null}
                  {p.name}
                </span>
                <span className="pop__mono">{limitsLine(p.limits, now, true)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="pop__today">
        <span>{others.length && open ? `${open.name} today` : 'Today'}</span>
        <span className="pop__mono">
          {today ? `${formatTokens(today.tokens)} tokens · ${formatCount(today.sessions)} ${today.sessions === 1 ? 'session' : 'sessions'}` : '…'}
        </span>
      </div>
      <button type="button" className="pop__search" onClick={() => void api.menubar.openPalette()}>
        <span>Search sessions</span>
        <Kbd>{isMac() ? '⌘K' : 'Ctrl K'}</Kbd>
      </button>
      <div className="pop__foot">
        {prefs ? (
          <Button
            title={paused && prefs.pausedUntil ? `Paused until ${time(prefs.pausedUntil)}` : undefined}
            onClick={() => onPause({ pausedUntil: paused ? null : Date.now() + PAUSE_MS })}
          >
            {paused ? 'Resume alerts' : 'Pause 1 h'}
          </Button>
        ) : null}
        <span className="pop__grow" />
        <IconButton aria-label="Alert settings" icon={<Settings size={16} strokeWidth={1.8} />} onClick={onSettings} />
        <Button variant="ghost" onClick={() => void api.menubar.openWindow()}>
          Open Claudock
        </Button>
      </div>
    </div>
  )
}

function SettingsView({
  glance,
  prefs,
  bar,
  onChange,
  onBar,
  onBack
}: {
  glance: Glance | undefined
  prefs: AlertPrefs | undefined
  bar: MenubarState | undefined
  onChange: (patch: Partial<AlertPrefs>) => void
  onBar: (patch: { shown?: boolean; openAtLogin?: boolean }) => void
  onBack: () => void
}): JSX.Element {
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => back.current?.focus(), [])
  const open = glance?.profiles.find((p) => p.open)
  const sessionAlerts = open?.hooks !== 'unsupported'
  const limitAlerts = open?.limits.step !== 'unsupported'
  return (
    <div className="pop__view">
      <div className="pop__head">
        <button ref={back} type="button" className="pop__back" onClick={onBack}>
          <ChevronLeft size={16} strokeWidth={1.8} aria-hidden />
          Alerts
        </button>
      </div>
      {prefs ? (
        <div className="pop__rows">
          {sessionAlerts ? (
            <>
              <Choice label="Remind me if still waiting" value={prefs.reminderMinutes} choices={REMINDERS} unit=" min" onChange={(v) => onChange({ reminderMinutes: v })} />
              <Switch label="Session done" checked={prefs.doneAlert} onChange={(v) => onChange({ doneAlert: v })} />
            </>
          ) : null}
          {limitAlerts ? (
            <>
              <Choice label="Limit reaches" value={prefs.limitPercent} choices={LIMIT_LINES} unit="%" onChange={(v) => onChange({ limitPercent: v })} />
              <Switch label="Limit resets" checked={prefs.limitReset} onChange={(v) => onChange({ limitReset: v })} />
            </>
          ) : null}
          <Switch label="Sound" checked={prefs.sound} onChange={(v) => onChange({ sound: v })} />
        </div>
      ) : null}
      {bar ? (
        <div className="pop__rows">
          {bar.openAtLogin !== null ? <Switch label="Open at login" checked={bar.openAtLogin} onChange={(v) => onBar({ openAtLogin: v })} /> : null}
          <Switch label={isMac() ? 'Show in menu bar' : 'Show in tray'} checked={bar.shown} onChange={(v) => onBar({ shown: v })} />
        </div>
      ) : null}
      <div className="pop__foot">
        <span className="pop__grow" />
        <Button variant="ghost" onClick={() => void api.menubar.quit()}>
          Quit Claudock
        </Button>
      </div>
    </div>
  )
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <div className="pop__row">
      <span>{label}</span>
      <Toggle checked={checked} onChange={onChange} aria-label={label} />
    </div>
  )
}

function Choice({
  label,
  value,
  choices,
  unit,
  onChange
}: {
  label: string
  value: number | null
  choices: (number | null)[]
  unit: string
  onChange: (v: number | null) => void
}): JSX.Element {
  // a value set elsewhere (prefs.json) that isn't one of the choices is still shown
  const all = choices.includes(value) ? choices : [...choices, value]
  return (
    <label className="pop__row">
      <span>{label}</span>
      <select className="pop__select" value={value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
        {all.map((c) => (
          <option key={c ?? 'off'} value={c === null ? '' : String(c)}>
            {c === null ? 'Off' : `${c}${unit}`}
          </option>
        ))}
      </select>
    </label>
  )
}
