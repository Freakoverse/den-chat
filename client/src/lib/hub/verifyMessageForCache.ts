/**
 * Cache-admission gate for hub messages (anti-junk-pollution).
 *
 * A v2 message passes a CHEAP stage-1 ingest check (does it carry an `identity` tag at all?) but is only
 * VERIFIED at display time (stage 2 — decrypt the `identity` attestation with the members-only channel key
 * and check the member's signature). An outsider can attach a garbage `identity` tag to a `#h`-tagged event
 * and pass stage 1, so — without this gate — that junk is written to IndexedDB on every online member's
 * device before stage 2 ever drops it (a cheap-outsider-event → per-member store+disk-write amplification).
 *
 * This gate runs stage 2 BEFORE persisting: on a v2 hub a message is cacheable only if its attestation
 * verifies. An outsider can't forge a valid attestation (no channel key), so their junk never reaches the
 * durable cache. v1 messages (no attestation) and unknown/not-yet-loaded hubs cache as before; a v2 message
 * whose channel key isn't loaded yet is NOT persisted (don't cache the unverifiable — it stays in the
 * in-memory store and is re-evaluated on display).
 */

import type { ChatMessage } from '@/stores/messageStore'
import { useHubStore } from '@/stores/hubStore'
import { isV2 } from '@/lib/hub/version'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { fromHex } from '@/lib/crypto/lkh'
import { verifyEventIdentity } from '@/lib/nostr/identity'
import { cacheMessageWithDedup } from '@/lib/cache/messageCache'

/**
 * Derive a channel's message key straight from the store (no hook). Mirrors useMessages.getChannelKey's
 * group-vs-hub + epoch-history resolution so verification uses the exact key the message was encrypted with.
 */
export function channelKeyFromStore(hubDTag: string, channelId: string, epoch: number): Uint8Array | null {
  const state = useHubStore.getState()
  const hub = state.hubs[hubDTag]
  if (!hub) return null

  const channel = hub.channels.find((c) => c.channelId === channelId)
  let groupId: string | null = null
  if (channel?.encryption) groupId = channel.encryption
  else if (channel?.synced && channel.categoryId) {
    const cat = hub.categories.find((c) => c.categoryId === channel.categoryId)
    if (cat?.encryption) groupId = cat.encryption
  }

  let secretHex: string | undefined
  let useEpoch = epoch
  if (groupId) {
    const currentGroupEpoch = hub.groupedRoles?.find((g) => g.groupId === groupId)?.epoch || 1
    if (epoch === currentGroupEpoch) secretHex = state.groupSecrets[hubDTag]?.[groupId]
    else {
      secretHex = state.groupEpochSecrets[hubDTag]?.[groupId]?.[epoch]
      if (!secretHex) { secretHex = state.groupSecrets[hubDTag]?.[groupId]; useEpoch = currentGroupEpoch }
    }
  } else {
    const currentEpoch = hub.epoch || 1
    if (epoch === currentEpoch) secretHex = state.hubSecrets[hubDTag]
    else {
      secretHex = state.epochSecrets[hubDTag]?.[epoch]
      if (!secretHex) { secretHex = state.hubSecrets[hubDTag]; useEpoch = currentEpoch }
    }
  }
  if (!secretHex) return null
  return deriveChannelKey(fromHex(secretHex), channelId, useEpoch)
}

/** Whether a message is safe to PERSIST to the durable cache (see file header). */
export async function isMessageCacheable(msg: ChatMessage): Promise<boolean> {
  const hub = useHubStore.getState().hubs[msg.hubDTag]
  if (!hub || !isV2(hub)) return true // v1 / unknown hub — no attestation to verify
  try {
    const key = channelKeyFromStore(msg.hubDTag, msg.channelId, msg.epoch)
    if (!key || !msg.rawEvent) return false // key not loaded → don't persist the unverifiable
    const res = await verifyEventIdentity(JSON.parse(msg.rawEvent), key)
    return res.ok
  } catch {
    return false
  }
}

/** Persist a single message to the durable cache ONLY if it's cacheable (verified on v2). */
export async function cacheMessageIfVerified(msg: ChatMessage): Promise<void> {
  if (await isMessageCacheable(msg)) await cacheMessageWithDedup(msg)
}

/** Filter a batch down to the messages safe to persist (for the bulk EOSE flush). */
export async function filterCacheable(msgs: ChatMessage[]): Promise<ChatMessage[]> {
  const out: ChatMessage[] = []
  for (const m of msgs) if (await isMessageCacheable(m)) out.push(m)
  return out
}
