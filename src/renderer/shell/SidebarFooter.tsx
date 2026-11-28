import { useEffect, useRef, useState } from 'react'
import { SCREEN_BY_ID } from '@shared/nav'
import type { UpdateInfo, UpdateStatus, WhatsNew } from '@shared/types'
import { Button, ConfirmDialog, useToast } from '@/components'
import { api, useApi, useEvent } from '@/lib/api'
import { useNav } from '@/lib/nav'

const mb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1e6))} MB`

/**
 * The sidebar's foot (U1 + W1, approved 26 Nov 2026). "Unofficial · v0.6.0", which opens What's new; or, when a newer
 * release is out, "v0.7.0 available", whose popover shows the download's size and the release's highlights with Release
 * notes and Update. Update downloads in place (the footer becomes a progress bar), then "Restart to update" swaps the
 * app and starts it (src/main/updateInstall.ts). A copy that can't update itself (a git clone, the .deb, a Mac app in a
 * folder it can't write to, an npm install that failed) offers the npm command or the download instead.
 */
export function SidebarFooter(): JSX.Element {
  const info = useApi(() => api.system.appInfo(), [])
  const update = useApi(() => api.system.checkUpdate(), [])
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' })
  const notes = useApi(() => api.system.whatsNew(), [])
  const [sheet, setSheet] = useState(false)

  useEffect(() => {
    void api.system.updateStatus().then(setStatus, () => undefined)
  }, [])
  useEvent('system:updateStatus', setStatus)
  useEvent('system:update', () => update.reload())
  useEvent('system:whatsNew', () => {
    notes.reload()
    setSheet(true)
  })

  // main answers from a cache and asks again at most every six hours, so asking on every focus is cheap
  const recheck = update.reload // stable across renders
  useEffect(() => {
    window.addEventListener('focus', recheck)
    return () => window.removeEventListener('focus', recheck)
  }, [recheck])

  // the first open after an update shows the notes by themselves, once; a Restart whose swap failed says why, once
  const toast = useToast()
  const shown = useRef(false)
  useEffect(() => {
    if (notes.data?.first && !shown.current) {
      shown.current = true
      setSheet(true)
    }
    if (notes.data?.failure) toast(`Couldn't update: ${notes.data.failure}. The details are in Claudock's logs/update.log.`, { kind: 'error' })
  }, [notes.data, toast])

  // notes that couldn't be fetched at launch are asked for again
  const openNotes = (): void => {
    if (!notes.data?.notes.length) notes.reload()
    setSheet(true)
  }

  const version = info.data?.version ?? ''
  const u = update.data
  let body: JSX.Element
  if (status.phase === 'downloading') body = <Progress status={status} />
  else if (status.phase === 'ready') body = <Restart />
  else if (u) body = <Available u={u} onFailed={update.reload} />
  else
    body = (
      <footer className="sidebar__footer sidebar__footer--plain">
        <button type="button" className="version-trigger" aria-haspopup="dialog" aria-label={`Unofficial, version ${version}. What's new`} onClick={openNotes}>
          Unofficial · v{version}
        </button>
      </footer>
    )

  return (
    <>
      {body}
      {notes.data ? (
        <WhatsNewSheet
          open={sheet}
          data={notes.data}
          onClose={() => {
            setSheet(false)
            void api.system.seenWhatsNew().catch(() => undefined)
          }}
        />
      ) : null}
    </>
  )
}

/** "vX available" and its popover. */
function Available({ u, onFailed }: { u: UpdateInfo; onFailed: () => void }): JSX.Element {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const root = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

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

  const copy = async (): Promise<void> => {
    if (!u.command) return
    await navigator.clipboard.writeText(u.command)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const install = (): void => {
    setOpen(false)
    api.system.installUpdate(u.version).catch((e: Error) => {
      toast(`Couldn't update to ${u.version}: ${e.message}`, { kind: 'error' })
      // an npm copy whose install failed offers the command from now on
      onFailed()
    })
  }

  const notesLink = (
    <a className="btn btn--secondary" href={u.url} target="_blank" rel="noreferrer">
      Release notes
    </a>
  )

  return (
    <footer className="sidebar__footer sidebar__footer--update" ref={root}>
      <button ref={trigger} type="button" className="update-trigger" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        <span className="update-trigger__dot" aria-hidden />v{u.version} available
      </button>
      {open ? (
        <div className="update-pop" role="dialog" aria-label={`Claudock ${u.version}`}>
          <span className="update-pop__title">
            Claudock {u.version}
            {u.installable && u.size ? <small>{mb(u.size)}</small> : null}
          </span>
          {u.installable ? (
            <>
              {u.highlights.length ? (
                <ul className="update-pop__list">
                  {u.highlights.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              ) : null}
              <div className="update-pop__actions">
                {notesLink}
                <Button variant="primary" onClick={install} autoFocus>
                  Update
                </Button>
              </div>
            </>
          ) : (
            <>
              {u.command ? <code className="update-pop__cmd selectable">{u.command}</code> : null}
              <div className="update-pop__actions">
                {u.command ? (
                  <>
                    {notesLink}
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
            </>
          )}
        </div>
      ) : null}
    </footer>
  )
}

/** "Downloading 0.7.0 · 41 / 98 MB" over a bar; an npm copy installs without byte counts. */
function Progress({ status }: { status: Extract<UpdateStatus, { phase: 'downloading' }> }): JSX.Element {
  const pct = status.total ? Math.min(100, (status.received / status.total) * 100) : null
  return (
    <footer className="sidebar__footer sidebar__footer--update">
      <div className="update-prog">
        <div className="update-prog__label">
          <span>
            {status.total === null && status.received === 0 ? 'Installing' : 'Downloading'} {status.version}
          </span>
          {status.total ? (
            <span className="num">
              {Math.floor(status.received / 1e6)} / {mb(status.total)}
            </span>
          ) : null}
        </div>
        <span
          className={pct === null ? 'update-prog__track update-prog__track--busy' : 'update-prog__track'}
          role="progressbar"
          aria-label={`Downloading Claudock ${status.version}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct === null ? undefined : Math.round(pct)}
        >
          <span className="update-prog__fill" style={pct === null ? undefined : { width: `${pct}%` }} />
        </span>
      </div>
    </footer>
  )
}

function Restart(): JSX.Element {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <footer className="sidebar__footer sidebar__footer--update">
      <button
        type="button"
        className="update-trigger update-trigger--ready"
        disabled={busy}
        onClick={() => {
          setBusy(true)
          api.system.restartToUpdate().catch((e: Error) => {
            setBusy(false)
            toast(`Couldn't restart to update: ${e.message}`, { kind: 'error' })
          })
        }}
      >
        <span className="update-trigger__dot" aria-hidden />
        Restart to update
      </button>
    </footer>
  )
}

/** W1: "What's new in X" over the screen; each note opens the screen it is about. */
function WhatsNewSheet({ open, data, onClose }: { open: boolean; data: WhatsNew; onClose: () => void }): JSX.Element {
  const { navigate } = useNav()
  return (
    <ConfirmDialog
      open={open}
      title={`What's new in ${data.version}`}
      confirmLabel="Done"
      hideCancel
      focusConfirm
      onConfirm={onClose}
      onCancel={onClose}
      extra={
        data.notes.length ? null : (
          <a className="btn btn--secondary" href={data.url} target="_blank" rel="noreferrer">
            Release notes
          </a>
        )
      }
      description={
        data.notes.length ? (
          <ul className="whatsnew">
            {data.notes.map((n) => (
              <li key={n.title} className="whatsnew__note">
                <b>{n.title}</b>
                {n.text ? <p>{n.text}</p> : null}
                {n.screen && SCREEN_BY_ID[n.screen] ? (
                  <button
                    type="button"
                    className="whatsnew__link"
                    onClick={() => {
                      onClose()
                      if (n.screen) navigate(n.screen)
                    }}
                  >
                    Open {SCREEN_BY_ID[n.screen].label}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null
      }
    />
  )
}
