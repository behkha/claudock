import { useEffect, useState } from 'react'
import type { TeamProject, TeamState } from '@shared/api/team'
import { ConfirmDialog } from '@/components'
import { api } from '@/lib/api'
import { FetchedDiff } from './parts'

/**
 * Connect a project (decision 5 A): the git projects Claude Code knows, most recent first; the one picked shows the two
 * keys its `.claude/settings.json` gains (or loses, when it is connected already) as a diff.
 */
export function ConnectSheet({ open, projects, onClose, onDone }: { open: boolean; projects: TeamProject[]; onClose: () => void; onDone: (s: TeamState) => void }): JSX.Element {
  const [sel, setSel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setError(null)
    setSel(projects.find((p) => !p.connected)?.id ?? projects[0]?.id ?? null)
    // the projects of the moment it opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const picked = projects.find((p) => p.id === sel) ?? null

  const run = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      onDone(await (picked.connected ? api.team.disconnect(picked.id) : api.team.connect(picked.id)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      wide
      title="Connect a project"
      confirmLabel={picked?.connected ? 'Disconnect' : 'Connect'}
      tone={picked?.connected ? 'danger' : 'default'}
      busy={busy}
      confirmDisabled={!picked}
      description={
        <div className="tm-sheet">
          {projects.length === 0 ? (
            <p className="tm-sheet__muted">No git project of yours is known to Claude Code yet.</p>
          ) : (
            <div className="add-profile__list" role="radiogroup" aria-label="Project">
              {projects.map((p) => (
                <label key={p.id} className="add-profile__opt" title={p.path}>
                  <input type="radio" name="team-project" checked={sel === p.id} onChange={() => setSel(p.id)} />
                  <span className="add-profile__dir">{p.name}</span>
                  <span className="add-profile__meta">{p.connected ? 'Connected' : ''}</span>
                </label>
              ))}
            </div>
          )}
          {picked ? <FetchedDiff load={() => api.team.connectPlan(picked.id)} deps={[picked.id, picked.connected]} beforeLabel=".claude/settings.json" afterLabel={picked.connected ? 'Disconnected' : 'Connected'} /> : null}
          {error ? (
            <p className="tm-sheet__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      }
      onConfirm={() => void run()}
      onCancel={onClose}
    />
  )
}
