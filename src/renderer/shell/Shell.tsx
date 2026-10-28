import { useCallback, useEffect, useRef, useState } from 'react'
import { ErrorBoundary } from '@/components'
import { api, isMac, useApi, useEvent } from '@/lib/api'
import { useNav } from '@/lib/nav'
import { useThemeSync } from '@/lib/theme'
import { SCREEN_COMPONENTS } from '@/screens/registry'
import { CommandPalette } from './CommandPalette'
import { Reveal } from './Reveal'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'

export function Shell(): JSX.Element {
  const { screen, selectId, seq, navigate, paletteOpen, setPaletteOpen } = useNav()
  useThemeSync()
  useEvent('system:navigate', (p) => navigate(p.screen, p.id))
  useEvent('system:openPalette', () => setPaletteOpen(true))

  // The first-run reveal takes the window until it is left: by its buttons, or by any navigation (the palette, the menu
  // bar), which then goes where it was asked to. Worked out while rendering, and nothing else renders until main has
  // answered, so Today never mounts (and starts its scans) underneath it.
  const first = useApi(() => api.system.firstRun(), [])
  const [left, setLeft] = useState(false)
  const [forced, setForced] = useState(false)
  const revealing = !left && (first.data === true || forced)
  const revealSeq = useRef(seq)
  useEvent('system:reveal', () => {
    setForced(true)
    setLeft(false)
  })
  const leaveReveal = useCallback(() => {
    setLeft(true)
    setForced(false)
    // a failed write only means the reveal shows once more next launch
    void api.system.finishFirstRun().catch(() => undefined)
  }, [])
  // leaving puts focus on the screen that takes its place, not on <body> where the pressed button was
  const wasRevealing = useRef(false)
  useEffect(() => {
    if (wasRevealing.current && !revealing) document.getElementById('main')?.focus()
    wasRevealing.current = revealing
  }, [revealing])
  useEffect(() => {
    if (!revealing) return
    // shown on demand: it starts at this seq. On first launch it counts from the first render, so a navigation that
    // came in while main was answering (a notification click) still goes where it was asked to.
    if (forced) revealSeq.current = seq
    else if (seq !== revealSeq.current) leaveReveal()
    // only when the reveal starts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealing])
  useEffect(() => {
    if (revealing && seq !== revealSeq.current) leaveReveal()
    // only on a navigation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])
  const answered = !first.loading || first.data !== undefined

  useEffect(() => {
    const mac = isMac()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() === 'k' && (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        setPaletteOpen(!paletteOpen)
      } else if (e.key === 'Escape' && paletteOpen) {
        setPaletteOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [paletteOpen, setPaletteOpen])

  useEffect(() => {
    if (answered) document.documentElement.setAttribute('data-app-ready', '')
  }, [answered])

  const Screen = SCREEN_COMPONENTS[screen]
  return (
    <div className="app">
      <TitleBar />
      {!answered ? null : revealing ? (
        <ErrorBoundary key="reveal" onError={leaveReveal}>
          <Reveal onDone={leaveReveal} />
        </ErrorBoundary>
      ) : (
        <>
          <Sidebar />
          <main className="main" id="main" tabIndex={-1}>
            <ErrorBoundary key={screen}>
              <Screen selectId={selectId} />
            </ErrorBoundary>
          </main>
        </>
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
