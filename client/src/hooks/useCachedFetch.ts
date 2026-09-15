/**
 * useCachedFetch — one-shot async load with a module-level result cache, for the inline
 * "referenced event" cards (note / article / comment / live activity / game mod / hub message…).
 *
 * Why: those cards used to hold their own useState + useEffect around fetchEvents. Two problems:
 *  1. A card that re-mounts (message list re-render, scroll virtualisation, tab switch) started from
 *     scratch — "Loading…" flash, then a fresh relay round-trip for an event it had already shown.
 *  2. Any effect that depended on a `relays` array from nip19.decode re-ran on EVERY parent render
 *     (new array identity each time), producing the loading → card → loading loop the game-mod card had.
 *
 * `key` must be a stable string that fully identifies the load (kind + coordinate, or event id — and
 * the relay hints if they change what's fetched). The loader runs once per key; a non-null result is
 * cached forever for the session, a null (not found) is NOT cached so a later mount can retry.
 */

import { useEffect, useState } from 'react'

const cache = new Map<string, unknown>()

/** Seed the cache — e.g. a short address resolved to an event the kind-specific card would otherwise refetch. */
export function primeCachedFetch<T>(key: string, value: T): void {
  cache.set(key, value)
}

export function useCachedFetch<T>(key: string, load: () => Promise<T | null>): { data: T | null; loading: boolean } {
  const cached = cache.has(key) ? (cache.get(key) as T) : null
  const [data, setData] = useState<T | null>(cached)
  const [loading, setLoading] = useState(!cache.has(key))

  useEffect(() => {
    if (cache.has(key)) {
      setData(cache.get(key) as T)
      setLoading(false)
      return
    }
    let alive = true
    setData(null)
    setLoading(true)
    load()
      .then((result) => {
        if (result !== null && result !== undefined) cache.set(key, result)
        if (alive) setData(result ?? null)
      })
      .catch(() => { /* not found / relay error — caller renders its fallback */ })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // `load` is a fresh closure each render by design; the key is the identity of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { data, loading }
}
