import type { HubData } from '@/stores/hubStore'

/**
 * Minimum age of a pending join request before it may be resent. A creator's "seen" watermark can
 * advance past an old request (Unseen view is best-effort, not perfectly contiguous); resending
 * bumps `created_at` to now so it re-surfaces above the watermark. The 3-day floor stops bump-spam.
 */
export const RESEND_MIN_AGE_S = 3 * 24 * 3600

/** The addr-subkey pubkey that authors / d-tags a v2 join request (peered on the owner O). */
async function v2AddrPub(hub: HubData, privateKey: string | null, signer: import('@/stores/userStore').ISigner | null): Promise<string> {
  const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
  const { ChatContext } = await import('@/lib/crypto/skd')
  const addrSigner = makeSubkeySigner(ChatContext.joinAddr(hub.dTag), { privateKey, signer, peerPub: hub.creatorPubkey })
  return addrSigner.getPublicKey()
}

/**
 * The `created_at` of the user's current (non-tombstoned) join request for `hub`, or null if there
 * isn't a live one. v1 keys on R + `#d:dTag`; v2 on the addr sub-key (author + `#d`). Used to gate
 * the "Resend" button (only after RESEND_MIN_AGE_S).
 */
export async function getOwnJoinRequestCreatedAt(hub: HubData, pubkey: string): Promise<number | null> {
  const { fetchEventsFromRelays, getRelays } = await import('@/lib/nostr/relay-pool')
  const { KINDS } = await import('@/lib/crypto/constants')
  const { isV2 } = await import('@/lib/hub/version')
  const { useUserStore } = await import('@/stores/userStore')
  const isTombstoned = (tags: string[][]) => tags?.some((t) => t[0] === 'deleted' && t[1] === 'true')
  // Query hub relays PLUS client relays: v2 requests publish to hub relays ONLY, so `fetchEvents`
  // (client relays) alone would miss them and the Resend button would never appear.
  const relays = [...new Set([...hub.generalRelays, ...getRelays()])]
  try {
    if (isV2(hub)) {
      const { signer, privateKey } = useUserStore.getState()
      const addrPub = await v2AddrPub(hub, privateKey, signer)
      const evs = await fetchEventsFromRelays(relays, { kinds: [KINDS.JOIN_REQUEST], authors: [addrPub], '#d': [addrPub], limit: 1 })
      const e = evs[0]
      return e && !isTombstoned(e.tags) ? e.created_at : null
    }
    const evs = await fetchEventsFromRelays(relays, { kinds: [KINDS.JOIN_REQUEST], authors: [pubkey], '#d': [hub.dTag], limit: 1 })
    const e = evs[0]
    return e && !isTombstoned(e.tags) ? e.created_at : null
  } catch {
    return null
  }
}

/**
 * Re-publish the user's join request with a fresh `created_at` (now), replacing the previous one
 * (same d-tag), so an inactive creator sees it again above their "seen" watermark. v1 signs under R;
 * v2 rebuilds the sealed request under a fresh ephemeral + the addr sub-key. Does NOT itself enforce
 * RESEND_MIN_AGE_S — the caller gates on it.
 */
export async function resendJoinRequest(hub: HubData, pubkey: string): Promise<void> {
  const { publishCriticalWithFailover } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
  const { isV2 } = await import('@/lib/hub/version')
  const { useUserStore } = await import('@/stores/userStore')

  const { signer, privateKey } = useUserStore.getState()
  const hubRelays = [...hub.generalRelays]
  const v2 = isV2(hub)

  let signed
  if (v2) {
    const { buildV2JoinRequest } = await import('@/lib/hub/v2join')
    const { KINDS } = await import('@/lib/crypto/constants')
    const coord = `${KINDS.HUB_EVENT}:${hub.creatorPubkey}:${hub.dTag}`
    signed = await buildV2JoinRequest({
      hubDTag: hub.dTag, ownerPub: hub.creatorPubkey, coord,
      joinPow: hub.joinMinPow || 0, rPub: pubkey, privateKey, signer,
    })
  } else {
    const { createJoinRequest } = await import('@/lib/nostr/events')
    const { mineAndSign } = await import('@/lib/nostr')
    const unsigned = createJoinRequest(hub.dTag, hub.creatorPubkey)
    signed = await mineAndSign(unsigned, hub.joinMinPow || 0, pubkey, signer, privateKey)
  }
  // v2: hub relays ONLY (see the correlation note in the join/rescind paths). v1: hub + personal.
  await publishCriticalWithFailover(signed, getPublishRelays(hubRelays, { hubOnly: v2 }), hubRelays)
}
