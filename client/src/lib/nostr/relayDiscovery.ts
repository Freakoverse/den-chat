/**
 * Relay Discovery — Discover a recipient's preferred relays for DM delivery
 *
 * Combines three relay sources:
 * 1. NIP-65 relay list (kind 10002) — user's general relay preferences
 * 2. DM relay list (kind 10050) — user's preferred DM relays
 * 3. DNN-discovered relays — from verified DNN ID metadata (kind 63600)
 *
 * Used by both NIP-04 and NIP-17 DM sending to maximize delivery probability.
 */

import { fetchEvents } from '@/lib/nostr/relay-pool'
import { fetchEventsWide } from '@/lib/nostr/readRelays'
import { STANDARD_KINDS } from '@/lib/crypto/constants'

/** TTL for cached relay discovery results (5 minutes) */
const RELAY_CACHE_TTL_MS = 5 * 60 * 1000

/** Cache of discovered network relays keyed by recipient pubkey */
const relayCache = new Map<string, { relays: string[]; ts: number }>()

/** A peer's kind-10050 DM relay list exactly as published (deduped, may legitimately be empty). */
export interface DMRelayListInfo {
  relays: string[]
  createdAt: number
}

const dmRelayListCache = new Map<string, { info: DMRelayListInfo | null; ts: number }>()

/**
 * Fetch a peer's kind-10050 DM relay list for DISPLAY — the "do they have a 10050, and does it
 * have relays" pill in the NIP-17 chat header. Distinct from discoverRecipientRelays (which folds
 * 10050 into the send set): this preserves the difference between "no list at all" (`null`) and
 * "a list with zero relays" (`{ relays: [] }`), which is exactly what the user needs to see to
 * understand why a spec-strict client can or can't reach this person.
 *
 * Reads across client + own NIP-65 relays (fetchEventsWide) so a list published from another
 * client has a fair chance of being found. `force` bypasses the 5-minute cache.
 */
export async function fetchDMRelayList(
  pubkey: string,
  opts?: { force?: boolean },
): Promise<DMRelayListInfo | null> {
  const cached = dmRelayListCache.get(pubkey)
  if (!opts?.force && cached && Date.now() - cached.ts < RELAY_CACHE_TTL_MS) return cached.info

  let info: DMRelayListInfo | null = null
  try {
    const events = await fetchEventsWide({ kinds: [STANDARD_KINDS.DM_RELAY_LIST], authors: [pubkey], limit: 1 })
    const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0]
    if (latest) {
      const seen = new Set<string>()
      const relays: string[] = []
      for (const tag of latest.tags) {
        if (tag[0] !== 'relay' || !tag[1]) continue
        const norm = tag[1].replace(/\/+$/, '').toLowerCase()
        if (seen.has(norm)) continue
        seen.add(norm)
        relays.push(tag[1])
      }
      info = { relays, createdAt: latest.created_at }
    }
  } catch {
    // Network failure: don't cache a "not found" we didn't actually establish
    return cached?.info ?? null
  }

  dmRelayListCache.set(pubkey, { info, ts: Date.now() })
  return info
}

/**
 * Discover a recipient's preferred relays from NIP-65, DM relay list, and DNN metadata.
 * Returns relay URLs that are NOT already in `existingRelays`.
 *
 * @param recipientPubkey - The pubkey of the DM recipient
 * @param existingRelays - Relays already in the publish set (to avoid duplicates)
 * @returns Array of newly discovered relay URLs
 */
export async function discoverRecipientRelays(
  recipientPubkey: string,
  existingRelays: string[],
): Promise<string[]> {
  const existingSet = new Set(existingRelays.map((r) => r.replace(/\/$/, '')))
  const discovered = new Set<string>()

  // Check cache for recent network-discovered relays
  const cached = relayCache.get(recipientPubkey)
  if (cached && Date.now() - cached.ts < RELAY_CACHE_TTL_MS) {
    // Use cached network relays (skip network fetch)
    for (const relay of cached.relays) {
      const url = relay.replace(/\/$/, '')
      if (!existingSet.has(url)) discovered.add(relay)
    }

    // DNN lookup is local — always run even on cache hit
    try {
      const { useDnnStore } = await import('@/stores/dnnStore')
      const dnnRelays = useDnnStore.getState().getRelaysForPubkey(recipientPubkey)
      for (const relay of dnnRelays) {
        const url = relay.replace(/\/$/, '')
        if (!existingSet.has(url)) discovered.add(relay)
      }
    } catch {
      // DNN store not available — skip
    }

    return Array.from(discovered)
  }

  // Track all network-discovered relays (before filtering) for caching
  const networkDiscovered = new Set<string>()

  try {
    // Fetch NIP-65 relay list and DM relay list in parallel
    const [relayListEvents, dmRelayListEvents] = await Promise.allSettled([
      fetchEvents({ kinds: [STANDARD_KINDS.RELAY_LIST], authors: [recipientPubkey], limit: 1 }),
      fetchEvents({ kinds: [STANDARD_KINDS.DM_RELAY_LIST], authors: [recipientPubkey], limit: 1 }),
    ])

    // Parse NIP-65 relay list (kind 10002): tags are ['r', 'wss://...', 'read'|'write'|'']
    if (relayListEvents.status === 'fulfilled' && relayListEvents.value.length > 0) {
      const event = relayListEvents.value[0]
      for (const tag of event.tags) {
        if (tag[0] === 'r' && tag[1]) {
          networkDiscovered.add(tag[1])
          const url = tag[1].replace(/\/$/, '')
          if (!existingSet.has(url)) discovered.add(tag[1])
        }
      }
    }

    // Parse DM relay list (kind 10050): tags are ['relay', 'wss://...']
    if (dmRelayListEvents.status === 'fulfilled' && dmRelayListEvents.value.length > 0) {
      const event = dmRelayListEvents.value[0]
      for (const tag of event.tags) {
        if (tag[0] === 'relay' && tag[1]) {
          networkDiscovered.add(tag[1])
          const url = tag[1].replace(/\/$/, '')
          if (!existingSet.has(url)) discovered.add(tag[1])
        }
      }
    }
  } catch {
    // Non-fatal — return whatever we found so far
  }

  // Cache all network-discovered relays (before existingRelays filtering)
  if (networkDiscovered.size > 0) {
    relayCache.set(recipientPubkey, { relays: Array.from(networkDiscovered), ts: Date.now() })
  }

  // DNN-discovered relays (from verified DNN ID metadata)
  try {
    const { useDnnStore } = await import('@/stores/dnnStore')
    const dnnRelays = useDnnStore.getState().getRelaysForPubkey(recipientPubkey)
    for (const relay of dnnRelays) {
      const url = relay.replace(/\/$/, '')
      if (!existingSet.has(url)) discovered.add(relay)
    }
  } catch {
    // DNN store not available — skip
  }

  return Array.from(discovered)
}
