/**
 * hubTieResolve — resolve a same-created_at hub-event collision toward the most-recent real edit.
 *
 * Two hub events can land at the identical created_at (the prev+1 edit rule + two writers). Relays and
 * every client converge on the NIP-01 canonical one (newest created_at, then LOWEST id — §6.1), which is
 * deterministic but arbitrary: it may not be the edit the owner made most recently. This runs ONLY for the
 * owner (only they can sign a hub event): if the event with the higher `updated_at` (real edit time) lost
 * the lowest-id coin-flip, the owner re-publishes THAT event verbatim at created_at = max+1, so it wins by
 * created_at — which relays DO honor — instead of by a client-side updated_at preference (which would only
 * diverge, since relays ignore the tag). No `updated_at` on either side ⇒ fall back to lowest-id (no-op).
 *
 * Idempotent / convergent: two owner devices produce the SAME bytes at the same created_at ⇒ same id ⇒
 * deduped; and it's a no-op once the higher-updated_at event is already canonical (or there's no tie).
 */
import type { HubData } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'
import type { Event, UnsignedEvent } from 'nostr-tools'
import { ChatContext } from '@/lib/crypto/skd'
import { makeSubkeySigner, mineAndSignAsSubkey } from '@/lib/nostr/v2send'

const updatedAtOf = (e: { tags: string[][] }): number =>
  parseInt(e.tags.find((t) => t[0] === 'updated_at')?.[1] || '0', 10) || 0

export async function resolveHubEventUpdatedAtTie(
  hub: HubData,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<void> {
  const author = hub.creatorPubkey
  const { fetchEvents, publishWithFailover, getRelays } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
  const { KINDS } = await import('@/lib/crypto/constants')

  const events = await fetchEvents(
    { kinds: [KINDS.HUB_EVENT], authors: [author], '#d': [hub.dTag], limit: 8 },
    2000, // short cap — never stall a load on this best-effort resolve
  )
  if (events.length < 2) return

  const maxCreatedAt = Math.max(...events.map((e) => e.created_at))
  const atMax = events.filter((e) => e.created_at === maxCreatedAt)
  if (atMax.length < 2) return // no tie at the newest created_at

  const canonical = atMax.reduce((a, b) => (a.id < b.id ? a : b)) // NIP-01 lowest id — what relays retain
  const winner = atMax.reduce((a, b) => (updatedAtOf(b) > updatedAtOf(a) ? b : a)) // most-recent real edit
  if (winner.id === canonical.id) return // the newest edit already won the coin-flip
  if (updatedAtOf(winner) <= updatedAtOf(canonical)) return // no updated_at advantage → leave lowest-id

  // Re-publish the winner VERBATIM (its own content + tags, including its updated_at) at max+1, re-signed by
  // the owner, so it supersedes both colliding events by created_at.
  const unsigned: UnsignedEvent = {
    kind: KINDS.HUB_EVENT,
    content: winner.content,
    tags: winner.tags as UnsignedEvent['tags'],
    created_at: maxCreatedAt + 1,
    pubkey: author,
  }

  const { isV2 } = await import('@/lib/hub/version')
  let signed: Event
  if (isV2(hub)) {
    const ownerSigner = makeSubkeySigner(ChatContext.owner(hub.dTag), { privateKey, signer })
    signed = await mineAndSignAsSubkey(unsigned, hub.minPow > 0 ? hub.minPow : 0, ownerSigner)
  } else {
    const { mineAndSign } = await import('@/lib/nostr/events')
    signed = await mineAndSign(unsigned, hub.minPow, author, signer, privateKey)
  }

  const targeted = getPublishRelays([...hub.generalRelays])
  await publishWithFailover(signed, targeted, { pool: [...hub.generalRelays, ...getRelays()] })
  console.log(
    `[HubTieResolve] ${hub.dTag.slice(0, 12)}…: republished the higher-updated_at event at ${maxCreatedAt + 1} to resolve a same-created_at tie`,
  )
}
