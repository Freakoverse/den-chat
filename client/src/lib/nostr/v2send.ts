/**
 * NIP-CHAT v2 — authoring events as a derived sub-key (member pseudonym `P`,
 * or owner pseudonym `O`).
 *
 * A v2 member event is signed on the wire by `P`, not by the real key `R`. This
 * module builds a signer bound to a NIP-SKD sub-key from either:
 *   - a local key — derive the sub-key's private key and sign with nostr-tools;
 *   - a NIP-SKD remote signer — `getSubkeyPubkey` / `signAsSubkey`, so the
 *     sub-key's private material never leaves the signer.
 *
 * It deliberately does NOT go through `signWithSigner`, whose guard requires
 * `pubkey === R` (the active account). Here the wire identity is `P`/`O`.
 *
 * PoW is mined over the event id, which is independent of the signature, so
 * mining iterates the nonce with no signing and the sub-key signs once per pass
 * (with a retry if a remote signer perturbs `created_at`/tags — mirrors
 * `mineAndSign`).
 */

import { finalizeEvent, nip44, type UnsignedEvent, type Event } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'
import { deriveSubKeyLocal, signerSupportsSkd, SkdUnsupportedError, type SkdSigner } from '@/lib/crypto/skd'
import type { ISigner } from '@/stores/userStore'

/** A minimal signer bound to a derived sub-key. */
export interface SubkeySigner {
  getPublicKey(): Promise<string>
  signEvent(event: UnsignedEvent): Promise<Event>
  /** nip44-encrypt from this sub-key to `recipientPub` (e.g. an owner `O` wrapping a leaf key). */
  nip44Encrypt(recipientPub: string, plaintext: string): Promise<string>
  /** nip44-decrypt a ciphertext addressed to this sub-key from `senderPub`. */
  nip44Decrypt(senderPub: string, ciphertext: string): Promise<string>
}

/**
 * Build a signer that authors events as the NIP-SKD sub-key for `context`.
 * `peerPub` present → shared/member form; omitted → self/owner form.
 *
 * @throws {@link SkdUnsupportedError} when neither a local key nor a NIP-SKD signer is available.
 */
export function makeSubkeySigner(
  context: string,
  opts: { privateKey?: string | null; signer?: ISigner | null; peerPub?: string },
): SubkeySigner {
  if (opts.privateKey) {
    const sub = deriveSubKeyLocal(opts.privateKey, context, opts.peerPub)
    const privBytes = hexToBytes(sub.privHex)
    return {
      getPublicKey: async () => sub.pubHex,
      // finalizeEvent sets pubkey from the derived key (= sub.pubHex), matching the mining pubkey.
      signEvent: async (event) => finalizeEvent(event, privBytes),
      nip44Encrypt: async (recipientPub, plaintext) =>
        nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(privBytes, recipientPub)),
      nip44Decrypt: async (senderPub, ciphertext) =>
        nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(privBytes, senderPub)),
    }
  }
  const s = opts.signer
  if (signerSupportsSkd(s)) {
    const skd = (s as Required<SkdSigner>).skd
    return {
      getPublicKey: () => skd.getSubkeyPubkey(context, opts.peerPub),
      signEvent: (event) => skd.signAsSubkey(context, event, opts.peerPub) as Promise<Event>,
      nip44Encrypt: (recipientPub, plaintext) => skd.nip44EncryptAsSubkey(context, recipientPub, plaintext, opts.peerPub),
      nip44Decrypt: (senderPub, ciphertext) => skd.nip44DecryptAsSubkey(context, senderPub, ciphertext, opts.peerPub),
    }
  }
  throw new SkdUnsupportedError()
}

/**
 * Mine PoW (nonce) and sign a message with the sub-key.
 *
 * @param unsigned  the message event (its `pubkey` is set to the sub-key's)
 * @param minPow    hub message PoW difficulty (0 → no mining)
 * @param pSigner   a {@link SubkeySigner} (from {@link makeSubkeySigner})
 */
export async function mineAndSignAsSubkey(
  unsigned: UnsignedEvent,
  minPow: number,
  pSigner: SubkeySigner,
): Promise<Event> {
  const pubkey = await pSigner.getPublicKey()
  if (minPow <= 0) {
    return pSigner.signEvent({ ...unsigned, pubkey })
  }

  const { mineEvent, countLeadingZeroBits } = await import('@/lib/pow/pow')
  const MAX_RETRIES = 5
  let mined = await mineEvent({ ...unsigned, pubkey }, minPow, pubkey)
  let signed = await pSigner.signEvent(mined)
  let attempts = 0
  while (countLeadingZeroBits(signed.id) < minPow && attempts < MAX_RETRIES) {
    attempts++
    const retry: UnsignedEvent = {
      kind: signed.kind,
      content: signed.content,
      tags: signed.tags.filter((t) => t[0] !== 'nonce'),
      created_at: signed.created_at,
      pubkey: signed.pubkey,
    }
    mined = await mineEvent(retry, minPow, signed.pubkey)
    signed = await pSigner.signEvent(mined)
  }
  return signed
}
