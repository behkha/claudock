import { CircleCheck } from 'lucide-react'
import type { Written } from '@shared/api/team'
import { Button, ConfirmDialog, PathLabel } from '@/components'
import { api } from '@/lib/api'
import { useNotify } from '../_ext/ui'
import { CommandRow } from './parts'

/** After a write (decision 4 A): what was written, where, and the line that sends it to the team. Claudock never runs git. */
export function WrittenSheet({ written, onClose }: { written: Written | null; onClose: () => void }): JSX.Element {
  const notify = useNotify()
  const n = written ? written.files + written.removed : 0
  return (
    <ConfirmDialog
      open={written !== null}
      title={n === 1 ? '1 file written' : `${n} files written`}
      confirmLabel="Done"
      hideCancel
      extra={<Button onClick={() => api.team.reveal().catch(notify.failed)}>Reveal folder</Button>}
      description={
        written ? (
          <div className="tm-sheet">
            <div className="tm-ok">
              <CircleCheck size={16} strokeWidth={2} aria-hidden />
              <PathLabel path={written.dir} reveal={false} />
            </div>
            <h3 className="tm-sheet__sub">Send it to the team</h3>
            <CommandRow text={written.command} onCopy={() => api.team.copy('send')} />
          </div>
        ) : null
      }
      onConfirm={onClose}
      onCancel={onClose}
    />
  )
}
