import type { HubData } from '@/stores/hubStore'

/**
 * Withdraw ("rescind") the current user's pending join request for a hub:
 *   1. re-publish the join request tombstoned (kind 36944 with a deleted marker),
 *   2. send a NIP-09 deletion request for it,
 *   3. remove the hub from the user's hub list (kind 16942) and clear its cached
 *      messages on this device.
 *
 * Shared by the channel list's "Rescind Join Request" button and the
 * awaiting-approval overlay so both do exactly the same thing.
 */
export async function rescindJoinRequest(hub: HubData, pubkey: string): Promise<void> {
  const { fetchEvents, publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays, getDeletePublishRelays } = await import('@/stores/postingBehaviourStore')
  const { createDeletedJoinRequest, createDeletionEvent, createHubListEvent } = await import('@/lib/nostr/events')
  const { signWithSigner } = await import('@/lib/nostr')
  const { KINDS } = await import('@/lib/crypto/constants')
  const { useUserStore } = await import('@/stores/userStore')
  const { useHubStore } = await import('@/stores/hubStore')
  const { useMessageStore } = await import('@/stores/messageStore')

  const { signer, privateKey } = useUserStore.getState()
  const relays = [...hub.generalRelays]
  const publishRelays = getDeletePublishRelays(relays)

  // Fetch the existing join request to preserve its created_at.
  const existing = await fetchEvents({
    kinds: [KINDS.JOIN_REQUEST],
    authors: [pubkey],
    '#d': [hub.dTag],
    limit: 1,
  })
  const originalCreatedAt = existing.length > 0 ? existing[0].created_at : Math.floor(Date.now() / 1000)

  // 1. Re-publish the join request with a deleted marker (created_at + 1).
  const deleted = createDeletedJoinRequest(hub.dTag, hub.creatorPubkey, originalCreatedAt)
  await publishToSpecificRelays(publishRelays, await signWithSigner(deleted, signer, privateKey))

  // 2. NIP-09 deletion request for the addressable join-request coordinate.
  const aRef = `${KINDS.JOIN_REQUEST}:${pubkey}:${hub.dTag}`
  const deletionReq = createDeletionEvent([], [aRef], 'rescind join request')
  await publishToSpecificRelays(publishRelays, await signWithSigner(deletionReq, signer, privateKey))

  // 3. Remove the hub from the user's list + clear cached messages, then publish
  //    the updated hub list.
  const hubStore = useHubStore.getState()
  const remainingEntries = hubStore.hubEntries.filter((e) => e.dTag !== hub.dTag)
  const currentFolders = hubStore.folders
  hubStore.removeHubEntry(hub.dTag)
  useMessageStore.getState().clearHubData(hub.dTag)
  const hubListEv = createHubListEvent(
    remainingEntries.map((e) => ({ dTag: e.dTag, relayHint: e.relayHint, position: e.position, folderId: e.folderId })),
    currentFolders,
  )
  await publishToSpecificRelays(getPublishRelays(), await signWithSigner(hubListEv, signer, privateKey))
}
