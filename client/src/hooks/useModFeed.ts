/**
 * useModFeed — progressively fetch game mods (kind 31142) from the mod relays.
 *
 * First batch loads on mount; loadMore() fetches an older batch using an `until`
 * cursor from the oldest event seen, appending + de-duplicating. The consumer
 * paginates over the growing list and calls loadMore() as it nears the end.
 * reachedEnd flips true once a batch returns no new events.
 *
 * Deletion is a DUAL mechanism (matches DEG MODS): a re-publish with `deleted=true`
 * AND a NIP-09 kind-5 request. A relay that honours the kind-5 drops the whole
 * coordinate — so the `deleted=true` version never reaches us and a stale copy from
 * a non-honouring relay would slip through. So we also fetch the kind-5 deletions
 * for the coordinates we've loaded and suppress those, not just the deleted tag.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { Event } from 'nostr-tools'
import { fetchEventsFromRelays } from '@/lib/nostr/relay-pool'
import { MOD_KIND, getModRelays, constructModList, type Mod } from '@/lib/mods/modEvent'
import { useModFiltersStore } from '@/stores/modFiltersStore'

const BATCH = 100
const DELETE_KIND = 5

export function useModFeed() {
  const [mods, setMods] = useState<Mod[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [reachedEnd, setReachedEnd] = useState(false)

  const rawById = useRef<Map<string, Event>>(new Map())
  const deletedCoords = useRef<Set<string>>(new Set())
  const checkedCoords = useRef<Set<string>>(new Set())
  const oldest = useRef<number | undefined>(undefined)
  const inFlight = useRef(false)

  // Re-fetch from scratch when the enabled DEG source relays change.
  const degKey = useModFiltersStore((s) => s.degRelays.filter((r) => r.enabled).map((r) => r.url).join(','))

  const recompute = useCallback(() => {
    const list = constructModList([...rawById.current.values()]).filter((m) => !deletedCoords.current.has(m.aTag))
    setMods(list)
  }, [])

  const ingest = (events: Event[]): number => {
    let added = 0
    for (const ev of events) {
      if (rawById.current.has(ev.id)) continue
      rawById.current.set(ev.id, ev)
      added++
      if (oldest.current === undefined || ev.created_at < oldest.current) oldest.current = ev.created_at
    }
    if (added > 0) recompute()
    return added
  }

  /** Fetch kind-5 deletions for any coordinates we haven't checked yet. */
  const checkDeletions = useCallback(async (coords: string[]) => {
    const toCheck = coords.filter((c) => !checkedCoords.current.has(c))
    if (toCheck.length === 0) return
    toCheck.forEach((c) => checkedCoords.current.add(c))
    const events = await fetchEventsFromRelays(getModRelays(), { kinds: [DELETE_KIND], '#a': toCheck }).catch(() => [] as Event[])
    let changed = false
    for (const ev of events) {
      for (const t of ev.tags) {
        if (t[0] !== 'a' || !t[1]) continue
        const [kind, pubkey] = t[1].split(':')
        // A NIP-09 deletion is only valid if authored by the coordinate's owner.
        if (kind === String(MOD_KIND) && pubkey === ev.pubkey && !deletedCoords.current.has(t[1])) {
          deletedCoords.current.add(t[1])
          changed = true
        }
      }
    }
    if (changed) recompute()
  }, [recompute])

  const fetchBatch = useCallback(async (until?: number): Promise<number> => {
    const filter = { kinds: [MOD_KIND], limit: BATCH, ...(until ? { until } : {}) }
    const events = await fetchEventsFromRelays(getModRelays(), filter).catch(() => [] as Event[])
    const added = ingest(events)
    // Verify deletions for the coordinates we just learned about.
    const coords = [...new Set(events.map((e) => `${MOD_KIND}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}`))]
    checkDeletions(coords)
    return added
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkDeletions])

  // Initial load — and a full reset+refetch whenever the relay set changes.
  useEffect(() => {
    let cancelled = false
    rawById.current = new Map()
    deletedCoords.current = new Set()
    checkedCoords.current = new Set()
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
