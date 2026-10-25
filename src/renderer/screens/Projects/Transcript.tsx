import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Terminal, Wrench } from 'lucide-react'
import type { TranscriptEntry } from '@shared/api/projects'
import { formatBytes, formatCount } from '@shared/format'
import { Button, Chip, MarkdownView, Spinner } from '@/components'
import { api } from '@/lib/api'

const PAGE = 200

function time(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
}

const Entry = memo(function Entry({ e, showThinking }: { e: TranscriptEntry; showThinking: boolean }): JSX.Element | null {
  switch (e.kind) {
    case 'user':
    case 'assistant':
      return (
        <div className={`tx__msg tx__msg--${e.kind}`}>
          <div className="tx__who">
            <strong>{e.kind === 'user' ? 'You' : 'Claude'}</strong>
            <span>{time(e.ts)}</span>
          </div>
          <div className="tx__bubble">
            <MarkdownView source={e.text} stripFrontmatter={false} />
            {e.truncated ? <span className="tx__more">Shortened here: {formatCount(e.chars ?? 0)} characters in the file.</span> : null}
          </div>
        </div>
      )
    case 'command':
      return (
        <div className="tx__line">
          <Terminal size={13} strokeWidth={1.8} aria-hidden />
          <span className="tx__line-sum" style={{ color: 'var(--text)' }}>
            {e.text}
          </span>
        </div>
      )
    case 'tool_use':
      return (
        <div className="tx__line">
          <Wrench size={13} strokeWidth={1.8} aria-hidden />
          <span className="tx__line-name">{e.name}</span>
          <span className="tx__line-sum">{e.summary}</span>
        </div>
      )
    case 'tool_result':
      return (
        <details className={`tx__details${e.error ? ' tx__details--error' : ''}`}>
          <summary>
            <ChevronRight className="tx__chev" size={13} strokeWidth={1.8} aria-hidden />
            {e.error ? 'Tool error' : 'Tool result'}
            <span style={{ color: 'var(--text-3)' }}>{e.chars ? `${formatCount(e.chars)} characters` : 'empty'}</span>
          </summary>
          <pre className="selectable">
            {e.text}
            {e.truncated ? '\n…' : ''}
          </pre>
        </details>
      )
    case 'thinking':
      return showThinking ? (
        <details className="tx__details" open>
          <summary>
            <ChevronRight className="tx__chev" size={13} strokeWidth={1.8} aria-hidden />
            Thinking
          </summary>
          <pre className="selectable">
            {e.text}
            {e.truncated ? '\n…' : ''}
          </pre>
        </details>
      ) : null
  }
})

/** Streams a transcript in pages of 200 entries. Never holds more than what the user asked to see. */
export function Transcript({ projectId, sessionId, totalBytes }: { projectId: string; sessionId: string; totalBytes: number }): JSX.Element {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [next, setNext] = useState<number | null>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState(0)
  const [showThinking, setShowThinking] = useState(false)
  const token = useRef(0)

  const load = useCallback(
    (offset: number, reset: boolean) => {
      const t = ++token.current
      setLoading(true)
      setError(null)
      api.projects.readSession(projectId, sessionId, offset, PAGE).then(
        (page) => {
          if (t !== token.current) return
          setEntries((prev) => (reset ? page.entries : prev.concat(page.entries)))
          setNext(page.nextOffset)
          setSkipped((s) => (reset ? page.skipped : s + page.skipped))
          setLoading(false)
        },
        (e: Error) => {
          if (t !== token.current) return
          setError(e.message)
          setLoading(false)
        }
      )
    },
    [projectId, sessionId]
  )

  useEffect(() => {
    setEntries([])
    setNext(0)
    setSkipped(0)
    load(0, true)
  }, [load])

  const hasThinking = entries.some((e) => e.kind === 'thinking')

  return (
    <div className="tx">
      <div className="tx__bar">
        <span>
          {formatBytes(totalBytes)} on disk. Showing {formatCount(entries.length)} entries
          {next !== null ? ', more below' : ''}.
        </span>
        <span className="tx__bar-spacer" />
        <Chip selected={showThinking} onClick={() => setShowThinking((v) => !v)} disabled={!hasThinking && !showThinking}>
          Show thinking
        </Chip>
      </div>
      {entries.map((e) => (
        <Entry key={e.key} e={e} showThinking={showThinking} />
      ))}
      {error ? (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}
      {!loading && !error && entries.length === 0 ? <p className="tx__foot">No messages in this transcript.</p> : null}
      <div className="tx__foot">
        {loading ? <Spinner size={14} label="Reading transcript" /> : null}
        {next !== null && !loading ? (
          <Button onClick={() => load(next, false)}>Load more</Button>
        ) : null}
        {next === null && !loading && entries.length > 0 ? <span>End of transcript.</span> : null}
        {skipped > 0 ? <span>{formatCount(skipped)} lines could not be shown.</span> : null}
      </div>
    </div>
  )
}
