/**
 * useJoinRequestCount — Lightweight hook for creator-only join request badge count
 *
 * Opens a real-time relay subscription for kind 36944 events on the hub's
 * relays, so new join requests appear immediately in the badge count.
 *
 * On mount, performs a one-shot fetch to populate the initial count, then
 * keeps a persistent subscription open to increment on new events.
 *
 * Uses localStorage key `den-join-requests-seen:<hubDTag>` to persist the
 * "last seen" timestamp across sessions.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchEventsFromRelays } from '@/lib/nostr/relay-pool'
import { subscribeToRelays } from '@/lib/nostr/relay-pool'
import { KINDS } from '@/lib/crypto/constants'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import type { HubData, HubMember } from '@/stores/hubStore'

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
  // Track known pubkeys to avoid double-counting from initial fetch + subscription overlap
  const knownPubkeysRef = useRef<Map<string, number>>(new Map())
  const hubRelays = hub ? [...hub.generalRelays] : []

  // Initial fetch to populate count
  const fetchInitial = useCallback(async () => {
    if (!hub || !isCreator) return
    if (hubRelays.length === 0) return

    try {
      const lastSeen = getLastSeen(hub.dTag)
      const filter: any = {
        kinds: [KINDS.JOIN_REQUEST],
        '#d': [hub.dTag],
        limit: 500,
      }
      if (lastSeen > 0) {
        filter.since = lastSeen
      }

      const events = await fetchEventsFromRelays(hubRelays, filter)

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
      const known = new Map<string, number>()
      for (const r of byPubkey.values()) {
        if (r.pubkey === hub.creatorPubkey) continue
        if (memberPubkeys.has(r.pubkey)) continue
        if (hub.joinMinPow > 0 && r.powBits < hub.joinMinPow) continue
        if (lastSeen > 0 && r.createdAt <= lastSeen) continue
        pending++
        known.set(r.pubkey, r.createdAt)
      }

      knownPubkeysRef.current = known
      setCount(pending)
    } catch (err) {
      console.warn('[useJoinRequestCount] Failed to fetch:', err)
    }
  }, [hub?.dTag, hubRelays.length, hub?.creatorPubkey, hub?.joinMinPow, hubMembers?.length, isCreator])

  // Main effect: initial fetch + live subscription
  useEffect(() => {
    if (!isCreator || !hub) {
      setCount(0)
      return
    }
    if (hubRelays.length === 0) return

    // Initial fetch
    fetchInitial()

    // Open persistent subscription for new join requests
    const lastSeen = getLastSeen(hub.dTag)
    const subFilter: any = {
      kinds: [KINDS.JOIN_REQUEST],
      '#d': [hub.dTag],
    }
    // Only subscribe for events newer than what we've seen
    if (lastSeen > 0) {
      subFilter.since = lastSeen
    }

    const memberPubkeys = new Set((hubMembers || []).map(m => m.pubkey))

    const sub = subscribeToRelays(
      hubRelays,
      subFilter,
      (event) => {
        // Skip rescinded
        const isDeleted = event.tags?.some((t: string[]) => t[0] === 'deleted' && t[1] === 'true')
        if (isDeleted) return

        // Skip creator and existing members
        if (event.pubkey === hub.creatorPubkey) return
        if (memberPubkeys.has(event.pubkey)) return

        // Skip if below join PoW requirement
        if (hub.joinMinPow > 0 && countLeadingZeroBits(event.id) < hub.joinMinPow) return

        // Skip if before lastSeen
        if (lastSeen > 0 && event.created_at <= lastSeen) return

        // Check if this pubkey is already counted (dedup with initial fetch)
        const known = knownPubkeysRef.current
        const existingTs = known.get(event.pubkey)
        if (existingTs !== undefined) {
          // We already counted this pubkey — only update if this event is newer
          if (event.created_at <= existingTs) return
          // Update timestamp but don't increment count
          known.set(event.pubkey, event.created_at)
          return
        }

        // New request from a new pubkey
        known.set(event.pubkey, event.created_at)
        setCount(prev => prev + 1)
      },
    )

    return () => {
      sub.close()
    }
  }, [hub?.dTag, hubRelays.length, hub?.creatorPubkey, hub?.joinMinPow, hubMembers?.length, isCreator])

  // Listen for "seen" event (same-tab: custom event, cross-tab: storage event)
  useEffect(() => {
    if (!hub) return

    const handleSeen = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail === hub.dTag) {
        setCount(0)
        knownPubkeysRef.current.clear()
      }
    }
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_PREFIX + hub.dTag) {
        setCount(0)
        knownPubkeysRef.current.clear()
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
