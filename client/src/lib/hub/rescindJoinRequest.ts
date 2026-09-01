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

  const { isV2 } = await import('@/lib/hub/version')

  const { signer, privateKey } = useUserStore.getState()
  const relays = [...hub.generalRelays]
  const v2 = isV2(hub)
  // v2: hub relays ONLY. The tombstone/deletion are authored by the throwaway `addr` key but name the hub
  // owner O; fanning them out to the user's personal NIP-65 relays would let an observer correlate that
  // addr key → R by relay footprint ("R withdrew a request to private hub X").
  const publishRelays = getDeletePublishRelays(relays, { hubOnly: v2 })

  if (v2) {
    // v2 (§6.3): the real join request was NOT authored under R — it was authored
    // under a throwaway per-hub "join-addr" sub-key (peered on the owner O), with
    // that sub-key's pubkey as its `d`-tag. Rescind under that same sub-key so R
    // never appears as an author, a hub-scoped query filter, or a deletion
    // coordinate. (Signing under R here would also target the wrong coordinate and
    // fail to rescind.)
    const { makeSubkeySigner, mineAndSignAsSubkey } = await import('@/lib/nostr/v2send')
    const { ChatContext } = await import('@/lib/crypto/skd')
    const addrSigner = makeSubkeySigner(ChatContext.joinAddr(hub.dTag), {
      privateKey,
      signer,
      peerPub: hub.creatorPubkey,
    })
    const addrPub = await addrSigner.getPublicKey()

    // Fetch the existing v2 JR (author = addrPub, d = addrPub) to preserve created_at.
    const existing = await fetchEvents({
      kinds: [KINDS.JOIN_REQUEST],
      authors: [addrPub],
      '#d': [addrPub],
      limit: 1,
    })
    const originalCreatedAt = existing.length > 0 ? existing[0].created_at : Math.floor(Date.now() / 1000)

    // 1. Tombstone the JR under its own coordinate (kind:addrPub:addrPub), signed by addrPub. Carry
    //    the hub coordinate (`#a`) too — that's how the request was indexed, and how the creator's
    //    join-request badge watches for it; without it the badge never learns the request was withdrawn.
    const hubCoord = `${KINDS.HUB_EVENT}:${hub.creatorPubkey}:${hub.dTag}`
    const deleted = createDeletedJoinRequest(addrPub, hub.creatorPubkey, originalCreatedAt, hubCoord)
    await publishToSpecificRelays(publishRelays, await mineAndSignAsSubkey(deleted, 0, addrSigner))

    // 2. NIP-09 deletion for that same addressable coordinate, authored by addrPub.
    const aRef = `${KINDS.JOIN_REQUEST}:${addrPub}:${addrPub}`
    const deletionReq = createDeletionEvent([], [aRef], 'rescind join request')
    await publishToSpecificRelays(publishRelays, await mineAndSignAsSubkey(deletionReq, 0, addrSigner))
  } else {
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
  }

  // 3. Remove the hub from the user's list + clear cached messages, then publish
  //    the updated hub list.
  const hubStore = useHubStore.getState()
  const remainingEntries = hubStore.hubEntries.filter((e) => e.dTag !== hub.dTag)
  const currentFolders = hubStore.folders
  hubStore.removeHubEntry(hub.dTag)
  useMessageStore.getState().clearHubData(hub.dTag)
  // Drop any locally-retained tree blobs for this hub — we're no longer keeping it alive.
  void import('@/lib/blossom/hubBlobStore').then((m) => m.dropHubBlobs(hub.dTag)).catch(() => {})
  const { buildHubListEvent, publishHubList } = await import('@/lib/hub/hubListPrivacy')
  const hubListEv = await buildHubListEvent(
    remainingEntries.map((e) => ({ dTag: e.dTag, relayHint: e.relayHint, position: e.position, folderId: e.folderId })),
    currentFolders,
  )
  await publishHubList(await signWithSigner(hubListEv, signer, privateKey)) // failover (see hubListPrivacy)
}
