/**
 * Sign a hub-channel member event the right way for the hub's format.
 *
 * v1 → sign with the real key `R` (mineAndSign when PoW is required, else signWithSigner).
 * v2 → author under the member pseudonym `P` and attach the per-message identity tag
 *      (`enc(channelKey, R_pub ‖ sig_R)`), so the event is pseudonymous on the wire yet
 *      provably backed by `R` (accountable, unforgeable — even by the owner who shares `P`).
 *
 * Use this for EVERY member-authored hub-channel event — messages, edits, deletes, reactions,
 * polls, pins, forum posts/replies, calendar events — so none of them leak `R` in a v2 hub.
 * The `unsigned` event's `pubkey` is overwritten (to `P` in v2, `R` in v1).
 */

import type { Event, UnsignedEvent } from 'nostr-tools'
import type { ISigner } from '@/stores/userStore'
import type { SubkeySigner } from '@/lib/nostr/v2send'

/**
 * The v2 sub-signer this user should author hub-channel events under in a given hub:
 * - a **real member** (their real key `R` is in the roster, or they're the owner) → member pseudonym
 *   `P` (peer = owner `O`);
 * - a **facilitated non-member** (not in the roster, but has a saved facilitator) → facilitated
 *   pseudonym `Pf` (peer = the facilitator's `P_fac`), which is what their leaf is keyed on.
 *
 * Single source of truth so messages, edits, deletes, reactions, polls, pins, etc. all agree on the
 * author key. (The roster keys members by real key `R` in `m.pubkey`, so membership is `R`-matched.)
 */
export async function resolveV2PostingSigner(
  hub: { dTag: string; creatorPubkey: string; ownerRealPubkey?: string },
  pubkey: string,
  privateKey: string | null,
  signer: ISigner | null,
): Promise<SubkeySigner> {
  const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
  const { ChatContext } = await import('@/lib/crypto/skd')
  const { useHubStore } = await import('@/stores/hubStore')
  const memberSigner = makeSubkeySigner(ChatContext.member(hub.dTag), { privateKey, signer, peerPub: hub.creatorPubkey })
  const members = useHubStore.getState().hubMembers[hub.dTag]
  const isMemberOrOwner = pubkey === hub.creatorPubkey || pubkey === hub.ownerRealPubkey
    || !!members?.some((m) => m.pubkey === pubkey)
  if (isMemberOrOwner) return memberSigner
  const facilitator = useHubStore.getState().hubPrefs[hub.dTag]?.facilitator
  if (facilitator) return makeSubkeySigner(ChatContext.facilitated(hub.dTag), { privateKey, signer, peerPub: facilitator })
  return memberSigner // fallback (neither member nor facilitated — the encrypt/publish will fail anyway)
}

export async function signHubMemberEvent(opts: {
  hub: { dTag: string; creatorPubkey: string; version?: number; ownerRealPubkey?: string }
  unsigned: UnsignedEvent
  /** The real key `R` (the actual account). */
  pubkey: string
  privateKey: string | null
  signer: ISigner | null
  /** Message-PoW difficulty (mined before signing). 0 → just sign. */
  minPow?: number
  /**
   * Channel/hub content key for the epoch. Pass it for **content** events (message, edit,
   * reaction, poll, forum post) — it encrypts the identity tag proving `R` authored them.
   * Omit (null) for **auxiliary** events (edit/delete hints, kind-5 deletions) that carry no
   * member content — those just author as `P` with no identity tag.
   */
  channelKey?: Uint8Array | null
}): Promise<Event> {
  const { hub, pubkey, privateKey, signer, minPow = 0, channelKey } = opts
  const { isV2 } = await import('@/lib/hub/version')

  if (isV2(hub)) {
    const { canUseV2 } = await import('@/lib/crypto/skd')
    if (!canUseV2({ privateKey, signer })) {
      throw new Error('This hub is private (v2) — use the DEN client or a NIP-SKD signer to post here.')
    }
    const { mineAndSignAsSubkey } = await import('@/lib/nostr/v2send')
    // Author under member `P` or facilitated `Pf` (facilitated users would otherwise sign edits/
    // deletes/reactions/polls under a member-P their target events weren't authored under).
    const pSigner = await resolveV2PostingSigner(hub, pubkey, privateKey, signer)
    const pPub = await pSigner.getPublicKey()
    let unsigned: UnsignedEvent = { ...opts.unsigned, pubkey: pPub }
    // Content events get the identity tag (BEFORE mining — the id digest excludes it + nonce).
    if (channelKey) {
      const { buildIdentityTag } = await import('@/lib/nostr/identity')
      const identityTag = await buildIdentityTag(unsigned, pubkey, signer, privateKey, channelKey)
      unsigned = { ...unsigned, tags: [...unsigned.tags, identityTag] }
    }
    return mineAndSignAsSubkey(unsigned, minPow, pSigner)
  }

  // v1 — author as the real key R.
  if (minPow > 0) {
    const { mineAndSign } = await import('@/lib/nostr/events')
    return mineAndSign(opts.unsigned, minPow, pubkey, signer, privateKey)
  }
  const { signWithSigner } = await import('@/lib/nostr/events')
  return signWithSigner(opts.unsigned, signer, privateKey)
}

/**
 * Build a Blossom auth signer for a v2 hub upload/delete — the kind-24242 auth event is signed
 * by the member pseudonym `P`, so the Blossom server never sees the real key `R` (which would
 * otherwise let it link `P`-authored messages, that reference the blob, back to the uploader).
 * Returns undefined for v1 hubs (uploads authenticate as `R`, unchanged).
 */
export async function hubBlossomAuthSigner(
  hub: { dTag: string; creatorPubkey: string; version?: number },
  opts: { privateKey: string | null; signer: ISigner | null },
): Promise<((unsigned: UnsignedEvent) => Promise<Event>) | undefined> {
  const id = await hubMemberIdentity(hub, opts)
  if (!id) {
    const { isV2 } = await import('@/lib/hub/version')
    // v2 but no `P` signer could be built (the signer can't do NIP-SKD): FAIL CLOSED. Returning
    // undefined here would let the upload helper fall back to signing the kind-24242 Blossom auth with
    // the real key `R` — the Blossom server would then see `R` tied to a blob that `P`-authored hub
    // messages reference, defeating the pseudonym. v1 legitimately returns undefined (auth as `R`).
    if (isV2(hub)) throw new Error('This private hub needs a NIP-SKD-capable signer to upload or delete media.')
  }
  return id?.authSigner
}

/**
 * Sign a hub **moderation** event (hide/unhide) with the right pseudonym. v1 → `R`. v2 → the
 * **owner** signs as `O` (the hub's public author key — globally verifiable cross-page, and no
 * `R_owner` leak), and a **non-owner moderator** signs as their member pseudonym `P` (same-page
 * verifiable via the roster, exactly like v1). No identity tag: authorization is by `pubkey ===
 * O` (owner, global) or `P ∈ same-page hide-role members` (mod).
 */
export async function signHubModEvent(opts: {
  hub: { dTag: string; creatorPubkey: string; version?: number; ownerRealPubkey?: string }
  unsigned: UnsignedEvent
  /** The signer's real key `R`. */
  pubkey: string
  privateKey: string | null
  signer: ISigner | null
}): Promise<Event> {
  const { hub, pubkey, privateKey, signer } = opts
  const { isV2 } = await import('@/lib/hub/version')
  if (!isV2(hub)) {
    const { signWithSigner } = await import('@/lib/nostr/events')
    return signWithSigner(opts.unsigned, signer, privateKey)
  }
  const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
  const { ChatContext } = await import('@/lib/crypto/skd')
  const isOwner = !!hub.ownerRealPubkey && pubkey === hub.ownerRealPubkey
  const modSigner = isOwner
    ? makeSubkeySigner(ChatContext.owner(hub.dTag), { privateKey, signer })
    : makeSubkeySigner(ChatContext.member(hub.dTag), { privateKey, signer, peerPub: hub.creatorPubkey })
  const pub = await modSigner.getPublicKey()
  return modSigner.signEvent({ ...opts.unsigned, pubkey: pub })
}

/** Caches the derived pseudonym `P` per hub (the expensive part); the sub-signer is cheap to rebuild. */
const _pKeyCache = new Map<string, string>()

/**
 * Clear the cached pseudonyms. MUST be called on account switch — the cache is keyed by
 * `dTag:creatorPubkey` (not by the user), so a stale entry would otherwise return the PREVIOUS
 * account's `P` for the same hub, mis-authoring the new user's per-user artifacts.
 */
export function clearPKeyCache() {
  _pKeyCache.clear()
}

/**
 * Resolve the current member's v2 identity for a hub: their pseudonym `P` (`authKey`) and a
 * function that signs an event as `P` (`authSigner`). Returns undefined for v1 hubs (act as `R`).
 * Use for per-user hub artifacts that must not reveal `R` — pins, hidden-message lists, etc.
 */
export async function hubMemberIdentity(
  hub: { dTag: string; creatorPubkey: string; version?: number },
  opts: { privateKey: string | null; signer: ISigner | null },
): Promise<{ authKey: string; authSigner: (unsigned: UnsignedEvent) => Promise<Event> } | undefined> {
  const { isV2 } = await import('@/lib/hub/version')
  if (!isV2(hub)) return undefined
  const { canUseV2, ChatContext } = await import('@/lib/crypto/skd')
  if (!canUseV2(opts)) return undefined
  const { makeSubkeySigner } = await import('@/lib/nostr/v2send')
  const pSigner = makeSubkeySigner(ChatContext.member(hub.dTag), { privateKey: opts.privateKey, signer: opts.signer, peerPub: hub.creatorPubkey })
  const cacheKey = `${hub.dTag}:${hub.creatorPubkey}`
  let authKey = _pKeyCache.get(cacheKey)
  if (!authKey) { authKey = await pSigner.getPublicKey(); _pKeyCache.set(cacheKey, authKey) }
  return { authKey, authSigner: (unsigned: UnsignedEvent) => pSigner.signEvent(unsigned) }
}
