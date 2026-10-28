import { useEffect, useRef, useState } from 'react'
import { ErrorBoundary, ToastProvider, useToast } from '@/components'
import { api, useEvent } from '@/lib/api'
import { NavProvider, useNav } from '@/lib/nav'
import { Shell } from '@/shell/Shell'

export default function App(): JSX.Element {
  return (
    <ToastProvider>
      <NavProvider>
        <ProfileShell />
      </NavProvider>
    </ToastProvider>
  )
}

/**
 * The window shows one profile: when another one opens (the title bar, the menu bar), every screen starts again on its
 * folder, on the screen that was showing.
 */
function ProfileShell(): JSX.Element {
  const { screen, navigate, whenClean } = useNav()
  const toast = useToast()
  const open = useRef<string | null>(null)
  const [gen, setGen] = useState(0)
  useEffect(() => void api.profiles.get().then((s) => void (open.current ??= s.open), () => undefined), [])
  useEvent('profiles:changed', (s) => {
    if (open.current === s.open) return
    open.current = s.open
    setGen((g) => g + 1)
  })
  // a selection on the old folder means nothing on the new one. After the remount, so the old screen's unsaved-edits
  // guard (already answered before opening the profile) is gone and doesn't ask again.
  const shown = useRef(screen)
  shown.current = screen
  useEffect(() => {
    if (gen) navigate(shown.current)
  }, [gen, navigate])
  // the menu bar asks the window, so unsaved edits are asked about first
  useEvent('profiles:request', ({ id }) => whenClean(() => void api.profiles.open(id).catch((e: Error) => toast(e.message, { kind: 'error' }))))
  return (
    <ErrorBoundary scope="app" key={gen}>
      <Shell />
    </ErrorBoundary>
  )
}
