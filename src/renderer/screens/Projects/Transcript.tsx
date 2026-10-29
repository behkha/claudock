import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, Terminal, Wrench } from 'lucide-react'
import type { SessionPage, TranscriptEntry } from '@shared/api/projects'
import { formatBytes, formatCount } from '@shared/format'
import { Button, Chip, MarkdownView, Spinner } from '@/components'
import './transcript.css'

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

interface TranscriptProps {
  /** Names the transcript: a new value starts over from the top. */
  source: string
  /** Reads one page from a byte offset (Projects' file, or the session archive's). */
  read: (offset: number, limit: number) => Promise<SessionPage>
  totalBytes: number
  /**
   * Byte offset of a line to open at (a search hit), marked and scrolled into view. Past the first page the transcript
   * starts at that line instead, with the start one click away, so a hit deep in a huge transcript loads one page.
   */
  focusOffset?: number
}

/** Streams a transcript in pages of 200 entries. Never holds more than what the user asked to see. */
export function Transcript({ source, read, totalBytes, focusOffset }: TranscriptProps): JSX.Element {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [next, setNext] = useState<number | null>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState(0)
  const [showThinking, setShowThinking] = useState(false)
  const token = useRef(0)
  const reader = useRef(read)
  reader.current = read
  const root = useRef<HTMLDivElement>(null)
  /** Where what is shown starts: 0, or the line of a search hit past the first page. */
  const [from, setFrom] = useState(0)
  const jumpedFor = useRef<number | null>(null)
  const scrolledTo = useRef<string | null>(null)

  const load = useCallback(
    (offset: number, reset: boolean) => {
      const t = ++token.current
      setLoading(true)
      setError(null)
      reader.current(offset, PAGE).then(
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
    // `source` names what `read` reads
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source]
  )

  useEffect(() => {
    setEntries([])
    setNext(0)
    setSkipped(0)
    setFrom(0)
    jumpedFor.current = null
    scrolledTo.current = null
    load(0, true)
  }, [load])

  // a search hit that isn't in what is loaded: start at its line
  const focusKey = focusOffset !== undefined && focusOffset >= 0 ? `${focusOffset}:` : null
  const focusIn = focusKey !== null && entries.some((e) => e.key.startsWith(focusKey))
  useEffect(() => {
    if (focusKey === null || focusOffset === undefined || loading || error || focusIn || jumpedFor.current === focusOffset) return
    if (focusOffset >= from && next !== null && next > focusOffset) return
    jumpedFor.current = focusOffset
    setFrom(focusOffset)
    load(focusOffset, true)
  }, [focusKey, focusIn, focusOffset, from, next, loading, error, load])
  useEffect(() => {
    if (!focusIn || focusKey === null || scrolledTo.current === focusKey) return
    scrolledTo.current = focusKey
    root.current?.querySelector(`[data-key^="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: 'center' })
  }, [focusIn, focusKey])

  const hasThinking = entries.some((e) => e.kind === 'thinking')

  return (
    <div className="tx" ref={root}>
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
      {from > 0 && !loading ? (
        <div className="tx__foot">
          <Button
            variant="ghost"
            onClick={() => {
              setFrom(0)
              load(0, true)
            }}
          >
            Show from the start
          </Button>
        </div>
      ) : null}
      {entries.map((e) =>
        focusKey !== null && e.key.startsWith(focusKey) ? (
          <div key={e.key} data-key={e.key} className="tx__focus">
            <Entry e={e} showThinking={showThinking} />
          </div>
        ) : (
          <Entry key={e.key} e={e} showThinking={showThinking} />
        )
      )}
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
