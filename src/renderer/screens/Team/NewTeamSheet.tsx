import { useEffect, useState } from 'react'
import { marketplaceNameProblem, pluginNameProblem, type FolderOffer, type TeamState } from '@shared/api/team'
import { Button, ConfirmDialog, PathLabel, TextField } from '@/components'
import { api } from '@/lib/api'

/**
 * New team setup: the folder picked in the system dialog (it must be a git repo), and the marketplace, plugin and owner
 * names, filled in from the folder's remote or name, or from the marketplace Claudock already wrote there.
 */
export function NewTeamSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (s: TeamState) => void }): JSX.Element {
  const [folder, setFolder] = useState<FolderOffer | null>(null)
  const [names, setNames] = useState({ marketplace: '', plugin: '', owner: '' })
  const [busy, setBusy] = useState(false)
  // said inside the sheet: toasts sit under a modal <dialog>
  const [error, setError] = useState<string | null>(null)

  const choose = (): void => {
    setError(null)
    api.team.pickFolder().then(
      (f) => {
        if (!f) return
        setFolder(f)
        setNames({ marketplace: f.marketplace, plugin: f.plugin, owner: f.owner })
        if (!f.isGit) setError('Choose a git repo, so every write can be undone.')
      },
      (e: Error) => setError(e.message)
    )
  }

  useEffect(() => {
    if (!open) return
    setFolder(null)
    setNames({ marketplace: '', plugin: '', owner: '' })
    setError(null)
    choose()
  }, [open])

  const problems = {
    marketplace: names.marketplace ? marketplaceNameProblem(names.marketplace) : null,
    plugin: names.plugin ? pluginNameProblem(names.plugin) : null
  }
  const ready = !!folder?.isGit && !!names.marketplace && !!names.plugin && !!names.owner.trim() && !problems.marketplace && !problems.plugin

  const create = async (): Promise<void> => {
    if (!folder || !ready) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.team.create({ token: folder.token, ...names }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title="New team setup"
      confirmLabel="Create"
      busy={busy}
      confirmDisabled={!ready}
      description={
        <div className="tm-sheet">
          <div className="tm-folder">
            <div className="tm-folder__text">
              {folder ? <PathLabel path={folder.dir} reveal={false} /> : <span>No folder chosen</span>}
              {folder ? <span>{folder.remote ? folder.remote.text : folder.isGit ? 'No remote yet' : 'Not a git repo'}</span> : null}
            </div>
            <Button onClick={choose}>{folder ? 'Change…' : 'Choose folder…'}</Button>
          </div>
          {folder ? (
            <>
              <TextField label="Marketplace" mono value={names.marketplace} error={problems.marketplace ?? undefined} spellCheck={false} onChange={(e) => setNames({ ...names, marketplace: e.target.value })} />
              <TextField label="Plugin" mono value={names.plugin} error={problems.plugin ?? undefined} spellCheck={false} onChange={(e) => setNames({ ...names, plugin: e.target.value })} />
              <TextField label="Owner" value={names.owner} maxLength={80} onChange={(e) => setNames({ ...names, owner: e.target.value })} />
            </>
          ) : null}
          {error ? (
            <p className="tm-sheet__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      }
      onConfirm={() => void create()}
      onCancel={onClose}
    />
  )
}
