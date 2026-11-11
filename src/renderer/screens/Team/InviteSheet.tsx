import type { JoinCommands } from '@shared/api/team'
import { ConfirmDialog } from '@/components'
import { api } from '@/lib/api'
import { CommandRow } from './parts'

/** The commands a teammate runs to join: for all their work, inside a connected project, and the value to give after. */
export function InviteSheet({ join, open, onClose }: { join: JoinCommands | null; open: boolean; onClose: () => void }): JSX.Element {
  return (
    <ConfirmDialog
      open={open && join !== null}
      wide
      title="Invite"
      confirmLabel="Done"
      hideCancel
      description={
        join ? (
          <div className="tm-sheet">
            <h3 className="tm-sheet__sub">For all their work</h3>
            <CommandRow text={join.user} onCopy={() => api.team.copy('join-user')} />
            <h3 className="tm-sheet__sub">In a connected project</h3>
            <CommandRow text={join.project} onCopy={() => api.team.copy('join-project')} />
            {join.configure ? (
              <>
                <h3 className="tm-sheet__sub">Then, in Claude Code</h3>
                <CommandRow text={join.configure} onCopy={() => api.team.copy('configure')} />
              </>
            ) : null}
          </div>
        ) : null
      }
      onConfirm={onClose}
      onCancel={onClose}
    />
  )
}
