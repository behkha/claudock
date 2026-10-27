import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components'
import { api, useApi } from '@/lib/api'

/**
 * "Unofficial · v0.1.0", or, when a newer release is out, "v0.2.0 available" opening a popover with the update:
 * the npm command to copy, or the release page for installer builds (an ad-hoc signed app can't update itself).
 */
export function SidebarFooter(): JSX.Element {
  const info = useApi(() => api.system.appInfo(), [])
  const update = useApi(() => api.system.checkUpdate(), [])
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const root = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  // main answers from a cache and asks again at most every six hours, so asking on every focus is cheap
  const recheck = update.reload // stable across renders
  useEffect(() => {
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [recheck])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const u = update.data
  if (!u) return <footer className="sidebar__footer">Unofficial · v{info.data?.version ?? ''}</footer>

  const copy = async (): Promise<void> => {
    if (!u.command) return
    await navigator.clipboard.writeText(u.command)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <footer className="sidebar__footer sidebar__footer--update" ref={root}>
      <button ref={trigger} type="button" className="update-trigger" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <span className="update-trigger__dot" aria-hidden />v{u.version} available
      </button>
      {open ? (
        <div className="update-pop" role="dialog" aria-label={`Claudock ${u.version}`}>
          <span className="update-pop__title">Claudock {u.version}</span>
          {u.command ? <code className="update-pop__cmd selectable">{u.command}</code> : null}
          <div className="update-pop__actions">
            {u.command ? (
              <>
                <a className="btn btn--secondary" href={u.url} target="_blank" rel="noreferrer">
                  Release notes
                </a>
                <Button variant="primary" onClick={() => void copy()} autoFocus>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </>
            ) : (
              <a className="btn btn--primary" href={u.url} target="_blank" rel="noreferrer" autoFocus>
                Download
              </a>
            )}
          </div>
        </div>
      ) : null}
    </footer>
  )
}
