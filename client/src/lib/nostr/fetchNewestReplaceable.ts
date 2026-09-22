/**
 * fetchNewestReplaceable: the latest version of someone else's addressable event.
 *
 * `fetchReplaceable` asks the client relays and keeps the newest of whatever answers within the
 * timeout. For another user's packs (emoji, sticker, GIF sets) that misses the relays the author
 * actually writes to: a subscriber would keep seeing a 19-sticker copy after the author published
 * the 20th. This asks the client relays, the user's own NIP-65 relays and the author's advertised
 * relays in one query and takes the newest `created_at` across all of them.
 */
import type { Event } from 'nostr-tools'
import { fetchEventsFromRelays, fetchReplaceable, getRelays } from '@/lib/nostr/relay-pool'
import { useUserListsStore } from '@/stores/userListsStore'
import { discoverRecipientRelays } from '@/lib/nostr/relayDiscovery'

export async function fetchNewestReplaceable(pubkey: string, kind: number, dTag: string): Promise<Event | null> {
  const client = getRelays()
  const mine = useUserListsStore.getState().userRelays
  let authors: string[] = []
  try { authors = await discoverRecipientRelays(pubkey, [...client, ...mine]) } catch { /* best-effort */ }
  const relays = [...new Set([...client, ...mine, ...authors].map((r) => r.replace(/\/+$/, '')))]
  const filter = { authors: [pubkey], kinds: [kind], '#d': [dTag], limit: 1 }
  let events: Event[] = []
  try { events = await fetchEventsFromRelays(relays, filter) } catch { events = [] }
  if (events.length === 0) return fetchReplaceable(pubkey, kind, dTag)
  return events.reduce((newest, e) => (e.created_at > newest.created_at ? e : newest))
}
