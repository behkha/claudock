import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen } from 'lucide-react'
import type { FileEntry } from '@shared/api/skills'
import { formatBytes } from '@shared/format'
import { IconButton, Spinner } from '@/components'
import { api } from '@/lib/api'

const MAX_ROWS = 300

type Listing = FileEntry[] | 'loading' | { error: string }

/** Lazy file tree of one skill folder: folders load when opened, folder sizes fill in one by one. */
export function FileTree({ skillId, skillRel }: { skillId: string; skillRel: string }): JSX.Element {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [listing, setListing] = useState<Record<string, Listing>>({})
  const [sizes, setSizes] = useState<Record<string, number | 'err'>>({})
  const alive = useRef(true)
  const queue = useRef<string[]>([])
  const running = useRef(0)

  const subOf = (e: FileEntry): string => e.rel.slice(skillRel.length + 1)

  function pump(): void {
    while (running.current < 2 && queue.current.length > 0) {
      const sub = queue.current.shift() as string
      running.current++
      api.skills
        .dirSize(skillId, sub)
        .then((n) => alive.current && setSizes((s) => ({ ...s, [sub]: n })))
        .catch(() => alive.current && setSizes((s) => ({ ...s, [sub]: 'err' })))
        .finally(() => {
          running.current--
          if (alive.current) pump()
        })
    }
  }

  function load(sub: string): void {
    setListing((l) => ({ ...l, [sub]: 'loading' }))
    api.skills
      .files(skillId, sub || undefined)
      .then((entries) => {
        if (!alive.current) return
        setListing((l) => ({ ...l, [sub]: entries }))
        for (const e of entries) if (e.isDir) queue.current.push(subOf(e))
        pump()
      })
      .catch((e: Error) => alive.current && setListing((l) => ({ ...l, [sub]: { error: e.message } })))
  }

  useEffect(() => {
    alive.current = true
    load('')
    return () => {
      alive.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId])

  function toggle(sub: string): void {
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(sub)) n.delete(sub)
      else {
        n.add(sub)
        if (!listing[sub]) load(sub)
      }
      return n
    })
  }

  function rows(sub: string, depth: number): JSX.Element[] {
    const l = listing[sub]
    if (l === undefined || l === 'loading') {
      return [
        <li key={`${sub}:loading`} className="ext-tree__note" style={{ paddingLeft: 16 + depth * 18 }}>
          <Spinner size={12} /> Loading
        </li>
      ]
    }
    if (!Array.isArray(l)) {
      return [
        <li key={`${sub}:err`} className="ext-tree__note ext-error" style={{ paddingLeft: 16 + depth * 18 }}>
          {l.error}
        </li>
      ]
    }
    if (l.length === 0) {
      return [
        <li key={`${sub}:empty`} className="ext-tree__note" style={{ paddingLeft: 16 + depth * 18 }}>
          Empty folder
        </li>
      ]
    }
    const out: JSX.Element[] = []
    for (const e of l.slice(0, MAX_ROWS)) {
      const s = subOf(e)
      const isOpen = e.isDir && open.has(s)
      const size = e.isDir ? sizes[s] : e.size
      out.push(
        <li key={e.rel} className="ext-tree__row" style={{ paddingLeft: 12 + depth * 18 }}>
          {e.isDir ? (
            <button type="button" className="ext-tree__main" aria-expanded={isOpen} onClick={() => toggle(s)}>
              <span className="ext-tree__icon">{isOpen ? <ChevronDown size={14} strokeWidth={1.8} /> : <ChevronRight size={14} strokeWidth={1.8} />}</span>
              <span className="ext-tree__icon">{isOpen ? <FolderOpen size={15} strokeWidth={1.8} /> : <Folder size={15} strokeWidth={1.8} />}</span>
              <span className="ext-tree__name">{e.name}</span>
            </button>
          ) : (
            <span className="ext-tree__main" style={{ paddingLeft: 20 }}>
              <span className="ext-tree__icon">
                <FileIcon size={15} strokeWidth={1.8} />
              </span>
              <span className="ext-tree__name">{e.name}</span>
            </span>
          )}
          <span className="ext-tree__size">{size === undefined ? '…' : size === 'err' || size === null ? '—' : formatBytes(size)}</span>
          <IconButton size="sm" aria-label={`Reveal ${e.name}`} icon={<FolderOpen />} onClick={() => void api.system.reveal(e.rel).catch(() => undefined)} />
        </li>
      )
      if (isOpen) out.push(...rows(s, depth + 1))
    }
    if (l.length > MAX_ROWS) {
      out.push(
        <li key={`${sub}:more`} className="ext-tree__note" style={{ paddingLeft: 16 + depth * 18 }}>
          {l.length - MAX_ROWS} more items are not shown. Use Reveal on the folder to see them all.
        </li>
      )
    }
    return out
  }

  return <ul className="ext-tree" role="list" aria-label="Files in this skill">{rows('', 0)}</ul>
}
