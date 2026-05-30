/**
 * useJoinRequestCount — Lightweight hook for creator-only join request badge count
 *
 * Fetches kind 36944 events for the active hub and returns the number of
 * pending (non-member) requests that arrived since the creator last opened
 * the JoinRequestsModal.
 *
 * Uses localStorage key `den-join-requests-seen:<hubDTag>` to persist the
 * "last seen" timestamp across sessions.
 *
 * Polls every 2 minutes to stay reasonably fresh without hammering relays.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import type { HubData, HubMember } from '@/stores/hubStore'

const POLL_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes
const STORAGE_PREFIX = 'den-join-requests-seen:'
const SEEN_EVENT = 'den-join-requests-seen'

/** Get the "last seen" unix timestamp for a hub */
function getLastSeen(hubDTag: string): number {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + hubDTag)
    if (raw) return parseInt(raw, 10) || 0
  } catch { /* ignore */ }
  return 0
}

/**
 * Mark join requests as seen (set to current unix timestamp).
 * Dispatches a custom DOM event so same-tab hooks reset immediately.
 */
export function markJoinRequestsSeen(hubDTag: string) {
  try {
    localStorage.setItem(STORAGE_PREFIX + hubDTag, String(Math.floor(Date.now() / 1000)))
  } catch { /* ignore */ }
  // Notify same-tab listeners
  window.dispatchEvent(new CustomEvent(SEEN_EVENT, { detail: hubDTag }))
}

export function useJoinRequestCount(
  hub: HubData | null,
  hubMembers: HubMember[] | undefined,
  isCreator: boolean,
): number {
  const [count, setCount] = useState(0)
  const fetchingRef = useRef(false)

  const fetchCount = useCallback(async () => {
    if (!hub || !isCreator || fetchingRef.current) return
    if (!hub.generalRelays.length) return

    fetchingRef.current = true
    try {
      const lastSeen = getLastSeen(hub.dTag)
      const filter: any = {
        kinds: [KINDS.JOIN_REQUEST],
        '#d': [hub.dTag],
        limit: 500,
      }
      // Only fetch events since last seen (or all if never seen)
      if (lastSeen > 0) {
        filter.since = lastSeen
      }

      const events = await fetchEvents(filter)

      // Deduplicate: one per pubkey, keep latest
      // Skip events that carry the ["deleted", "true"] marker (rescinded requests)
      const byPubkey = new Map<string, { pubkey: string; createdAt: number; powBits: number }>()
      for (const e of events) {
        const isDeleted = e.tags?.some((t: string[]) => t[0] === 'deleted' && t[1] === 'true')
        if (isDeleted) continue

        const existing = byPubkey.get(e.pubkey)
        if (existing && existing.createdAt > e.created_at) continue
        byPubkey.set(e.pubkey, {
          pubkey: e.pubkey,
          createdAt: e.created_at,
          powBits: countLeadingZeroBits(e.id),
        })
      }

      // Filter out creator and existing members
      const memberPubkeys = new Set((hubMembers || []).map(m => m.pubkey))
      let pending = 0
      for (const r of byPubkey.values()) {
        if (r.pubkey === hub.creatorPubkey) continue
        if (memberPubkeys.has(r.pubkey)) continue
        if (hub.minPow > 0 && r.powBits < hub.minPow) continue
        // Only count events created AFTER lastSeen
        if (lastSeen > 0 && r.createdAt <= lastSeen) continue
        pending++
      }

      setCount(pending)
    } catch (err) {
      console.warn('[useJoinRequestCount] Failed to fetch:', err)
    } finally {
      fetchingRef.current = false
    }
  }, [hub?.dTag, hub?.generalRelays?.length, hub?.creatorPubkey, hub?.minPow, hubMembers?.length, isCreator])

  useEffect(() => {
    if (!isCreator || !hub) {
      setCount(0)
      return
    }

    // Initial fetch
    fetchCount()

    // Poll
    const interval = setInterval(fetchCount, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchCount, isCreator, hub?.dTag])

  // Listen for "seen" event (same-tab: custom event, cross-tab: storage event)
  useEffect(() => {
    if (!hub) return

    const handleSeen = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail === hub.dTag) {
        setCount(0)
      }
    }
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_PREFIX + hub.dTag) {
        setCount(0)
      }
    }

    window.addEventListener(SEEN_EVENT, handleSeen)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(SEEN_EVENT, handleSeen)
      window.removeEventListener('storage', handleStorage)
    }
  }, [hub?.dTag])

  return count
}
