import { useEffect } from 'react'
import { ErrorBoundary } from '@/components'
import { isMac, useEvent } from '@/lib/api'
import { useNav } from '@/lib/nav'
import { useThemeSync } from '@/lib/theme'
import { SCREEN_COMPONENTS } from '@/screens/registry'
import { CommandPalette } from './CommandPalette'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'

export function Shell(): JSX.Element {
  const { screen, selectId, navigate, paletteOpen, setPaletteOpen } = useNav()
  useThemeSync()
  useEvent('system:navigate', (p) => navigate(p.screen, p.id))
  useEvent('system:openPalette', () => setPaletteOpen(true))

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
    document.documentElement.setAttribute('data-app-ready', '')
  }, [])

  const Screen = SCREEN_COMPONENTS[screen]
  return (
    <div className="app">
      <TitleBar />
      <Sidebar />
      <main className="main" id="main">
        <ErrorBoundary key={screen}>
          <Screen selectId={selectId} />
        </ErrorBoundary>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
