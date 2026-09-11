/**
 * requestHubDeletion — publish a deletion REQUEST for a hub the caller created/owns.
 *
 * This is the exact two-step delete used by the in-hub Settings → Security page, extracted so the
 * Settings → My Hubs list can trigger the identical flow. Publishing only — the caller updates local
 * state (hub status, active hub, closing UI) afterward.
 *
 * Steps:
 *   1. Re-publish the hub event with a ["deleted","true"] tag (addressable replaceable overwrite),
 *      PoW-mined to the hub's message PoW so PoW-enforcing relays accept it. On v2 it's signed as the
 *      owner pseudonym O (a root-signed event would be a different addressable event, not a replace).
 *   2. A NIP-09 kind-5 deletion request as a fallback, signed by the hub event's author (O on v2, R on
 *      v1) — relays only honor a deletion from the target's author, and an R_owner-signed kind-5 on v2
 *      would publicly link R_owner → O, deanonymizing the owner.
 *
 * Both publish fire-once to EVERY delete relay (not failover): a delete only takes effect on a relay
 * that actually receives the tombstone, so it must reach them all — a relay still holding the original
 * keeps serving the hub otherwise.
 */
import type { HubData } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'
import { signWithSigner, mineAndSign, createUnsignedEvent } from '@/lib/nostr'
import { publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { getDeletePublishRelays } from '@/stores/postingBehaviourStore'
import { KINDS } from '@/lib/crypto/constants'

export async function requestHubDeletion(
  hub: HubData,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<void> {
  // 1. Re-publish hub event with deleted tag. eventCreatedAt + 1 keeps it from jumping in timeline.
  const deleteCreatedAt = hub.eventCreatedAt ? hub.eventCreatedAt + 1 : undefined
  const deletedHubEvent = createUnsignedEvent(KINDS.HUB_EVENT, '', [
    ['d', hub.dTag],
    ['n', hub.name],
    ['epoch', hub.epoch.toString()],
    ['deleted', 'true'],
  ] as [string, ...string[]][], deleteCreatedAt)

  let signedDeletedHub
  const { isV2 } = await import('@/lib/hub/version')
  const v2Delete = isV2(hub)
  let ownerSigner: any = null
  if (v2Delete) {
    const { makeSubkeySigner, mineAndSignAsSubkey } = await import('@/lib/nostr/v2send')
    const { ChatContext } = await import('@/lib/crypto/skd')
    ownerSigner = makeSubkeySigner(ChatContext.owner(hub.dTag), { privateKey, signer })
    signedDeletedHub = await mineAndSignAsSubkey(deletedHubEvent, hub.minPow, ownerSigner)
  } else {
    signedDeletedHub = await mineAndSign(deletedHubEvent, hub.minPow, hub.creatorPubkey, signer, privateKey)
  }
  await publishToSpecificRelays(getDeletePublishRelays([...hub.generalRelays]), signedDeletedHub)

  // 2. NIP-09 kind-5 deletion request (fallback), signed as the hub event's author.
  const deleteEvent = createUnsignedEvent(5, 'Hub deletion requested', [
    ['a', `36942:${hub.creatorPubkey}:${hub.dTag}`],
  ] as [string, ...string[]][])

  const signedDelete = v2Delete && ownerSigner
    ? await ownerSigner.signEvent(deleteEvent)
    : await signWithSigner(deleteEvent, signer, privateKey)
  await publishToSpecificRelays(getDeletePublishRelays([...hub.generalRelays]), signedDelete)
}
