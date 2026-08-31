/**
 * NIP-CHAT v2 — sealed-sender join requests (§6.3).
 *
 * A v2 join must not reveal *who* is joining. The request (kind 36944) is:
 *  - authored by a derived throwaway **`addr`** sub-key (peered on the owner `O`), used as the
 *    `d`-scoped id so a repeat request from the same joiner replaces the previous one;
 *  - discoverable by the owner via an `["a", coord]` tag (`coord = 36942:O:dTag`);
 *  - tagged `["version","2"]` (so owners route it; a v1 join to a v2 hub lacks it);
 *  - content = `nip44(ECDH(ephemeral, O), { r: R_pub, p: P_pub, note? })` — the ephemeral key
 *    hides the sender, and only the owner (`O`) can open it.
 *
 * The owner decrypts with `O`, and — for a **local-key owner** — re-derives `P` from `R` to
 * verify (squat check). Remote owners need a sub-key ECDH op (deferred); until then they trust
 * the payload (still safe: identity is `R`, messages carry the per-message `R` signature).
 */

import { generateSecretKey, getPublicKey, nip44, type Event } from 'nostr-tools'
import { createUnsignedEvent } from '@/lib/nostr'
import { KINDS } from '@/lib/crypto/constants'
import { makeSubkeySigner, mineAndSignAsSubkey } from '@/lib/nostr/v2send'
import { ChatContext, deriveSubKeyLocal } from '@/lib/crypto/skd'
import type { ISigner } from '@/stores/userStore'

export interface V2JoinPayload {
  rPub: string
  pPub: string
  note?: string
  /** true/false when the owner could re-derive P (local key); undefined when it couldn't verify. */
  verified?: boolean
}

/**
 * Build a sealed v2 join request. Requires a local key or a NIP-SKD signer (to derive `P` and
 * the `addr` sub-key).
 */
export async function buildV2JoinRequest(opts: {
  hubDTag: string
  ownerPub: string // O
  coord: string // 36942:O:dTag
  joinPow: number
  rPub: string // the joiner's real key
  privateKey: string | null
  signer: ISigner | null
  note?: string
}): Promise<Event> {
  const { hubDTag, ownerPub, coord, joinPow, rPub, privateKey, signer, note } = opts

  // Ephemeral key → shared secret with O (hides who is joining).
  const eSk = generateSecretKey()
  const ePub = getPublicKey(eSk)
  const convKey = nip44.v2.utils.getConversationKey(eSk, ownerPub)

  // Member pseudonym P + the throwaway addr key (both NIP-SKD sub-keys peered on O).
  const pSigner = makeSubkeySigner(ChatContext.member(hubDTag), { privateKey, signer, peerPub: ownerPub })
  const pPub = await pSigner.getPublicKey()
  const addrSigner = makeSubkeySigner(ChatContext.joinAddr(hubDTag), { privateKey, signer, peerPub: ownerPub })

  const content = nip44.v2.encrypt(JSON.stringify({ r: rPub, p: pPub, ...(note ? { note } : {}) }), convKey)
  const addrPub = await addrSigner.getPublicKey()
  const unsigned = createUnsignedEvent(KINDS.JOIN_REQUEST, content, [
    ['d', addrPub],
    ['a', coord],
    ['ephemeral', ePub],
    ['version', '2'],
  ])
  return mineAndSignAsSubkey(unsigned, joinPow, addrSigner)
}

/**
 * Parse + verify a sealed v2 join request (owner side). Returns null if it isn't a valid v2
 * join or can't be opened.
 */
export async function parseV2JoinRequest(
  event: Event,
  hubDTag: string,
  ownerRootPrivateKey: string | null,
  ownerSigner: ISigner | null,
): Promise<V2JoinPayload | null> {
  if (!event.tags.some((t) => t[0] === 'version' && t[1] === '2')) return null
  const ePub = event.tags.find((t) => t[0] === 'ephemeral')?.[1]
  if (!ePub) return null

  try {
    const ownerSub = makeSubkeySigner(ChatContext.owner(hubDTag), { privateKey: ownerRootPrivateKey, signer: ownerSigner })
    const plaintext = await ownerSub.nip44Decrypt(ePub, event.content)
    const parsed = JSON.parse(plaintext) as { r?: string; p?: string; note?: string }
    if (!parsed.r || !parsed.p) return null

    // Squat check (local owner only): re-derive P from R and compare.
    let verified: boolean | undefined
    if (ownerRootPrivateKey) {
      const oPriv = deriveSubKeyLocal(ownerRootPrivateKey, ChatContext.owner(hubDTag)).privHex
      const reP = deriveSubKeyLocal(oPriv, ChatContext.member(hubDTag), parsed.r).pubHex
      verified = reP === parsed.p
    }
    return { rPub: parsed.r, pPub: parsed.p, note: parsed.note, verified }
  } catch {
    return null
  }
}
