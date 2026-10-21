/**
 * useTimedDismiss: dismiss something for a while, in memory only.
 *
 * The dismissal lives in a module-level map, so it is cleared when the client restarts (the banner re-shows
 * next launch). While the client keeps running, the dismissal auto-expires after `ttlMs` and the component
 * re-renders so the banner re-appears if its condition still holds. Pass a namespaced key (e.g.
 * `relay:<dTag>`) so unrelated banners don't share a dismissal.
 */

import { useEffect, useState } from 'react'

const dismissedAt = new Map<string, number>()

export function useTimedDismiss(key: string, ttlMs: number): { dismissed: boolean; dismiss: () => void } {
  const [, bump] = useState(0)
  const ts = dismissedAt.get(key)
  const dismissed = ts != null && Date.now() - ts < ttlMs

  useEffect(() => {
    if (ts == null) return
    const remaining = ttlMs - (Date.now() - ts)
    if (remaining <= 0) { dismissedAt.delete(key); bump((n) => n + 1); return }
    const t = setTimeout(() => { dismissedAt.delete(key); bump((n) => n + 1) }, remaining)
    return () => clearTimeout(t)
  }, [key, ts, ttlMs])

  const dismiss = () => { dismissedAt.set(key, Date.now()); bump((n) => n + 1) }
  return { dismissed, dismiss }
}
