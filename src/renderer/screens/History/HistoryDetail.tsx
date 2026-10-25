import { Copy } from 'lucide-react'
import { formatCount, formatDateTime, tildify } from '@shared/format'
import { Badge, Button, DetailPane, EmptyState, Spinner, useToast } from '@/components'
import { api, useApi } from '@/lib/api'

export function HistoryDetail({ id, home }: { id: number; home: string }): JSX.Element {
  const toast = useToast()
  const res = useApi(() => api.history.get(id), [id])
  const { error, loading } = res
  // useApi keeps the previous entry while the next one loads or fails: never show or copy another entry's prompt
  const data = loading || error ? undefined : res.data

  if (error) {
    return <EmptyState title="Entry not found" description={error} />
  }
  if (!data) {
    return (
      <DetailPane title="Prompt">
        <Spinner />
      </DetailPane>
    )
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(data!.display)
      toast('Copied the prompt.', { kind: 'success' })
    } catch {
      toast('Could not copy. Select the text and copy it by hand.', { kind: 'error' })
    }
  }

  return (
    <DetailPane
      title={formatDateTime(data.ts)}
      path={data.project ? tildify(data.project, home) : undefined}
      reveal={false}
      badges={data.pasted > 0 ? <Badge tone="oat">{data.pasted} pasted</Badge> : undefined}
      actions={
        <Button variant="primary" icon={<Copy size={15} />} onClick={() => void copy()}>
          Copy prompt
        </Button>
      }
    >
      <pre className="his-prompt selectable">{data.display}</pre>
      <dl className="his-meta">
        <dt>Time</dt>
        <dd>{formatDateTime(data.ts)}</dd>
        <dt>Project</dt>
        <dd className={data.project ? 'his-mono selectable' : undefined}>{data.project ?? 'None recorded'}</dd>
        <dt>Pasted contents</dt>
        <dd>{data.pasted === 0 ? 'None' : `${formatCount(data.pasted)} (${data.pastedKinds.join(', ')})`}</dd>
        <dt>Length</dt>
        <dd>{formatCount(data.display.length)} characters</dd>
        {data.sessionId ? (
          <>
            <dt>Session</dt>
            <dd className="his-mono selectable">{data.sessionId}</dd>
          </>
        ) : null}
      </dl>
    </DetailPane>
  )
}
