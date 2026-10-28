import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import type { FolderChoice } from '@shared/api/profiles'
import { tildify } from '@shared/format'
import { ConfirmDialog, TextField, useToast } from '@/components'
import { api } from '@/lib/api'
import { useNav } from '@/lib/nav'

const NEW = 'new'

const count = (n: number): string => (n === 0 ? 'No sessions' : n === 1 ? '1 session' : `${n} sessions`)

/**
 * Add profile (item 42, decision 3 A): the Claude Code folders found beside `~/.claude`, a new empty folder, or one
 * picked in the system folder picker, with a name filled in from the folder. Adding opens the profile.
 */
export function AddProfile({ open, home, onClose }: { open: boolean; home: string; onClose: () => void }): JSX.Element {
  const toast = useToast()
  const { whenClean } = useNav()
  const [choices, setChoices] = useState<FolderChoice[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [typed, setTyped] = useState(false)
  const [newPath, setNewPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // said inside the sheet: toasts sit under a modal <dialog>
  const [error, setError] = useState<string | null>(null)

  const pick = (c: FolderChoice): void => {
    setSel(c.dir)
    setError(null)
    if (!typed) setName(c.name)
  }
  const pickNew = (): void => {
    setSel(NEW)
    setError(null)
    if (!typed) setName('')
  }

  useEffect(() => {
    if (!open) return
    setChoices(null)
    setSel(null)
    setName('')
    setTyped(false)
    setError(null)
    let stale = false
    api.profiles.found().then(
      (found) => {
        if (stale) return
        setChoices(found)
        if (found[0]) {
          setSel(found[0].dir)
          setName(found[0].name)
        } else setSel(NEW)
      },
      (e: Error) => {
        if (stale) return
        setChoices([])
        setSel(NEW)
        setError(e.message)
      }
    )
    return () => {
      stale = true
    }
  }, [open])

  // the folder "New folder" would make, as the name is typed
  useEffect(() => {
    if (sel !== NEW || !name.trim()) return setNewPath(null)
    let stale = false
    api.profiles.newFolder(name).then(
      (p) => !stale && setNewPath(p),
      () => !stale && setNewPath(null)
    )
    return () => {
      stale = true
    }
  }, [sel, name])

  const chooseFolder = (): void => {
    setError(null)
    api.profiles.choose().then(
      (c) => {
        if (!c) return
        setChoices((list) => [...(list ?? []).filter((x) => x.dir !== c.dir), c])
        pick(c)
      },
      (e: Error) => setError(e.message)
    )
  }

  const add = async (): Promise<void> => {
    if (!sel) return
    // adding opens the profile, which reloads every screen: unsaved edits are asked about first
    whenClean(() => void addNow(sel))
  }

  const addNow = async (sel: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.profiles.add(sel === NEW ? { create: true, name } : { dir: sel, name })
      onClose()
      toast(`Added ${name.trim()}`, { kind: 'success' })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title="Add profile"
      confirmLabel="Add"
      busy={busy}
      confirmDisabled={!sel || !name.trim()}
      description={
        <div className="add-profile">
          <div className="add-profile__list" role="radiogroup" aria-label="Folder" aria-busy={choices === null}>
            {(choices ?? []).map((c) => (
              <label key={c.dir} className="add-profile__opt" title={c.dir}>
                <input type="radio" name="profile-folder" checked={sel === c.dir} onChange={() => pick(c)} />
                <span className="add-profile__dir">{tildify(c.dir, home)}</span>
                <span className="add-profile__meta">{count(c.sessions)}</span>
              </label>
            ))}
            <label className="add-profile__opt">
              <input type="radio" name="profile-folder" checked={sel === NEW} onChange={pickNew} />
              <span>New folder</span>
              <span className="add-profile__meta add-profile__mono">{sel === NEW && newPath ? tildify(newPath, home) : ''}</span>
            </label>
            <button type="button" className="add-profile__opt add-profile__choose" onClick={chooseFolder}>
              <FolderOpen size={15} strokeWidth={1.8} aria-hidden />
              <span>Choose folder…</span>
            </button>
          </div>
          <TextField
            label="Name"
            value={name}
            maxLength={40}
            onChange={(e) => {
              setTyped(true)
              setName(e.target.value)
              setError(null)
            }}
          />
          {error ? (
            <p className="add-profile__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      }
      onConfirm={() => void add()}
      onCancel={onClose}
    />
  )
}
