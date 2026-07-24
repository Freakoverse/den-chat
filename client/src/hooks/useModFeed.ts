/**
 * useModFeed — progressively fetch game mods (kind 31142) from DEG MODS' relays.
 *
 * First batch loads on mount; loadMore() fetches an older batch using an `until`
 * cursor from the oldest event seen, appending + de-duplicating. The consumer
 * paginates over the growing list and calls loadMore() as it nears the end.
 * reachedEnd flips true once a batch returns no new events.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { Event } from 'nostr-tools'
import { fetchEventsFromRelays } from '@/lib/nostr/relay-pool'
import { MOD_KIND, getModRelays, constructModList, type Mod } from '@/lib/mods/modEvent'
import { useModFiltersStore } from '@/stores/modFiltersStore'

const BATCH = 100

export function useModFeed() {
  const [mods, setMods] = useState<Mod[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [reachedEnd, setReachedEnd] = useState(false)

  const rawById = useRef<Map<string, Event>>(new Map())
  const oldest = useRef<number | undefined>(undefined)
  const inFlight = useRef(false)

  // Re-fetch from scratch when the enabled DEG source relays change.
  const degKey = useModFiltersStore((s) => s.degRelays.filter((r) => r.enabled).map((r) => r.url).join(','))

  const ingest = (events: Event[]): number => {
    let added = 0
    for (const ev of events) {
      if (rawById.current.has(ev.id)) continue
      rawById.current.set(ev.id, ev)
      added++
      if (oldest.current === undefined || ev.created_at < oldest.current) oldest.current = ev.created_at
    }
    if (added > 0) setMods(constructModList([...rawById.current.values()]))
    return added
  }

  const fetchBatch = useCallback(async (until?: number): Promise<number> => {
    const filter = { kinds: [MOD_KIND], limit: BATCH, ...(until ? { until } : {}) }
    const events = await fetchEventsFromRelays(getModRelays(), filter).catch(() => [] as Event[])
    return ingest(events)
  }, [])

  // Initial load — and a full reset+refetch whenever the relay set changes.
  useEffect(() => {
    let cancelled = false
    rawById.current = new Map()
    oldest.current = undefined
    setMods([])
    setReachedEnd(false)
    setLoading(true)
    fetchBatch().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [fetchBatch, degKey])

  const loadMore = useCallback(async () => {
    if (inFlight.current || reachedEnd || loading) return
    inFlight.current = true
    setLoadingMore(true)
    try {
      const added = await fetchBatch(oldest.current ? oldest.current - 1 : undefined)
      if (added === 0) setReachedEnd(true)
    } finally {
      inFlight.current = false
      setLoadingMore(false)
    }
  }, [fetchBatch, reachedEnd, loading])

  return { mods, loading, loadingMore, reachedEnd, loadMore }
}
