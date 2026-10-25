import { useEffect, useRef, useState } from 'react'
import { useNav } from './nav'

export function useDebounced<T>(value: T, ms = 150): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/**
 * Selection state that follows the `selectId` prop a screen receives from the command palette / navigation.
 *   const [selected, setSelected] = useSelectId(props.selectId)
 */
export function useSelectId(selectId: string | undefined): [string | undefined, (id: string | undefined) => void] {
  const { seq } = useNav()
  const [sel, setSel] = useState<string | undefined>(selectId)
  const prev = useRef(selectId)
  useEffect(() => {
    // `seq` changes on every navigate(), so choosing the same palette result again re-applies it
    if (selectId !== undefined || prev.current !== undefined) setSel(selectId)
    prev.current = selectId
  }, [selectId, seq])
  return [sel, setSel]
}

/** True while `ms` has not yet elapsed since `active` became true (avoids spinner flashes). */
export function useDelayed(active: boolean, ms = 200): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!active) return setOn(false)
    const t = setTimeout(() => setOn(true), ms)
    return () => clearTimeout(t)
  }, [active, ms])
  return on
}
