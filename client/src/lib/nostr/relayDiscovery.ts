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
import { STANDARD_KINDS } from '@/lib/crypto/constants'

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
          const url = tag[1].replace(/\/$/, '')
          if (!existingSet.has(url)) discovered.add(tag[1])
        }
      }
    }
  } catch {
    // Non-fatal — return whatever we found so far
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
