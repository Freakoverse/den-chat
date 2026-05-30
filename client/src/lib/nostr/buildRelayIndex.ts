/**
 * buildRelayIndex — Builds a relay → hubDTags mapping for batched subscriptions
 *
 * Collects all relays (general + filter) from every loaded hub,
 * groups hub dTags by relay URL, and chunks large groups into
 * batches of MAX_DTAGS_PER_SUB to avoid relay filter rejection.
 */

import type { HubData } from '@/stores/hubStore'

/** Max hub dTags per subscription filter to avoid relay rejection */
const MAX_DTAGS_PER_SUB = 50

export interface RelayBatch {
  relay: string
  hubDTags: string[]
}

/**
 * Build relay → hubDTags index from loaded hubs.
 * Returns an array of RelayBatch — one per relay per chunk of ≤50 dTags.
 *
 * If a relay is used by 120 hubs, it produces 3 batches (50, 50, 20).
 */
export function buildRelayIndex(hubs: Record<string, HubData>): RelayBatch[] {
  // Step 1: Build relay → Set<hubDTag>
  const relayMap = new Map<string, Set<string>>()

  for (const [dTag, hub] of Object.entries(hubs)) {
    // Combine general + filter relays (deduplicated per hub)
    const allRelays = new Set([...hub.generalRelays, ...hub.filterRelays])

    for (const relay of allRelays) {
      if (!relay) continue
      const normalized = relay.replace(/\/+$/, '') // strip trailing slashes
      if (!relayMap.has(normalized)) {
        relayMap.set(normalized, new Set())
      }
      relayMap.get(normalized)!.add(dTag)
    }
  }

  // Step 2: Chunk into batches of MAX_DTAGS_PER_SUB
  const batches: RelayBatch[] = []

  for (const [relay, dTagSet] of relayMap) {
    const dTags = Array.from(dTagSet)

    for (let i = 0; i < dTags.length; i += MAX_DTAGS_PER_SUB) {
      batches.push({
        relay,
        hubDTags: dTags.slice(i, i + MAX_DTAGS_PER_SUB),
      })
    }
  }

  return batches
}
