import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StorageEntry, StorageSize } from '@shared/api/storage'
import { api, useEvent } from '@/lib/api'

let seq = 0
const newScanId = (): string => `scan-${Date.now().toString(36)}-${++seq}`

export interface FolderState {
  /** Direct children of the folder; folders show `bytes: null` until the scan reports them. */
  entries: StorageEntry[]
  /** True until the first listing is back. */
  loading: boolean
  /** True while sizes are still streaming in. */
  scanning: boolean
  error: string | null
  /** Run the listing and scan again, bypassing the size cache. */
  reload: () => void
}

/**
 * List a folder at once, then stream the recursive size of each child (`storage:sizes`).
 * `rel` is relative to the config dir; '' is the config dir itself. Shared by Overview and Storage.
 */
export function useFolder(rel: string): FolderState {
  const [entries, setEntries] = useState<StorageEntry[]>([])
  const [sizes, setSizes] = useState<Record<string, StorageSize>>({})
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState(0)
  const scanRef = useRef<string>('')

  useEvent('storage:sizes', (p) => {
    if (p.scanId !== scanRef.current || p.items.length === 0) return
    setSizes((prev) => {
      const next = { ...prev }
      for (const it of p.items) next[it.rel] = it
      return next
    })
  })

  useEffect(() => {
    let alive = true
    const scanId = newScanId()
    scanRef.current = scanId
    setLoading(true)
    setScanning(true)
    setError(null)
    setSizes({})
    api.storage.children(rel).then(
      (list) => {
        if (!alive) return
        setEntries(list)
        setLoading(false)
      },
      (e: Error) => {
        if (!alive) return
        setError(e.message)
        setEntries([])
        setLoading(false)
      }
    )
    api.storage.scan(rel, scanId, run > 0).then(
      (all) => {
        if (!alive) return
        setSizes(Object.fromEntries(all.map((s) => [s.rel, s])))
        setScanning(false)
      },
      (e: Error) => {
        if (!alive) return
        setError((prev) => prev ?? e.message)
        setScanning(false)
      }
    )
    return () => {
      alive = false
      void api.storage.cancel(scanId)
    }
  }, [rel, run])

  const merged = useMemo(
    () =>
      entries.map((e) => {
        const s = sizes[e.rel]
        return s ? { ...e, bytes: s.bytes, files: s.files } : e
      }),
    [entries, sizes]
  )

  const reload = useCallback(() => setRun((n) => n + 1), [])
  return { entries: merged, loading, scanning, error, reload }
}
