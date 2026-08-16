/**
 * readRelays — the read-side relay set for social content, blogs, and DMs.
 *
 * The core primitives fetchEvents/subscribeEvents default to CLIENT relays only
 * (getRelays()). That's fine for hub loading (which adds the hub's own relays) but
 * means social posts, long-form articles, comments, reactions/zaps and DMs are only
 * read back from client relays — never from the user's NIP-65 relays, even though
 * they're published there. This mirrors what the mod feed already does
 * (getModRelays = DEG + client + user), minus the DEG-specific relays.
 *
 * getReadRelays() = client relays + user (NIP-65) relays, deduped. Use the
 * fetchEventsWide / subscribeEventsWide wrappers for content reads that should span
 * both lists. (Profiles, follow/mute lists, hub loading and startup checks
 * deliberately keep using the client-only primitives.)
 */

import { getRelays, fetchEventsFromRelays, subscribeToRelays } from './relay-pool'
import { useUserListsStore } from '@/stores/userListsStore'
import type { Event, Filter } from 'nostr-tools'

/** Client relays + user (NIP-65) relays, deduped (trailing slashes normalised). */
export function getReadRelays(): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (url: string) => {
    const norm = url.replace(/\/+$/, '')
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(url) }
  }
  for (const r of getRelays()) add(r)
  for (const r of useUserListsStore.getState().userRelays) add(r)
  return out
}

/** One-shot fetch across client + user relays. */
export function fetchEventsWide(filter: Filter | Filter[]): Promise<Event[]> {
  return fetchEventsFromRelays(getReadRelays(), filter)
}

/** Real-time subscription across client + user relays. */
export function subscribeEventsWide(
  filter: Filter,
  onEvent: (event: Event) => void,
  onEose?: () => void,
): { close: () => void } {
  return subscribeToRelays(getReadRelays(), filter, onEvent, onEose)
}
