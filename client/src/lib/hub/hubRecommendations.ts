/**
 * Hub recommendations (Discover). A user publishes a PUBLIC NIP-78 list (kind 30078, d-tag
 * `den-hub-recommendations`) of hubs they vouch for, one `a` tag per hub:
 *   ["a", "36942:<hubCreatorPubkey>:<dTag>", "<relayHint>"]
 * The list is authored by the user's real key R (a personal list, like the follow/hub lists) and read back
 * by their followers (the Discover "Follows" tab) and by trusted-source curation (the "Perspective" tab).
 * Plaintext on purpose: the whole point is that others can read what you recommend.
 */

import type { Event, UnsignedEvent } from 'nostr-tools'
import { STANDARD_KINDS, KINDS, APP_DATA_DTAGS } from '@/lib/crypto/constants'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import { fetchReplaceable } from '@/lib/nostr/relay-pool'
import { fetchEventsWide } from '@/lib/nostr/readRelays'
import { publishPersonal } from '@/stores/postingBehaviourStore'
import type { ISigner } from '@/stores/userStore'

const DTAG = APP_DATA_DTAGS.HUB_RECOMMENDATIONS

export interface HubRecRef {
  coord: string       // "36942:<pubkey>:<dTag>"
  pubkey: string      // the hub's on-wire author (O in v2, R in v1)
  dTag: string
  relayHint?: string
}

/** Build the "36942:<pubkey>:<dTag>" coordinate for a hub. */
export function hubCoord(pubkey: string, dTag: string): string {
  return `${KINDS.HUB_EVENT}:${pubkey}:${dTag}`
}

/** Parse a coordinate string into a ref, or null if it isn't a hub-event coordinate. */
export function parseHubCoord(coord: string, relayHint?: string): HubRecRef | null {
  const i1 = coord.indexOf(':')
  const i2 = coord.indexOf(':', i1 + 1)
  if (i1 < 0 || i2 < 0) return null
  if (parseInt(coord.slice(0, i1), 10) !== KINDS.HUB_EVENT) return null
  const pubkey = coord.slice(i1 + 1, i2)
  const dTag = coord.slice(i2 + 1) // d-tags can contain ':'; keep the remainder intact
  if (!pubkey || !dTag) return null
  return { coord, pubkey, dTag, relayHint: relayHint || undefined }
}

/** Build an unsigned kind-30078 recommendation event from refs (deduped by coord, order preserved). */
export function buildHubRecommendationEvent(refs: HubRecRef[]): UnsignedEvent {
  const seen = new Set<string>()
  const tags: string[][] = [['d', DTAG]]
  for (const r of refs) {
    if (seen.has(r.coord)) continue
    seen.add(r.coord)
    tags.push(r.relayHint ? ['a', r.coord, r.relayHint] : ['a', r.coord])
  }
  return createUnsignedEvent(STANDARD_KINDS.APP_DATA, '', tags)
}

/** Extract hub refs from a recommendation event's `a` tags (deduped, non-hub coords ignored). */
export function parseHubRecommendationRefs(event: Event): HubRecRef[] {
  const out: HubRecRef[] = []
  const seen = new Set<string>()
  for (const t of event.tags) {
    if (t[0] !== 'a' || !t[1]) continue
    const ref = parseHubCoord(t[1], t[2])
    if (!ref || seen.has(ref.coord)) continue
    seen.add(ref.coord)
    out.push(ref)
  }
  return out
}

/** The current user's own recommendation list (newest replaceable). `createdAt` is the event's
 *  timestamp (0 when none is found), used to drive version-aware redundancy. */
export async function fetchMyRecommendations(myPubkey: string): Promise<{ refs: HubRecRef[]; createdAt: number }> {
  const ev = await fetchReplaceable(myPubkey, STANDARD_KINDS.APP_DATA, DTAG)
  return { refs: ev ? parseHubRecommendationRefs(ev) : [], createdAt: ev?.created_at ?? 0 }
}

/** Recommendation refs from a set of authors (newest per author), deduped across authors by coord. */
export async function fetchRecommendationRefs(authors: string[]): Promise<HubRecRef[]> {
  if (authors.length === 0) return []
  const events = await fetchEventsWide({ kinds: [STANDARD_KINDS.APP_DATA], authors, '#d': [DTAG] })
  const newest = new Map<string, Event>()
  for (const e of events) {
    const prev = newest.get(e.pubkey)
    if (!prev || e.created_at > prev.created_at) newest.set(e.pubkey, e)
  }
  const seen = new Set<string>()
  const out: HubRecRef[] = []
  for (const e of newest.values()) {
    for (const ref of parseHubRecommendationRefs(e)) {
      if (seen.has(ref.coord)) continue
      seen.add(ref.coord)
      out.push(ref)
    }
  }
  return out
}

/** Sign + publish the user's full recommendation list (personal, R-authored, failover publish).
 *  Returns the published event's `created_at` so callers can track the latest version. */
export async function publishHubRecommendations(
  refs: HubRecRef[],
  signer: ISigner | null,
  privateKey: string | null,
): Promise<number> {
  const signed = await signWithSigner(buildHubRecommendationEvent(refs), signer, privateKey)
  await publishPersonal(signed)
  return signed.created_at
}
