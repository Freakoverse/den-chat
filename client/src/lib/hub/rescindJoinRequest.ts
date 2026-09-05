import type { HubData } from '@/stores/hubStore'

/**
 * Publish steps 1+2 of a rescind — tombstone the join request (kind 36944 re-published with a
 * `deleted` marker) then a NIP-09 deletion request for it — WITHOUT leaving the hub.
 *
 * v1: authored under the user's real key R. v2 (§6.3): the request was authored under a throwaway
 * per-hub "join-addr" sub-key (peered on the owner O), with that sub-key's pubkey as its `d`-tag, so
 * we rescind under that SAME sub-key — R never appears as author, hub-scoped filter, or deletion
 * coordinate. Signing under R here would also target the wrong coordinate and fail to rescind.
 *
 * When `requireLive` is true, no-ops (returns false) unless a non-tombstoned join request actually
 * exists — so an auto-clean after admission never emits a spurious tombstone for a request that was
 * never made (invited/added members) or was already withdrawn. Returns true iff it published.
 */
async function emitJoinRequestDeletion(hub: HubData, pubkey: string, requireLive: boolean): Promise<boolean> {
  const { fetchEvents, publishCriticalWithFailover } = await import('@/lib/nostr/relay-pool')
  const { getDeletePublishRelays } = await import('@/stores/postingBehaviourStore')
  const { createDeletedJoinRequest, createDeletionEvent } = await import('@/lib/nostr/events')
  const { signWithSigner } = await import('@/lib/nostr')
  const { KINDS } = await import('@/lib/crypto/constants')
  const { useUserStore } = await import('@/stores/userStore')
  const { isV2 } = await import('@/lib/hub/version')

  const { signer, privateKey } = useUserStore.getState()
  const relays = [...hub.generalRelays]
  const v2 = isV2(hub)
  // v2: hub relays ONLY. The tombstone/deletion are authored by the throwaway `addr` key but name the
  // hub owner O; fanning them out to the user's personal NIP-65 relays would let an observer correlate
  // that addr key → R by relay footprint ("R withdrew a request to private hub X").
  const publishRelays = getDeletePublishRelays(relays, { hubOnly: v2 })

  const isTombstoned = (tags: string[][]) => tags?.some((t) => t[0] === 'deleted' && t[1] === 'true')

  if (v2) {
    // v2 (§6.3): the real join request was NOT authored under R — it was authored under a throwaway
    // per-hub "join-addr" sub-key (peered on the owner O). Rescind under that same sub-key.
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
    if (requireLive && (existing.length === 0 || isTombstoned(existing[0].tags))) return false
    const originalCreatedAt = existing.length > 0 ? existing[0].created_at : Math.floor(Date.now() / 1000)

    // 1. Tombstone the JR under its own coordinate (kind:addrPub:addrPub), signed by addrPub. Carry
    //    the hub coordinate (`#a`) too — that's how the request was indexed, and how the creator's
    //    join-request badge watches for it; without it the badge never learns the request was withdrawn.
    const hubCoord = `${KINDS.HUB_EVENT}:${hub.creatorPubkey}:${hub.dTag}`
    const deleted = createDeletedJoinRequest(addrPub, hub.creatorPubkey, originalCreatedAt, hubCoord)
    await publishCriticalWithFailover(await mineAndSignAsSubkey(deleted, 0, addrSigner), publishRelays, relays)

    // 2. NIP-09 deletion for that same addressable coordinate, authored by addrPub.
    const aRef = `${KINDS.JOIN_REQUEST}:${addrPub}:${addrPub}`
    const deletionReq = createDeletionEvent([], [aRef], 'rescind join request')
    await publishCriticalWithFailover(await mineAndSignAsSubkey(deletionReq, 0, addrSigner), publishRelays, relays)
  } else {
    // Fetch the existing join request to preserve its created_at.
    const existing = await fetchEvents({
      kinds: [KINDS.JOIN_REQUEST],
      authors: [pubkey],
      '#d': [hub.dTag],
      limit: 1,
    })
    if (requireLive && (existing.length === 0 || isTombstoned(existing[0].tags))) return false
    const originalCreatedAt = existing.length > 0 ? existing[0].created_at : Math.floor(Date.now() / 1000)

    // 1. Re-publish the join request with a deleted marker (created_at + 1).
    const deleted = createDeletedJoinRequest(hub.dTag, hub.creatorPubkey, originalCreatedAt)
    await publishCriticalWithFailover(await signWithSigner(deleted, signer, privateKey), publishRelays, relays)

    // 2. NIP-09 deletion request for the addressable join-request coordinate.
    const aRef = `${KINDS.JOIN_REQUEST}:${pubkey}:${hub.dTag}`
    const deletionReq = createDeletionEvent([], [aRef], 'rescind join request')
    await publishCriticalWithFailover(await signWithSigner(deletionReq, signer, privateKey), publishRelays, relays)
  }
  return true
}

/**
 * Withdraw ("rescind") the current user's pending join request for a hub AND leave the hub:
 *   1. re-publish the join request tombstoned (kind 36944 with a deleted marker),
 *   2. send a NIP-09 deletion request for it,
 *   3. remove the hub from the user's hub list (kind 16942) and clear its cached
 *      messages on this device.
 *
 * Shared by the channel list's "Rescind Join Request" button and the
 * awaiting-approval overlay so both do exactly the same thing.
 */
export async function rescindJoinRequest(hub: HubData, pubkey: string): Promise<void> {
  const { signWithSigner } = await import('@/lib/nostr')
  const { useUserStore } = await import('@/stores/userStore')
  const { useHubStore } = await import('@/stores/hubStore')
  const { useMessageStore } = await import('@/stores/messageStore')

  // 1 + 2: tombstone + NIP-09 deletion of the join request (always, for an explicit withdraw).
  await emitJoinRequestDeletion(hub, pubkey, false)

  // 3. Remove the hub from the user's list + clear cached messages, then publish
  //    the updated hub list.
  const { signer, privateKey } = useUserStore.getState()
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

/**
 * Auto-clean a now-redundant join request AFTER the user has been admitted as a real hub member:
 * publishes only the tombstone + NIP-09 deletion (steps 1+2 above) and NEVER leaves the hub. No-ops
 * (returns false) if there is no live join request to delete.
 *
 * MUST be called only once ACTUAL membership is confirmed (the owner-tree decrypt path) — never for
 * merely-facilitated access, which is not membership in the creator's roster.
 */
export async function tombstoneOwnJoinRequest(hub: HubData, pubkey: string): Promise<boolean> {
  return emitJoinRequestDeletion(hub, pubkey, true)
}
