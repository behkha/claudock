import { useCallback, useEffect, useRef, useState } from 'react'
import type { Finding } from '@shared/api/overview'
import { api, useEvent } from '@/lib/api'

let seq = 0

export interface FindingsState {
  findings: Finding[]
  /** True until the scan has looked at everything. Findings already found are shown meanwhile. */
  scanning: boolean
  error: string | null
  rescan: () => void
}

/** The cleanup findings, shared by Overview and Storage. They stream in one by one. */
export function useFindings(): FindingsState {
  const [findings, setFindings] = useState<Finding[]>([])
  const [scanning, setScanning] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState(0)
  const scanRef = useRef('')

  useEvent('overview:finding', (p) => {
    if (p.scanId !== scanRef.current) return
    setFindings((prev) => (prev.some((f) => f.id === p.finding.id) ? prev : [...prev, p.finding]))
  })

  useEffect(() => {
    let alive = true
    const scanId = `find-${Date.now().toString(36)}-${++seq}`
    scanRef.current = scanId
    setScanning(true)
    setError(null)
    if (run > 0) setFindings([])
    api.overview.findings(scanId, run > 0).then(
      (list) => {
        if (!alive) return
        setFindings(list)
        setScanning(false)
      },
      (e: Error) => {
        if (!alive) return
        setError(e.message)
        setScanning(false)
      }
    )
    return () => {
      alive = false
    }
  }, [run])

  const rescan = useCallback(() => setRun((n) => n + 1), [])
  return { findings, scanning, error, rescan }
}
