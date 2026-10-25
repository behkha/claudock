import { useMemo } from 'react'
import { diffLines } from 'diff'
import { cx } from '@/lib/cx'

export interface DiffViewProps {
  before: string
  after: string
  beforeLabel?: string
  afterLabel?: string
  /** Unchanged lines kept around each change; longer runs collapse. Default 3. */
  context?: number
  className?: string
}

type Row =
  | { kind: 'add' | 'del' | 'same'; text: string; a?: number; b?: number }
  | { kind: 'skip'; count: number }

function build(before: string, after: string, context: number): { rows: Row[]; added: number; removed: number } {
  const parts = diffLines(before, after)
  const flat: Row[] = []
  let a = 1
  let b = 1
  let added = 0
  let removed = 0
  for (const p of parts) {
    const lines = p.value.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    for (const text of lines) {
      if (p.added) {
        flat.push({ kind: 'add', text, b: b++ })
        added++
      } else if (p.removed) {
        flat.push({ kind: 'del', text, a: a++ })
        removed++
      } else flat.push({ kind: 'same', text, a: a++, b: b++ })
    }
  }
  // collapse long unchanged runs
  const rows: Row[] = []
  for (let i = 0; i < flat.length; ) {
    if (flat[i].kind !== 'same') {
      rows.push(flat[i++])
      continue
    }
    let j = i
    while (j < flat.length && flat[j].kind === 'same') j++
    const run = flat.slice(i, j)
    const head = i === 0 ? 0 : context
    const tail = j === flat.length ? 0 : context
    if (run.length > head + tail + 1) {
      rows.push(...run.slice(0, head), { kind: 'skip', count: run.length - head - tail }, ...run.slice(run.length - tail))
    } else rows.push(...run)
    i = j
  }
  return { rows, added, removed }
}

/** Unified line diff with line numbers and collapsed context. */
export function DiffView({ before, after, beforeLabel, afterLabel, context = 3, className }: DiffViewProps): JSX.Element {
  const { rows, added, removed } = useMemo(() => build(before, after, context), [before, after, context])
  const unchanged = added === 0 && removed === 0
  return (
    <figure className={cx('diff selectable', className)}>
      <figcaption className="diff__caption">
        <span>
          {beforeLabel ?? 'Before'} <span aria-hidden>→</span> {afterLabel ?? 'After'}
        </span>
        <span className="diff__stat">
          <span className="diff__stat--add">+{added}</span> <span className="diff__stat--del">−{removed}</span>
        </span>
      </figcaption>
      {unchanged ? (
        <p className="diff__empty">No differences.</p>
      ) : (
        <div className="diff__scroll" role="table" aria-label={`Diff: ${beforeLabel ?? 'before'} to ${afterLabel ?? 'after'}`}>
          {rows.map((r, i) =>
            r.kind === 'skip' ? (
              <div key={i} className="diff__row diff__row--skip" role="row">
                {r.count} unchanged line{r.count === 1 ? '' : 's'}
              </div>
            ) : (
              <div key={i} className={cx('diff__row', `diff__row--${r.kind}`)} role="row">
                <span className="diff__no" aria-hidden>
                  {r.a ?? ''}
                </span>
                <span className="diff__no" aria-hidden>
                  {r.b ?? ''}
                </span>
                <span className="diff__sign" aria-label={r.kind === 'add' ? 'added' : r.kind === 'del' ? 'removed' : 'unchanged'}>
                  {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}
                </span>
                <span className="diff__text">{r.text || ' '}</span>
              </div>
            )
          )}
        </div>
      )}
    </figure>
  )
}
