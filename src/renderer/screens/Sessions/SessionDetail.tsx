import { useCallback, useState } from 'react'
import { Copy, Download, Trash2 } from 'lucide-react'
import type { ArchivedSession } from '@shared/api/archive'
import { formatBytes, formatCount, formatDateTime, tildify } from '@shared/format'
import { Badge, Button, ConfirmDialog, DetailPane, useToast } from '@/components'
import { api } from '@/lib/api'
import { useHome } from '@/lib/hooks'
import { Transcript } from '../Projects/Transcript'

interface Props {
  session: ArchivedSession
  /** Byte offset of a search hit to open the transcript at. */
  focusOffset?: number
  /** A deleted session was put back in Claude Code's folder. */
  onChanged: () => void
  onTrashed: () => void
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })

/** "Oct 29, 2026, 02:02 PM – 03:40 PM · 48 messages" */
function facts(s: ArchivedSession): string {
  const parts: string[] = []
  if (s.startMs !== null) {
    const end = s.endMs ?? s.startMs
    const sameDay = new Date(s.startMs).toDateString() === new Date(end).toDateString()
    parts.push(end === s.startMs ? formatDateTime(s.startMs) : `${formatDateTime(s.startMs)} – ${sameDay ? clock(end) : formatDateTime(end)}`)
  } else {
    parts.push(formatDateTime(s.mtimeMs))
  }
  parts.push(`${formatCount(s.messages)} ${s.messages === 1 ? 'message' : 'messages'}`)
  return parts.join(' · ')
}

export function SessionDetail({ session, focusOffset, onChanged, onTrashed }: Props): JSX.Element {
  const toast = useToast()
  const home = useHome()
  const [command, setCommand] = useState<string | null>(null)
  const [busy, setBusy] = useState<'resume' | 'export' | 'trash' | null>(null)
  const [confirm, setConfirm] = useState(false)
  const read = useCallback((offset: number, limit: number) => api.archive.read(session.key, offset, limit), [session.key])

  async function resume(): Promise<void> {
    setBusy('resume')
    try {
      const r = await api.archive.resume(session.key)
      setCommand(r.command)
      if (r.restored) onChanged()
      toast(r.restored ? 'Copied · put back in Claude Code’s folder' : 'Copied resume command', { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  async function exportMarkdown(): Promise<void> {
    setBusy('export')
    try {
      const r = await api.archive.exportMarkdown(session.key)
      if (r) toast(`Exported to ${tildify(r.path, home)}`, { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  async function trash(): Promise<void> {
    setBusy('trash')
    try {
      await api.archive.trash(session.key)
      setConfirm(false)
      toast('Moved to Trash', { kind: 'success' })
      onTrashed()
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const title = session.title || 'Untitled session'
  return (
    <>
      <DetailPane
        className="ses-detail"
        title={title}
        badges={session.archived ? <Badge tone="oat">Archived</Badge> : undefined}
        path={session.cwd ?? undefined}
        reveal={false}
        actions={
          <>
            <Button variant="primary" icon={<Copy size={15} />} loading={busy === 'resume'} disabled={busy !== null} onClick={() => void resume()}>
              Copy resume command
            </Button>
            <Button icon={<Download size={15} />} loading={busy === 'export'} disabled={busy !== null} onClick={() => void exportMarkdown()}>
              Export…
            </Button>
            <Button variant="danger" icon={<Trash2 size={15} />} disabled={busy !== null} onClick={() => setConfirm(true)}>
              Move to Trash
            </Button>
          </>
        }
      >
        <p className="ses-facts">{facts(session)}</p>
        {command ? <code className="ses-cmd selectable">{command}</code> : null}
        <Transcript source={session.key} read={read} totalBytes={session.bytes} focusOffset={focusOffset} />
      </DetailPane>
      <ConfirmDialog
        open={confirm}
        tone="danger"
        title="Move this session to Trash?"
        description={`“${title}” · ${formatBytes(session.bytes)}`}
        confirmLabel="Move to Trash"
        busy={busy === 'trash'}
        onConfirm={() => void trash()}
        onCancel={() => setConfirm(false)}
      />
    </>
  )
}
