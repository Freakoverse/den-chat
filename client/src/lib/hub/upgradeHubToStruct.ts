/**
 * upgradeHubToStruct: convert an existing LEGACY (inline) hub to the struct-blob format.
 *
 * This is NOT a v1->v2 conversion: the hub keeps its exact privacy type, epoch, secret, members, and
 * index. All it does is move the structural arrays (channels/roles/categories/grouped_roles) out of the
 * event content into a Blossom blob and republish the hub event with a `["struct", hash, epoch]` tag (and,
 * for v1, the public face moved to picture/banner/about tags). The member tree / `m` index is untouched,
 * so this is one blob upload + one event publish. Owner-only.
 *
 * Steps are surfaced through `onStep` for the migration modal's progress UI. Any failure throws before the
 * store advances, so a failed migration leaves the hub exactly as it was (still legacy).
 */

import type { HubData } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'
import { publishStructBlob, resolveStructUploadContext } from './hubStructBlob'

export type UpgradeStep = 'Building structure file' | 'Uploading to Blossom' | 'Publishing hub update' | 'Verifying'

export async function upgradeHubToStruct(opts: {
  hub: HubData
  /** The owner's real key R. */
  pubkey: string
  privateKey: string | null
  signer: ISigner | null
  onStep?: (step: UpgradeStep) => void
}): Promise<void> {
  const { hub, pubkey, privateKey, signer, onStep } = opts
  if (hub.structFileHash) return // already struct-format: nothing to do

  const { isV2 } = await import('@/lib/hub/version')
  const { casCheckIndex } = await import('@/lib/hub/hubMutationGuard')
  const { publishCriticalWithFailover } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')
  const { useHubStore } = await import('@/stores/hubStore')

  // 1. Upload the struct blob (v2 encrypted with hub_content_key + authored as the owner pseudonym O;
  //    v1 plaintext under the real key). publishStructBlob verifies the blob reads back (folds in Verify).
  onStep?.('Building structure file')
  const { contentKey, authSigner } = await resolveStructUploadContext(hub, hub.epoch, { privateKey, signer })
  onStep?.('Uploading to Blossom')
  const structHash = await publishStructBlob({
    input: { channels: hub.channels, categories: hub.categories, roles: hub.roles, groupedRoles: hub.groupedRoles },
    contentKey,
    servers: hub.blossomServers,
    dTag: hub.dTag,
    signer,
    privateKey,
    authSigner,
  })

  // 2. Republish the hub event in struct format (structure dropped from content, struct tag added). Same
  //    builder dispatch as any edit, with the struct hash threaded through the params.
  onStep?.('Publishing hub update')
  const params = {
    dTag: hub.dTag,
    name: hub.name,
    description: hub.description || undefined,
    epoch: hub.epoch,
    icon: hub.icon || undefined,
    banner: hub.banner || undefined,
    tags: hub.tags && hub.tags.length > 0 ? hub.tags : undefined,
    relays: hub.generalRelays,
    blossomServers: hub.blossomServers,
    indexFileHash: hub.indexFileHash,
    structFileHash: structHash,
    channels: hub.channels,
    categories: hub.categories,
    roles: hub.roles,
    minPow: hub.minPow > 0 ? hub.minPow : undefined,
    joinMinPow: hub.joinMinPow > 0 ? hub.joinMinPow : undefined,
    joinNote: hub.joinNote,
    messageExpiration: hub.messageExpiration && hub.messageExpiration > 0 ? hub.messageExpiration : undefined,
    nsfw: hub.nsfw || undefined,
    discoverable: hub.discoverable !== false,
    groupedRoles: hub.groupedRoles && hub.groupedRoles.length > 0 ? hub.groupedRoles : undefined,
    publishedAt: hub.publishedAt,
    eventCreatedAt: hub.eventCreatedAt,
    authorPubkey: hub.creatorPubkey,
  }

  let signed
  if (isV2(hub)) {
    const secretHex = useHubStore.getState().hubSecrets[hub.dTag]
    if (!secretHex) throw new Error('Hub secret not available to upgrade this private hub')
    const { fromHex } = await import('@/lib/crypto/lkh')
    const { buildAndSignV2HubEvent } = await import('@/lib/hub/buildHubEvent')
    signed = await buildAndSignV2HubEvent({
      ...params,
      hubSecret: fromHex(secretHex),
      ownerRealPub: pubkey,
      ownerPub: hub.creatorPubkey,
      minPow: hub.minPow,
      privateKey,
      signer,
    })
  } else {
    const { buildHubEvent } = await import('@/lib/hub/buildHubEvent')
    const { mineAndSign } = await import('@/lib/nostr/events')
    signed = await mineAndSign(buildHubEvent(params), hub.minPow, pubkey, signer, privateKey)
  }

  // CAS: abort if another writer moved the index pointer since we read it (an edit racing the upgrade).
  onStep?.('Verifying')
  await casCheckIndex(hub.dTag, hub.creatorPubkey, hub.indexFileHash)

  const accepted = await publishCriticalWithFailover(
    signed, getPublishRelays([...hub.generalRelays], { hubOnly: isV2(hub) }), [...hub.generalRelays],
  )
  if (accepted.length === 0) throw new Error('The hub upgrade was not accepted by any relay, please try again.')

  // 3. Advance the store: the hub is now struct-format. Cache the new event too.
  const cur = useHubStore.getState().hubs[hub.dTag]
  if (cur) useHubStore.getState().setHubData(hub.dTag, { ...cur, structFileHash: structHash, eventCreatedAt: signed.created_at })
  import('@/lib/cache/hubEventCache').then(m => m.putHubEvent(signed)).catch(() => { /* cache best-effort */ })
}
