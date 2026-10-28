import { useEffect, useState } from 'react'
import type { ConnectParts, ConnectPreview, HookLine } from '@shared/api/connect'
import { api } from '@/lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import { DiffView } from './DiffView'
import { useToast } from './Toast'
import './live.css'

/**
 * The "Connect to Claude Code" sheet, shared by the Overview card and the first-run reveal: a checkbox per part over
 * the one change they make to settings.json (item 7, decision 1 A). `want` opens it with those parts ticked (only the
 * ones that can still be added); null closes it. `onConnected` runs after a successful Connect, once it has closed.
 */
export function ConnectSheet({ want, onClose, onConnected }: { want: ConnectParts | null; onClose: () => void; onConnected?: () => void }): JSX.Element {
  const [sheet, setSheet] = useState<{ preview: ConnectPreview; parts: ConnectParts } | null>(null)
  const [busy, setBusy] = useState(false)
  // a failed Connect is said inside the sheet: toasts sit under a modal <dialog>
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()

  useEffect(() => {
    setError(null)
    if (!want) return setSheet(null)
    let stale = false
    api.connect.previewConnect().then(
      (preview) => {
        if (stale) return
        setSheet({ preview, parts: { statusLine: want.statusLine && preview.statusLine !== null, hooks: want.hooks && preview.hooks.length > 0 } })
      },
      (e: Error) => {
        if (stale) return
        toast(e.message, { kind: 'error' })
        onClose()
      }
    )
    return () => {
      stale = true
    }
    // a new `want` object opens it again; onClose and toast are recreated by callers on every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want])

  const connect = async (parts: ConnectParts): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.connect.connect(parts)
      onClose()
      toast('Connected to Claude Code', { kind: 'success' })
      onConnected?.()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={sheet !== null}
      title="Connect to Claude Code"
      confirmLabel="Connect"
      busy={busy}
      confirmDisabled={!sheet || (!sheet.parts.statusLine && !sheet.parts.hooks)}
      description={
        sheet ? (
          <>
            <ConnectChoice preview={sheet.preview} parts={sheet.parts} onChange={(parts) => {
                setError(null)
                setSheet({ ...sheet, parts })
              }} />
            {error ? (
              <p className="find__error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        ) : null
      }
      onConfirm={() => sheet && void connect(sheet.parts)}
      onCancel={onClose}
    />
  )
}

/** The checkboxes, and the change the ticked parts make to settings.json. */
function ConnectChoice({ preview, parts, onChange }: { preview: ConnectPreview; parts: ConnectParts; onChange: (p: ConnectParts) => void }): JSX.Element {
  const canLimits = preview.statusLine !== null
  const canHooks = preview.hooks.length > 0
  // one shared reason (disableAllHooks) is shown once and describes both boxes
  const sharedProblem = preview.hooksProblem !== null && preview.hooksProblem === preview.statusLineProblem
  return (
    <div className="cc__sheet">
      {canLimits || preview.statusLineProblem ? (
        <label className="cc__check">
          <input
            type="checkbox"
            checked={parts.statusLine}
            disabled={!canLimits}
            aria-describedby={preview.statusLineProblem ? 'cc-limits-problem' : undefined}
            onChange={(e) => onChange({ ...parts, statusLine: e.target.checked })}
          />
          <span>Live limits</span>
        </label>
      ) : null}
      {preview.statusLineProblem ? (
        <p id="cc-limits-problem" className="find__error">
          {preview.statusLineProblem}
        </p>
      ) : null}
      {canHooks || preview.hooksProblem ? (
        <label className="cc__check">
          <input
            type="checkbox"
            checked={parts.hooks}
            disabled={!canHooks}
            aria-describedby={preview.hooksProblem ? (sharedProblem ? 'cc-limits-problem' : 'cc-hooks-problem') : undefined}
            onChange={(e) => onChange({ ...parts, hooks: e.target.checked })}
          />
          <span>Waiting sessions</span>
        </label>
      ) : null}
      {preview.hooksProblem && !sharedProblem ? (
        <p id="cc-hooks-problem" className="find__error">
          {preview.hooksProblem}
        </p>
      ) : null}
      {parts.statusLine || parts.hooks ? <ChangeDiff preview={preview} parts={parts} /> : null}
    </div>
  )
}

const hookText = (h: HookLine): string => `"${h.event}"${h.matcher ? ` (${h.matcher})` : ''}: ${h.command}`

/** settings.json lines before and after: statusLine, then one line per hook. */
export function ChangeDiff({ preview, parts, removing }: { preview: ConnectPreview; parts: ConnectParts; removing?: boolean }): JSX.Element {
  const sl = parts.statusLine ? preview.statusLine : null
  const hooks = parts.hooks ? preview.hooks.map(hookText) : []
  const line = (cmd: string | null): string[] => (cmd === null ? [] : [`"statusLine": ${cmd}`])
  const before = [...line(sl ? sl.before : null), ...(removing ? hooks : [])]
  const after = [...line(sl ? sl.after : null), ...(removing ? [] : hooks)]
  return <DiffView className="lim__diff cc__diff" before={before.join('\n')} after={after.join('\n')} beforeLabel="settings.json now" afterLabel="after" />
}
