import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { Glance, Profile, ProfilesState } from '@shared/api/profiles'
import { tildify } from '@shared/format'
import { limitsLine } from '@shared/limits'
import { Button, ConfirmDialog, TextField, useToast } from '@/components'
import { api, isMac, isWindows, useApi, useEvent } from '@/lib/api'
import { useNav } from '@/lib/nav'
import { AddProfile } from './AddProfile'
import './profiles.css'

const TICK_MS = 30_000

/**
 * The title bar's folder, as the profile switcher (item 42, decision 1 A): the open profile's name (once there are
 * several), its folder and size. The menu lists every profile with its limit and a clay dot while one of its sessions
 * waits, the command that starts Claude Code on the open one, and Add profile. Right-click a profile (or press the
 * context menu key) to rename it, show its folder or remove it.
 */
export function ProfileMenu({ dir, home, size }: { dir: string; home: string; size: string }): JSX.Element {
  const { whenClean } = useNav()
  const toast = useToast()
  const profiles = useApi(() => api.profiles.get(), [])
  const [state, setState] = useState<ProfilesState>()
  const [g, setGlance] = useState<Glance>()
  const [open, setOpen] = useState(false)
  const [rowMenu, setRowMenu] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ p: Profile; name: string; error: string | null } | null>(null)
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)

  const s = state ?? profiles.data
  useEvent('profiles:changed', setState)
  useEvent('profiles:glance', setGlance)
  const loadGlance = (): void => void api.profiles.glance().then(setGlance, () => undefined)
  useEffect(loadGlance, [])

  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    loadGlance()
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    // focus the open profile's row, as a menu does
    requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus())
    return () => {
      clearInterval(t)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const close = (focus = false): void => {
    setOpen(false)
    setRowMenu(null)
    if (focus) trigger.current?.focus()
  }

  const onKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (rowMenu) setRowMenu(null)
      else close(true)
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }

  const list = s?.profiles ?? []
  const current = list.find((p) => p.id === s?.open)
  const several = list.length > 1
  const shownDir = current?.dir ?? dir

  const choose = (p: Profile): void => {
    close()
    if (p.id === s?.open) return
    whenClean(() => void api.profiles.open(p.id).catch((e: Error) => toast(e.message, { kind: 'error' })))
  }

  const copy = async (): Promise<void> => {
    if (!current) return
    try {
      await navigator.clipboard.writeText(current.command)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast('Couldn’t copy. Select the command and copy it instead.', { kind: 'error' })
    }
  }

  const remove = (p: Profile): void => {
    setRowMenu(null)
    void api.profiles.remove(p.id).then(
      () => toast(`Removed ${p.name}`, { kind: 'success' }),
      (e: Error) => toast(e.message, { kind: 'error' })
    )
  }

  const rename = async (): Promise<void> => {
    if (!renaming) return
    try {
      await api.profiles.rename(renaming.p.id, renaming.name)
      setRenaming(null)
    } catch (e) {
      setRenaming({ ...renaming, error: (e as Error).message })
    }
  }

  const revealLabel = isMac() ? 'Show in Finder' : isWindows() ? 'Show in Explorer' : 'Show in folder'

  return (
    <div className="profile-switch" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="titlebar__profile"
        aria-haspopup="menu"
        aria-expanded={open}
        title={shownDir}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {several && current ? <span className="titlebar__profile-name">{current.name}</span> : null}
        <span className="titlebar__path">
          {tildify(shownDir, home)} · {size}
        </span>
        <ChevronDown size={14} strokeWidth={1.8} aria-hidden className="titlebar__caret" />
      </button>
      {open ? (
        <div className="profile-menu" role="menu" aria-label="Profiles" ref={menu} onKeyDown={onKey}>
          {list.map((p) => {
            const pg = g?.profiles.find((x) => x.id === p.id)
            const checked = p.id === s?.open
            const removable = !p.launch && !checked
            return (
              <div key={p.id} className="profile-menu__item">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  className="profile-row"
                  title={p.dir}
                  onClick={() => choose(p)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setRowMenu(rowMenu === p.id ? null : p.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault()
                      setRowMenu(rowMenu === p.id ? null : p.id)
                    }
                  }}
                >
                  <span className="profile-row__check">{checked ? <Check size={14} strokeWidth={2} aria-hidden /> : null}</span>
                  <span className="profile-row__text">
                    <span className="profile-row__name">{p.name}</span>
                    <span className="profile-row__dir">{tildify(p.dir, home)}</span>
                  </span>
                  <span className="profile-row__end">
                    {pg && pg.waiting > 0 ? <span className="profile-row__dot" role="img" aria-label={`${pg.waiting} waiting`} /> : null}
                    {!p.exists ? 'Missing' : pg ? limitsLine(pg.limits, now, false) : ''}
                  </span>
                </button>
                {rowMenu === p.id ? (
                  <div className="profile-row__menu" role="group" aria-label={p.name}>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setRowMenu(null)
                        setRenaming({ p, name: p.name, error: null })
                      }}
                    >
                      Rename…
                    </Button>
                    {p.exists ? (
                      <Button variant="ghost" onClick={() => void api.profiles.reveal(p.id).catch((e: Error) => toast(e.message, { kind: 'error' }))}>
                        {revealLabel}
                      </Button>
                    ) : null}
                    {removable ? (
                      <Button variant="ghost" onClick={() => remove(p)}>
                        Remove from Claudock
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
          {current ? (
            <div className="profile-menu__cmd">
              <code className="selectable">{current.command}</code>
              <Button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="profile-menu__add"
            onClick={() => {
              close()
              setAdding(true)
            }}
          >
            Add profile…
          </button>
        </div>
      ) : null}
      <AddProfile open={adding} home={home} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={renaming !== null}
        title="Rename profile"
        confirmLabel="Rename"
        confirmDisabled={!renaming?.name.trim()}
        description={
          renaming ? (
            <TextField
              label="Name"
              autoFocus
              value={renaming.name}
              maxLength={40}
              error={renaming.error ?? undefined}
              onChange={(e) => setRenaming({ ...renaming, name: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void rename()
              }}
            />
          ) : null
        }
        onConfirm={() => void rename()}
        onCancel={() => setRenaming(null)}
      />
    </div>
  )
}
