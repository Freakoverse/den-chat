/**
 * NIP-CHAT v2 — re-publish a hub event after a tree mutation.
 *
 * A v2 hub event is authored by the owner pseudonym `O` and its structural content is
 * encrypted with `hub_content_key = deriveHubContentKey(hubSecret, epoch)`. The v1 tree
 * updater (`safePaginatedTreeUpdate`) re-signs with the *root* key and *plaintext* content —
 * both wrong for v2. So v2 callers pass `skipPublish: true` and re-publish through here.
 *
 * `republishV2HubIndex` covers mutations that change only the index hash (admit, role
 * update, ban) — the epoch/secret is unchanged, so the encrypted content stays
 * byte-identical. We fetch the current event, swap its `m` tag to the new index hash, and
 * re-sign as `O`. Nothing about the encrypted content (channels, roles, owner attestation)
 * is rebuilt, so there is no risk of content-shape drift.
 *
 * (Epoch-rotating mutations — kick / "fix encryption" — must re-encrypt the content with the
 * new epoch key and bump the `m`/`epoch` tags; that is a separate, heavier path.)
 */

import type { HubData } from '@/stores/hubStore'
import type { ISigner } from '@/stores/userStore'
import type { UnsignedEvent } from 'nostr-tools'
import { KINDS } from '@/lib/crypto/constants'
import { ChatContext } from '@/lib/crypto/skd'
import { makeSubkeySigner, mineAndSignAsSubkey } from '@/lib/nostr/v2send'
import { deriveHubContentKey, decryptHubContent, encryptHubContent } from './hubContent'
import { assertIndexUnchanged } from './hubMutationGuard'

export async function republishV2HubIndex(opts: {
  hub: HubData
  /** O — the hub event author (hub.creatorPubkey for a v2 hub). */
  ownerPub: string
  newIndexHash: string
  privateKey: string | null
  signer: ISigner | null
}): Promise<{ eventCreatedAt: number; publishedRelays: string[]; targetedRelays: string[] }> {
  const { hub, ownerPub, newIndexHash, privateKey, signer } = opts

  const { fetchEvents, publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')

  // Fetch the current (latest) hub event authored by O.
  const events = await fetchEvents({
    kinds: [KINDS.HUB_EVENT],
    authors: [ownerPub],
    '#d': [hub.dTag],
    limit: 4,
  })
  const current = events.sort((a, b) => b.created_at - a.created_at)[0]
  if (!current) throw new Error('republishV2HubIndex: current hub event not found on relays')

  // CAS: abort if another writer moved the index pointer since this op read it (lost-update guard).
  assertIndexUnchanged(current, hub.indexFileHash)

  const epochStr = String(hub.epoch)
  // Clone tags and swap only the `m` (index) tag — leave published_at, version,
  // signer_scheme, picture/banner/about, pow, f, etc. exactly as-is.
  let replaced = false
  const newTags: string[][] = current.tags.map((t) => {
    if (t[0] === 'm') { replaced = true; return ['m', newIndexHash, epochStr] }
    return t
  })
  if (!replaced) newTags.push(['m', newIndexHash, epochStr])

  // +1 replacement so the hub doesn't jump to the top of discover feeds.
  const unsigned: UnsignedEvent = {
    kind: KINDS.HUB_EVENT,
    content: current.content, // unchanged encrypted blob
    tags: newTags as string[][] as UnsignedEvent['tags'],
    created_at: current.created_at + 1,
    pubkey: ownerPub, // overwritten by the sub-key signer (equals ownerPub)
  }

  const ownerSigner = makeSubkeySigner(ChatContext.owner(hub.dTag), { privateKey, signer })
  const signed = await mineAndSignAsSubkey(unsigned, hub.minPow > 0 ? hub.minPow : 0, ownerSigner)

  const targetedRelays = getPublishRelays([...hub.generalRelays], { hubOnly: true }) // v2: hub relays only (no R-linkable personal relay footprint for the O-authored hub event)
  const publishedRelays = await publishToSpecificRelays(targetedRelays, signed)
  // publishToSpecificRelays returns an EMPTY array (it does NOT throw) when every relay rejected/timed out.
  // The caller advances the local store and deletes the OLD index blob AFTER we return — so if the new event
  // landed nowhere, that would create an epoch/secret split-brain (owner sends under an index no one has) or
  // BRICK the hub (delete an index the still-live old event points at). Fail loudly instead so nothing after
  // us runs and the op can be retried cleanly.
  if (publishedRelays.length === 0) throw new Error('republishV2HubIndex: the new hub event was not accepted by any relay')
  return { eventCreatedAt: signed.created_at, publishedRelays, targetedRelays }
}

/**
 * Re-publish a v2 hub event after an **epoch-rotating** mutation (kick / "fix encryption").
 * The hub secret changed, so `hub_content_key` changed too — the content must be re-encrypted
 * under the new key and the `epoch`/`m` tags bumped.
 *
 * We decrypt the current content with the *old* epoch key and re-encrypt it with the *new*
 * one, so the exact content shape (channels, roles, owner attestation) is preserved — no
 * rebuild, no shape drift. Still authored by `O`.
 */
export async function republishV2HubRotate(opts: {
  hub: HubData
  /** O — the hub event author. */
  ownerPub: string
  newIndexHash: string
  newEpoch: number
  oldHubSecret: Uint8Array
  newHubSecret: Uint8Array
  /** When groups rotate, the bumped grouped_roles to write into the (re-encrypted) content. */
  groupedRolesOverride?: Array<{ groupId: string; roleIds: string[]; epoch: number }>
  privateKey: string | null
  signer: ISigner | null
}): Promise<{ eventCreatedAt: number; publishedRelays: string[]; targetedRelays: string[] }> {
  const { hub, ownerPub, newIndexHash, newEpoch, oldHubSecret, newHubSecret, groupedRolesOverride, privateKey, signer } = opts

  const { fetchEvents, publishToSpecificRelays } = await import('@/lib/nostr/relay-pool')
  const { getPublishRelays } = await import('@/stores/postingBehaviourStore')

  const events = await fetchEvents({
    kinds: [KINDS.HUB_EVENT],
    authors: [ownerPub],
    '#d': [hub.dTag],
    limit: 4,
  })
  const current = events.sort((a, b) => b.created_at - a.created_at)[0]
  if (!current) throw new Error('republishV2HubRotate: current hub event not found on relays')

  // CAS: abort if another writer moved the index pointer since this op read it. Critical for a rotation
  // racing a non-rotating op (or another rotation) — without it we could publish an event whose epoch,
  // content secret, and pointed-to tree disagree, making the hub undecryptable for everyone.
  assertIndexUnchanged(current, hub.indexFileHash)

  // Rotate the content key: decrypt with the old epoch key, re-encrypt with the new one.
  const oldKey = deriveHubContentKey(oldHubSecret, hub.epoch)
  const newKey = deriveHubContentKey(newHubSecret, newEpoch)
  const contentObj = await decryptHubContent(oldKey, current.content) as Record<string, unknown>
  // When groups rotated, write the bumped grouped_roles epochs into the content.
  if (groupedRolesOverride) {
    contentObj.grouped_roles = groupedRolesOverride.map(g => ({ group_id: g.groupId, role_ids: g.roleIds, epoch: g.epoch }))
  }
  const newContent = await encryptHubContent(newKey, contentObj)

  const newEpochStr = String(newEpoch)
  let mReplaced = false
  let epochReplaced = false
  const newTags: string[][] = current.tags.map((t) => {
    if (t[0] === 'm') { mReplaced = true; return ['m', newIndexHash, newEpochStr] }
    if (t[0] === 'epoch') { epochReplaced = true; return ['epoch', newEpochStr] }
    return t
  })
  if (!mReplaced) newTags.push(['m', newIndexHash, newEpochStr])
  if (!epochReplaced) newTags.push(['epoch', newEpochStr])

  const unsigned: UnsignedEvent = {
    kind: KINDS.HUB_EVENT,
    content: newContent,
    tags: newTags as string[][] as UnsignedEvent['tags'],
    created_at: current.created_at + 1,
    pubkey: ownerPub,
  }

  const ownerSigner = makeSubkeySigner(ChatContext.owner(hub.dTag), { privateKey, signer })
  const signed = await mineAndSignAsSubkey(unsigned, hub.minPow > 0 ? hub.minPow : 0, ownerSigner)

  const targetedRelays = getPublishRelays([...hub.generalRelays], { hubOnly: true }) // v2: hub relays only (no R-linkable personal relay footprint for the O-authored hub event)
  const publishedRelays = await publishToSpecificRelays(targetedRelays, signed)
  // See republishV2HubIndex: a zero-relay publish must fail loudly, not silently — a rotation that lands
  // nowhere while the store advances would leave the owner encrypting under a secret no member has.
  if (publishedRelays.length === 0) throw new Error('republishV2HubRotate: the rotated hub event was not accepted by any relay')
  return { eventCreatedAt: signed.created_at, publishedRelays, targetedRelays }
}
