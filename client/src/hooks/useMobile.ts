/**
 * useMobile — Reactive mobile breakpoint hook
 *
 * Returns `true` when the viewport is ≤ 1080px wide.
 * Uses matchMedia with a listener so it reacts to window resizing.
 */
import { useState, useEffect } from 'react'

const MOBILE_BREAKPOINT = 1080
const query = `(max-width: ${MOBILE_BREAKPOINT}px)`

export function useMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener('change', handler)
    // Sync on mount in case SSR value differs
    setIsMobile(mql.matches)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return isMobile
}
