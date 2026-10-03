/**
 * groupJoin: join requests for groups (NIP-CHAT §21.6.1). The kind-36944 request is the hub one
 * (§6.3) with the group coordinate in `a` and the group's `W` as the join difficulty:
 *  - v1: real-key author, `d` = group d tag, `a` = `36950:R_creator:d`, `p` = creator, content =
 *    the optional note NIP-44 to the creator.
 *  - v2: the sealed-sender request (lib/hub/v2join) with `a` = `36950:O:d`; nothing group-specific.
 * The creator lists requests by `#a` on the group's relays plus the client relays, opens v2 ones as
 * O, drops tombstones, members, and anything mined below `W`.
 */
import type { Event } from 'nostr-tools'
import { nowSeconds } from '@/lib/time/clockOffset'
import { KINDS } from '@/lib/crypto/constants'
import { createUnsignedEvent, mineAndSign, signWithSigner } from '@/lib/nostr'
import { createDeletedJoinRequest, createDeletionEvent } from '@/lib/nostr/events'
import { fetchEventsFromRelays, getRelays, publishCriticalWithFailover } from '@/lib/nostr/relay-pool'
import { getPublishRelays, getDeletePublishRelays } from '@/stores/postingBehaviourStore'
import { useUserStore } from '@/stores/userStore'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import { canUseV2, ChatContext } from '@/lib/crypto/skd'
import { makeSubkeySigner, mineAndSignAsSubkey } from '@/lib/nostr/v2send'
import { buildV2JoinRequest, parseV2JoinRequest, readOwnV2JoinRequest } from '@/lib/hub/v2join'
import { nip44EncryptTo, nip44DecryptFrom } from '@/lib/hub/hubListPrivacy'
import { normalizeJoinNote } from '@/lib/hub/joinNote'
import { groupCoord, isGroupV2, type GroupData } from '@/lib/group/groupEvent'

export interface GroupJoinRequest {
  /** The requester's real key R. */
  pubkey: string
  createdAt: number
  powBits: number
  eventId: string
  /** v2: the pseudonym P (informational; the creator re-derives it when adding). */
  pPub?: string
  /** v2: the note, already decrypted. */
  note?: string
  /** v1: the note ciphertext (NIP-44 requester → creator), decrypted on demand. */
  noteCipher?: string
}

function keys() {
  const { pubkey, privateKey, signer } = useUserStore.getState()
  if (!pubkey) throw new Error('Not logged in')
  return { me: pubkey, privateKey, signer }
}

/** Publish a join request for `g` (with an optional note). Throws when a v2 group can't be joined by this signer. */
export async function requestJoinGroup(g: GroupData, note = ''): Promise<void> {
  const k = keys()
  const coord = groupCoord(g)
  const relays = [...g.relays]
  let signed: Event
  if (isGroupV2(g)) {
    if (!canUseV2({ privateKey: k.privateKey, signer: k.signer })) {
      throw new Error('This is a private group. Use the DEN Chat client or a NIP-SKD signer to request to join.')
    }
    signed = await buildV2JoinRequest({
      hubDTag: g.dTag, ownerPub: g.creatorPubkey, coord, joinPow: g.joinMinPow || 0, rPub: k.me,
      privateKey: k.privateKey, signer: k.signer, note: normalizeJoinNote(note) || undefined,
    })
  } else {
    const text = normalizeJoinNote(note)
    const content = text ? await nip44EncryptTo(text, g.creatorPubkey, k.signer, k.privateKey) : ''
    const unsigned = createUnsignedEvent(KINDS.JOIN_REQUEST, content, [['d', g.dTag], ['a', coord], ['p', g.creatorPubkey]])
    signed = await mineAndSign(unsigned, g.joinMinPow || 0, k.me, k.signer, k.privateKey)
  }
  // v2: the group's relays only, so the addr key never lands on the requester's own NIP-65 relays.
  const accepted = await publishCriticalWithFailover(signed, getPublishRelays(relays, { hubOnly: isGroupV2(g), hubSeed: g.dTag }), relays)
  if (accepted.length === 0) throw new Error('No relay accepted the join request. Please try again.')
}

/** My own pending request for `g`, if one is on its relays (for the "Requested" state on the invite card). */
export async function getOwnGroupJoinRequest(g: GroupData): Promise<{ createdAt: number; note?: string } | null> {
  const k = keys()
  const coord = groupCoord(g)
  const relays = [...new Set([...g.relays, ...getRelays()])]
  let author = k.me
  if (isGroupV2(g)) {
    if (!canUseV2({ privateKey: k.privateKey, signer: k.signer })) return null
    author = await makeSubkeySigner(ChatContext.joinAddr(g.dTag), { privateKey: k.privateKey, signer: k.signer, peerPub: g.creatorPubkey }).getPublicKey()
  }
  const events = await fetchEventsFromRelays(relays, { kinds: [KINDS.JOIN_REQUEST], authors: [author], '#a': [coord], limit: 5 })
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
  if (!latest || latest.tags.some((t) => t[0] === 'deleted' && t[1] === 'true')) return null
  if (isGroupV2(g)) {
    const own = await readOwnV2JoinRequest(latest, g.dTag, g.creatorPubkey, { privateKey: k.privateKey, signer: k.signer })
    return { createdAt: latest.created_at, note: own?.note }
  }
  let note: string | undefined
  if (latest.content) { try { note = await nip44DecryptFrom(latest.content, g.creatorPubkey, k.signer, k.privateKey) } catch { /* unreadable */ } }
  return { createdAt: latest.created_at, note }
}

/** Creator side: the pending requests for `g`, newest first. */
export async function fetchGroupJoinRequests(g: GroupData, opts: { memberPubkeys: Set<string>; creatorReal: string; includeBelowPow?: boolean }): Promise<GroupJoinRequest[]> {
  const k = keys()
  const coord = groupCoord(g)
  const relays = [...new Set([...g.relays, ...getRelays()])]
  const events = await fetchEventsFromRelays(relays, { kinds: [KINDS.JOIN_REQUEST], '#a': [coord], limit: 500 })
  const byPubkey = new Map<string, GroupJoinRequest>()
  const v2 = isGroupV2(g)
  for (const e of events) {
    if (e.tags.some((t) => t[0] === 'deleted' && t[1] === 'true')) continue
    const powBits = countLeadingZeroBits(e.id)
    // Gate on W before any decrypt (a v2 open costs an ECDH).
    if (!opts.includeBelowPow && g.joinMinPow > 0 && powBits < g.joinMinPow) continue
    let req: GroupJoinRequest | null = null
    if (v2) {
      const payload = await parseV2JoinRequest(e, g.dTag, k.privateKey, k.signer)
      if (!payload || payload.verified === false) continue
      req = { pubkey: payload.rPub, createdAt: e.created_at, powBits, eventId: e.id, pPub: payload.pPub, note: payload.note || undefined }
    } else {
      if (e.tags.some((t) => t[0] === 'version' && t[1] === '2')) continue
      req = { pubkey: e.pubkey, createdAt: e.created_at, powBits, eventId: e.id, noteCipher: e.content || undefined }
    }
    const existing = byPubkey.get(req.pubkey)
    if (existing && existing.createdAt > req.createdAt) continue
    byPubkey.set(req.pubkey, req)
  }
  return [...byPubkey.values()]
    .filter((r) => r.pubkey !== opts.creatorReal && !opts.memberPubkeys.has(r.pubkey))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/** Decrypt a v1 note (requester → creator). */
export async function readGroupJoinNote(req: GroupJoinRequest): Promise<string | null> {
  if (req.note) return req.note
  if (!req.noteCipher) return null
  const k = keys()
  try { return await nip44DecryptFrom(req.noteCipher, req.pubkey, k.signer, k.privateKey) } catch { return null }
}

/**
 * Withdraw my join request for `g` (§6.3 lifecycle, applied to groups): republish it tombstoned
 * (`deleted`, created_at + 1, same `a`) and send a NIP-09 deletion for its coordinate. v2 signs both
 * under the deterministic addr sub-key, never R, and publishes to the group's relays only.
 * With `requireLive`, no-ops unless a live (non-tombstoned) request exists: used to auto-clean
 * after the user accepts the invite, without emitting a tombstone for a request never made.
 */
export async function withdrawGroupJoinRequest(g: GroupData, opts: { requireLive?: boolean } = {}): Promise<boolean> {
  const k = keys()
  const coord = groupCoord(g)
  const relays = [...g.relays]
  const v2 = isGroupV2(g)
  const publishRelays = getDeletePublishRelays(relays, { hubOnly: v2 })
  const queryRelays = [...new Set([...relays, ...getRelays()])]
  const live = (e: Event | undefined) => !!e && !e.tags.some((t) => t[0] === 'deleted' && t[1] === 'true')

  if (v2) {
    if (!canUseV2({ privateKey: k.privateKey, signer: k.signer })) return false
    const addrSigner = makeSubkeySigner(ChatContext.joinAddr(g.dTag), { privateKey: k.privateKey, signer: k.signer, peerPub: g.creatorPubkey })
    const addrPub = await addrSigner.getPublicKey()
    const existing = (await fetchEventsFromRelays(queryRelays, { kinds: [KINDS.JOIN_REQUEST], authors: [addrPub], '#d': [addrPub], limit: 1 }))[0]
    if (opts.requireLive && !live(existing)) return false
    const createdAt = existing?.created_at ?? nowSeconds()
    const deleted = createDeletedJoinRequest(addrPub, g.creatorPubkey, createdAt, coord)
    await publishCriticalWithFailover(await mineAndSignAsSubkey(deleted, 0, addrSigner), publishRelays, relays)
    const del = createDeletionEvent([], [`${KINDS.JOIN_REQUEST}:${addrPub}:${addrPub}`], 'withdraw join request')
    await publishCriticalWithFailover(await mineAndSignAsSubkey(del, 0, addrSigner), publishRelays, relays)
    return true
  }

  const existing = (await fetchEventsFromRelays(queryRelays, { kinds: [KINDS.JOIN_REQUEST], authors: [k.me], '#d': [g.dTag], limit: 1 }))[0]
  if (opts.requireLive && !live(existing)) return false
  const createdAt = existing?.created_at ?? nowSeconds()
  const deleted = createDeletedJoinRequest(g.dTag, g.creatorPubkey, createdAt, coord)
  await publishCriticalWithFailover(await signWithSigner(deleted, k.signer, k.privateKey), publishRelays, relays)
  const del = createDeletionEvent([], [`${KINDS.JOIN_REQUEST}:${k.me}:${g.dTag}`], 'withdraw join request')
  await publishCriticalWithFailover(await signWithSigner(del, k.signer, k.privateKey), publishRelays, relays)
  return true
}
