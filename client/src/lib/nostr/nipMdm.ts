/**
 * NIP-MDM — Masked Direct Messages (see docs/NIP-MDM.md).
 *
 * A one-to-one DM where the SENDER's root never appears on the wire: the sender authors under a
 * per-recipient NIP-SKD **blinded** sub-key `M`, while the recipient is addressed by their REAL key, so
 * the recipient receives with no derivation (plain subscribe to their own key). Everything rides on the
 * base `skd:1` ops via {@link makeSubkeySigner}; this module adds the addressing/envelope conventions and
 * the kind-30092 event shape. No new signer surface.
 *
 * Two events per message (docs §3.4):
 *   - the real message  (author `M`,  p = recipient root)  → published to the recipient's relays;
 *   - a self-copy       (author `C_from`, p = `C_to`)      → published to the sender's own relays,
 *     carrying the ENTIRE signed real event encrypted inside, so the sender recovers/rebroadcasts it.
 */

import { nip44, type Event, type UnsignedEvent } from 'nostr-tools'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { makeSubkeySigner, type SubkeySigner } from './v2send'
import {
  deriveBlindedPubForPeer,
  signerSupportsSkd,
  canUseV2,
  SkdUnsupportedError,
  type ChatCtx,
} from '@/lib/crypto/skd'
import { guardedDecrypt } from '@/lib/auth/signerGuard'
import { nowSeconds } from '@/lib/time/clockOffset'
import type { ISigner } from '@/stores/userStore'
import type { Attachment } from '@/stores/messageStore'

/** The masked direct message kind (addressable; 92 = BIP-39 index of "mask"). docs §9. */
export const MDM_KIND = 30092

/** NIP-SKD contexts (the `nip-mdm:v1:*` family). docs §1.1 / §3.4 / §9. */
const CTX_PEER = 'nip-mdm:v1:peer'
const CTX_COPY_FROM = 'nip-mdm:v1:copy-from'
const CTX_COPY_TO = 'nip-mdm:v1:copy-to'

const MDM_PEER: ChatCtx = { context: CTX_PEER, form: 'blinded' }
const MDM_COPY_FROM: ChatCtx = { context: CTX_COPY_FROM, form: 'self' }
const MDM_COPY_TO: ChatCtx = { context: CTX_COPY_TO, form: 'self' }

export interface MdmKeys {
  privateKey?: string | null
  signer?: ISigner | null
}

/** Decrypted real-message payload (docs §2.1). */
export interface MdmPayload {
  v: 1
  /** sender's real key, disclosed only to the recipient; verified per docs §1.3 */
  from: string
  t?: string
  edited?: number
  /** tombstone marker for a deleted message (docs §6) */
  deleted?: boolean
  /** addressable coordinate of the replied-to message: "30092:<authorM>:<d>" */
  reply?: string
  /** addressable coordinate of the thread root */
  rootRef?: string
  isThread?: boolean
  emoji?: [string, string, string?][]
  sticker?: [string, string, string?][]
  gif?: [string, string, string][]
  /** Structured file attachments (docs §2.1), private inside the encrypted payload. Reuses the hub
   *  Attachment shape (hash, type, name, size, optional servers, optional per-file encryption). */
  attachments?: Attachment[]
}

/** The masked reaction kind (NIP-25, authored by the masked key, content encrypted). docs §6. */
export const MDM_REACTION_KIND = 7

/** Decrypted reaction payload (emoji private, like a message). */
export interface MdmReactionPayload {
  v: 1
  from: string
  emoji: string
  /** image URL for a NIP-30 custom emoji */
  customUrl?: string
}

/** The body a caller supplies (everything but `v`/`from`, which this module fills). */
export type MdmBody = Omit<MdmPayload, 'v' | 'from'>

/** Self-copy payload (docs §3.4.1): the entire signed real event, verbatim. */
interface MdmSelfCopyPayload {
  v: 1
  event: Event
}

/** Whether masked DMs are possible with this key setup (local key, or a signer with NIP-SKD support). */
export function mdmSupported(keys: MdmKeys): boolean {
  return canUseV2(keys)
}

/** A fresh opaque random `d` tag (16 bytes hex). docs §2. */
function randomD(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** The sender's masked sub-signer toward `recipientRootPub` (its pubkey is `M`). */
function maskedSigner(recipientRootPub: string, keys: MdmKeys): SubkeySigner {
  return makeSubkeySigner(MDM_PEER, {
    privateKey: keys.privateKey,
    signer: keys.signer,
    peerPub: recipientRootPub,
  })
}

/** My masked key `M` toward a recipient (what I author as for that conversation). docs §1.1. */
export function myMaskedPub(recipientRootPub: string, keys: MdmKeys): Promise<string> {
  return maskedSigner(recipientRootPub, keys).getPublicKey()
}

/**
 * A peer's masked key toward me, re-derived from their real key (docs §1.3). The recipient uses this to
 * verify a received message's author, and either party uses it to fetch the other side's messages.
 * Simple root-to-root blinded case (the recipient's ROOT is the ECDH identity), so no composed op.
 */
export async function peerMaskedPub(senderRootPub: string, keys: MdmKeys): Promise<string> {
  if (keys.privateKey) return deriveBlindedPubForPeer(keys.privateKey, CTX_PEER, senderRootPub)
  if (signerSupportsSkd(keys.signer)) return keys.signer.skd.getPeerBlindedPubkey(CTX_PEER, senderRootPub)
  throw new SkdUnsupportedError()
}

/** The sender's two static self-copy keys (docs §3.4). Deterministic from the root alone. */
export async function selfCopyKeys(keys: MdmKeys): Promise<{ from: string; to: string }> {
  const [from, to] = await Promise.all([
    makeSubkeySigner(MDM_COPY_FROM, keys).getPublicKey(),
    makeSubkeySigner(MDM_COPY_TO, keys).getPublicKey(),
  ])
  return { from, to }
}

/** Plain NIP-44 decrypt with the user's REAL key against `counterpartyPub` (recipient side; unmasked). */
function realNip44Decrypt(ciphertext: string, counterpartyPub: string, keys: MdmKeys): Promise<string> {
  if (keys.privateKey) {
    const ck = nip44.v2.utils.getConversationKey(hexToBytes(keys.privateKey), counterpartyPub)
    return Promise.resolve(nip44.v2.decrypt(ciphertext, ck))
  }
  return guardedDecrypt(ciphertext, counterpartyPub, keys.signer ?? null, null, 'nip44')
}

/** Build a self-copy (docs §3.4): authored by `C_from`, addressed to `C_to`, embedding any signed event
 *  (a message or a reaction) verbatim so the sender can recover it. */
export async function buildMdmSelfCopy(real: Event, keys: MdmKeys, dSelf?: string): Promise<Event> {
  const fromSigner = makeSubkeySigner(MDM_COPY_FROM, keys)
  const [cFrom, cTo] = await Promise.all([fromSigner.getPublicKey(), makeSubkeySigner(MDM_COPY_TO, keys).getPublicKey()])
  const payload: MdmSelfCopyPayload = { v: 1, event: real }
  const content = await fromSigner.nip44Encrypt(cTo, JSON.stringify(payload))
  const unsigned: UnsignedEvent = {
    kind: MDM_KIND,
    created_at: real.created_at, // SAME created_at as the real message (docs §3.4)
    tags: [['d', dSelf ?? randomD()], ['p', cTo]],
    content,
    pubkey: cFrom,
  }
  return fromSigner.signEvent(unsigned)
}

/**
 * Build a masked message and its self-copy (docs §2, §3.1, §3.4). Returns both signed events; the caller
 * publishes `real` to the recipient's relays and `selfCopy` to the sender's own relays (docs §5).
 *
 * For an EDIT, pass the original message's `d` and `created_at + 1`, plus the self-copy's own `dSelf`,
 * so both addressable coordinates are replaced in place (docs §2.2 / §3.4.1).
 */
export async function buildMdmMessage(opts: {
  recipientRootPub: string
  myRootPub: string
  body: MdmBody
  keys: MdmKeys
  d?: string
  createdAt?: number
  dSelf?: string
}): Promise<{ real: Event; selfCopy: Event; maskedPub: string }> {
  const mSigner = maskedSigner(opts.recipientRootPub, opts.keys)
  const maskedPub = await mSigner.getPublicKey()
  const payload: MdmPayload = { v: 1, from: opts.myRootPub, ...opts.body }
  const content = await mSigner.nip44Encrypt(opts.recipientRootPub, JSON.stringify(payload))
  const unsigned: UnsignedEvent = {
    kind: MDM_KIND,
    created_at: opts.createdAt ?? nowSeconds(),
    tags: [['d', opts.d ?? randomD()], ['p', opts.recipientRootPub]],
    content,
    pubkey: maskedPub,
  }
  const real = await mSigner.signEvent(unsigned)
  const selfCopy = await buildMdmSelfCopy(real, opts.keys, opts.dSelf)
  return { real, selfCopy, maskedPub }
}

/**
 * Build a masked reaction (docs §6) and its self-copy: a kind-7 event authored by the reactor's masked key
 * `M`, tagged with the target's addressable coordinate (`a`) and the recipient's real key (`p`), with the
 * emoji NIP-44-encrypted from `M` to the recipient. The self-copy embeds the full reaction event.
 */
export async function buildMdmReaction(opts: {
  targetCoordinate: string
  recipientRootPub: string
  myRootPub: string
  emoji: string
  customUrl?: string
  keys: MdmKeys
}): Promise<{ real: Event; selfCopy: Event }> {
  const mSigner = maskedSigner(opts.recipientRootPub, opts.keys)
  const maskedPub = await mSigner.getPublicKey()
  const payload: MdmReactionPayload = { v: 1, from: opts.myRootPub, emoji: opts.emoji, ...(opts.customUrl ? { customUrl: opts.customUrl } : {}) }
  const content = await mSigner.nip44Encrypt(opts.recipientRootPub, JSON.stringify(payload))
  const unsigned: UnsignedEvent = {
    kind: MDM_REACTION_KIND,
    created_at: nowSeconds(),
    tags: [['a', opts.targetCoordinate], ['p', opts.recipientRootPub]],
    content,
    pubkey: maskedPub,
  }
  const real = await mSigner.signEvent(unsigned)
  const selfCopy = await buildMdmSelfCopy(real, opts.keys)
  return { real, selfCopy }
}

export interface MdmReactionDecrypted {
  payload: MdmReactionPayload
  senderRootPub: string
  verified: boolean
  /** the `a` coordinate of the reacted-to masked message */
  targetCoordinate: string | null
}

/** Decrypt a RECEIVED masked reaction (I am the recipient) and verify its author (docs §1.3 / §6). */
export async function decryptReceivedReaction(event: Event, keys: MdmKeys): Promise<MdmReactionDecrypted | null> {
  let payload: MdmReactionPayload
  try {
    payload = JSON.parse(await realNip44Decrypt(event.content, event.pubkey, keys))
  } catch {
    return null
  }
  if (!payload || payload.v !== 1 || typeof payload.from !== 'string' || typeof payload.emoji !== 'string') return null
  let verified = false
  try {
    verified = (await peerMaskedPub(payload.from, keys)) === event.pubkey
  } catch {
    verified = false
  }
  return { payload, senderRootPub: payload.from, verified, targetCoordinate: event.tags.find((t) => t[0] === 'a')?.[1] ?? null }
}

/** Decrypt one of MY OWN reactions (from its embedded self-copy event) so my reactions show on any device. */
export async function decryptOwnReaction(reactionEvent: Event, keys: MdmKeys): Promise<MdmReactionPayload | null> {
  const recipientRootPub = reactionEvent.tags.find((t) => t[0] === 'p')?.[1]
  if (!recipientRootPub) return null
  try {
    const payload: MdmReactionPayload = JSON.parse(await maskedSigner(recipientRootPub, keys).nip44Decrypt(recipientRootPub, reactionEvent.content))
    if (!payload || payload.v !== 1) return null
    return payload
  } catch {
    return null
  }
}

/**
 * A Blossom 24242 auth signer bound to the sender's masked key toward `recipientRootPub` (docs §6 / §10):
 * uploads are authorized as `M`, so the Blossom server never sees the real key. Reuses ChatInputBar's
 * `getUploadAuthSigner` seam, exactly as v2 hubs upload as their pseudonym.
 */
export function mdmBlossomAuthSigner(recipientRootPub: string, keys: MdmKeys): (unsigned: UnsignedEvent) => Promise<Event> {
  const mSigner = maskedSigner(recipientRootPub, keys)
  return (unsigned: UnsignedEvent) => mSigner.signEvent(unsigned)
}

export interface MdmDecrypted {
  payload: MdmPayload
  /** the sender's real root, taken from `from` and confirmed against the masked author (docs §1.3) */
  senderRootPub: string
  /** true once `getPeerBlindedPubkey(from) == event.pubkey`; false = spoofed/unverifiable `from` */
  verified: boolean
}

/**
 * Decrypt a RECEIVED masked message (I am the recipient, unmasked) and verify its sender (docs §1.3, §3.2).
 * Decryption uses my real key against the visible masked author; verification re-derives the claimed
 * sender's masked key and checks it equals the author. Returns null if the ciphertext/payload is unusable.
 */
export async function decryptReceivedMdm(event: Event, keys: MdmKeys): Promise<MdmDecrypted | null> {
  let payload: MdmPayload
  try {
    payload = JSON.parse(await realNip44Decrypt(event.content, event.pubkey, keys))
  } catch {
    return null
  }
  if (!payload || payload.v !== 1 || typeof payload.from !== 'string') return null
  let verified = false
  try {
    verified = (await peerMaskedPub(payload.from, keys)) === event.pubkey
  } catch {
    verified = false
  }
  return { payload, senderRootPub: payload.from, verified }
}

/**
 * Decrypt one of MY OWN sent messages from its embedded real event (docs §3.4.1): I am the sender `M`, so
 * the conversation key is `conversationKey(M_priv, R)` with `R` the real event's `p` tag.
 */
export async function decryptOwnMdm(realEvent: Event, keys: MdmKeys): Promise<MdmPayload | null> {
  const recipientRootPub = realEvent.tags.find((t) => t[0] === 'p')?.[1]
  if (!recipientRootPub) return null
  try {
    const plaintext = await maskedSigner(recipientRootPub, keys).nip44Decrypt(recipientRootPub, realEvent.content)
    const payload: MdmPayload = JSON.parse(plaintext)
    if (!payload || payload.v !== 1) return null
    return payload
  } catch {
    return null
  }
}

/**
 * Decrypt one of my self-copy events (I am `C_to`) and return the embedded real event (docs §3.4.1). The
 * caller then reads the message with {@link decryptOwnMdm} and re-publishes `real` verbatim if needed.
 */
export async function decryptSelfCopy(event: Event, keys: MdmKeys): Promise<Event | null> {
  try {
    const toSigner = makeSubkeySigner(MDM_COPY_TO, keys)
    const payload: MdmSelfCopyPayload = JSON.parse(await toSigner.nip44Decrypt(event.pubkey, event.content))
    if (!payload || payload.v !== 1 || !payload.event) return null
    return payload.event
  } catch {
    return null
  }
}

/** The addressable coordinate of a masked message, for `reply` refs and reactions (docs §2.1, §6). */
export function mdmCoordinate(event: Pick<Event, 'pubkey' | 'tags'>): string | null {
  const d = event.tags.find((t) => t[0] === 'd')?.[1]
  return d ? `${MDM_KIND}:${event.pubkey}:${d}` : null
}
