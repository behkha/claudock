import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ScreenId } from '@shared/nav'
import { ConfirmDialog } from '@/components/ConfirmDialog'

/** Props every screen receives. `selectId` is set when arriving from the command palette. */
export interface ScreenProps {
  selectId?: string
}

interface NavValue {
  screen: ScreenId
  selectId: string | undefined
  /** Bumps on every navigate() so selecting the same target twice still counts as a new request. */
  seq: number
  /** Goes to `screen`, asking first when a screen has registered unsaved edits with `useNavGuard`. */
  navigate: (screen: ScreenId, selectId?: string) => void
  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
}

const NavContext = createContext<NavValue | null>(null)
const GuardContext = createContext<Set<{ current: boolean }> | null>(null)

type Target = { screen: ScreenId; selectId?: string; seq: number }

export function NavProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<Target>({ screen: 'overview', seq: 0 })
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [pending, setPending] = useState<Omit<Target, 'seq'> | null>(null)
  const seqRef = useRef(0)
  const guards = useRef(new Set<{ current: boolean }>()).current

  const navigate = useCallback(
    (screen: ScreenId, selectId?: string) => {
      const dirty = [...guards].some((g) => g.current)
      if (dirty) setPending({ screen, selectId })
      else setState({ screen, selectId, seq: ++seqRef.current })
    },
    [guards]
  )
  const value = useMemo<NavValue>(
    () => ({ screen: state.screen, selectId: state.selectId, seq: state.seq, navigate, paletteOpen, setPaletteOpen }),
    [state, navigate, paletteOpen]
  )
  return (
    <GuardContext.Provider value={guards}>
      <NavContext.Provider value={value}>
        {children}
        <ConfirmDialog
          open={pending !== null}
          title="Leave without saving?"
          description="Your unsaved edits on this screen will be lost."
          confirmLabel="Leave"
          cancelLabel="Stay"
          tone="danger"
          onConfirm={() => {
            if (pending) setState({ ...pending, seq: ++seqRef.current })
            setPending(null)
          }}
          onCancel={() => setPending(null)}
        />
      </NavContext.Provider>
    </GuardContext.Provider>
  )
}

export function useNav(): NavValue {
  const v = useContext(NavContext)
  if (!v) throw new Error('useNav outside NavProvider')
  return v
}

/** Marks the current screen as having unsaved edits while `dirty` is true, so navigating away asks first. */
export function useNavGuard(dirty: boolean): void {
  const guards = useContext(GuardContext)
  const ref = useRef({ current: dirty })
  ref.current.current = dirty
  useEffect(() => {
    if (!guards) return
    const g = ref.current
    guards.add(g)
    return () => {
      guards.delete(g)
    }
  }, [guards])
}
