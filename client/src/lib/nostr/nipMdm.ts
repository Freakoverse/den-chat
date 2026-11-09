/**
 * NIP-MDM — Masked Direct Messages (see docs/NIP-MDM.md).
 *
 * A one-to-one DM where the SENDER's root never appears on the wire: the sender authors under a
 * per-recipient NIP-SKD **blinded** sub-key `M`, while the recipient is addressed by their REAL key, so
 * the recipient receives with no derivation (plain subscribe to their own key). Everything rides on the
 * base `skd:1` ops via {@link makeSubkeySigner}; this module adds the addressing/envelope conventions and
 * the kind-30092 event shape. No new signer surface.
 *
 * On the wire (docs §2, §6):
 *   - a message   (author `M`,  p = recipient root)  — `text`/`attachments` in the encrypted payload;
 *   - a reaction  (author `M`,  p = recipient root)  — a `reaction` object in the encrypted payload;
 *   - a tombstone (author `M`,  p = recipient root)  — an empty payload (no text/attachments/reaction).
 * All three are kind 30092 and indistinguishable on the wire.
 *
 * Sender recovery (docs §3.4) is a single **sent-contacts index** (author `C_from`, p = `C_to`): one
 * addressable event whose encrypted payload is the packed list of recipient ROOT pubkeys the sender has
 * messaged, most-recent first. A fresh device reads it, derives each `M`, and refetches the threads.
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

/** Sent-contacts index: packed-payload version byte and the default cap (docs §3.4). 767 is the last root
 *  count whose base64 payload stays under NIP-44's 2^15-byte padding step, so the event sits near 43 KB,
 *  well under 64 KB. */
const INDEX_VERSION = 0x01
export const MDM_INDEX_CAP = 767

export interface MdmKeys {
  privateKey?: string | null
  signer?: ISigner | null
}

/** A reaction reference carried inside the encrypted payload (docs §6). */
export interface MdmReactionRef {
  /** addressable coordinate of the reacted-to message: "30092:<authorM>:<d>" */
  target: string
  /** the reaction glyph, or a NIP-30 custom-emoji shortcode */
  emoji: string
  /** image URL for a NIP-30 custom emoji */
  customUrl?: string
}

/**
 * Decrypted payload (docs §2.1 / §6). One envelope serves messages, reactions and tombstones:
 *   - message:   `text` and/or `attachments` present;
 *   - reaction:  `reaction` present (no `text`);
 *   - tombstone: none of `text` / `attachments` / `reaction` present.
 * `emoji` / `sticker` / `gif` and `rootRef` / `isThread` are DEN client extensions (others ignore them).
 */
export interface MdmPayload {
  v: 1
  /** sender's real key, disclosed only to the recipient; verified per docs §1.3 */
  from: string
  /** REQUIRED: real original send time = the FIRST version's created_at; the sort key (docs §2.2) */
  published_at: number
  /** optional: real wall-clock time of the latest edit (present only on an edit); drives the "edited" marker */
  updated_at?: number
  text?: string
  /** a reaction instead of a message (docs §6) */
  reaction?: MdmReactionRef
  /** addressable coordinate of the replied-to message: "30092:<authorM>:<d>" */
  reply?: string
  /** addressable coordinate of the thread root (DEN extension) */
  rootRef?: string
  isThread?: boolean
  emoji?: [string, string, string?][]
  sticker?: [string, string, string?][]
  gif?: [string, string, string][]
  /** Structured file attachments (docs §2.1), private inside the encrypted payload. */
  attachments?: Attachment[]
}

/** The body a caller supplies for a message (everything but the managed envelope fields). */
export type MdmBody = Omit<MdmPayload, 'v' | 'from' | 'published_at' | 'updated_at' | 'reaction'>

/** Whether masked DMs are possible with this key setup (local key, or a signer with NIP-SKD support). */
export function mdmSupported(keys: MdmKeys): boolean {
  return canUseV2(keys)
}

/** A fresh opaque random `d` tag (16 bytes hex). docs §2. */
function randomD(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

// ── base64 (chunked so large lists don't blow the arg limit) ──
function toB64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}
function fromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
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

/** The sender's two static sent-contacts-index keys (docs §3.4). Deterministic from the root alone. */
export async function indexKeys(keys: MdmKeys): Promise<{ from: string; to: string }> {
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

/**
 * Build a masked message (docs §2, §3.1). Returns the signed real event; the caller publishes it to the
 * recipient's relays, the sender's own relays, and the client relay list (docs §5), then updates the
 * sent-contacts index (docs §3.4).
 *
 * For an EDIT pass the original `d`, `createdAt = previous created_at + 1`, the unchanged `publishedAt`,
 * and `updatedAt = now` (docs §2.2). A tombstone (delete) is an edit with an empty `body`.
 */
export async function buildMdmMessage(opts: {
  recipientRootPub: string
  myRootPub: string
  body: MdmBody
  keys: MdmKeys
  d?: string
  createdAt?: number
  /** original send time; defaults to this event's created_at (first send) */
  publishedAt?: number
  /** wall-clock edit time; present only on an edit */
  updatedAt?: number
  /** Per-message auto-delete (NIP-40): stamp expiry = created_at + this (seconds) on the real event. */
  expirationSeconds?: number
}): Promise<{ real: Event; maskedPub: string }> {
  const mSigner = maskedSigner(opts.recipientRootPub, opts.keys)
  const maskedPub = await mSigner.getPublicKey()
  const createdAt = opts.createdAt ?? nowSeconds()
  const payload: MdmPayload = {
    v: 1,
    from: opts.myRootPub,
    published_at: opts.publishedAt ?? createdAt,
    ...(opts.updatedAt ? { updated_at: opts.updatedAt } : {}),
    ...opts.body,
  }
  const content = await mSigner.nip44Encrypt(opts.recipientRootPub, JSON.stringify(payload))
  const tags: string[][] = [['d', opts.d ?? randomD()], ['p', opts.recipientRootPub]]
  if (opts.expirationSeconds && opts.expirationSeconds > 0) {
    tags.push(['expiration', Math.floor(createdAt + opts.expirationSeconds).toString()])
  }
  const unsigned: UnsignedEvent = { kind: MDM_KIND, created_at: createdAt, tags, content, pubkey: maskedPub }
  const real = await mSigner.signEvent(unsigned)
  return { real, maskedPub }
}

/**
 * Build a masked reaction (docs §6): a kind-30092 event authored by the reactor's masked key `M`, with the
 * reaction glyph and the target coordinate NIP-44-encrypted inside the payload (only `d`/`p` public), so it
 * is indistinguishable from a message. Returns the signed event; the caller publishes it like a message.
 */
export async function buildMdmReaction(opts: {
  targetCoordinate: string
  recipientRootPub: string
  myRootPub: string
  emoji: string
  customUrl?: string
  keys: MdmKeys
  /** reuse an existing reaction coordinate to change/remove it (docs §6); else a fresh random d */
  d?: string
  createdAt?: number
}): Promise<{ real: Event; maskedPub: string }> {
  const mSigner = maskedSigner(opts.recipientRootPub, opts.keys)
  const maskedPub = await mSigner.getPublicKey()
  const createdAt = opts.createdAt ?? nowSeconds()
  const reaction: MdmReactionRef = {
    target: opts.targetCoordinate,
    emoji: opts.emoji,
    ...(opts.customUrl ? { customUrl: opts.customUrl } : {}),
  }
  const payload: MdmPayload = { v: 1, from: opts.myRootPub, published_at: createdAt, reaction }
  const content = await mSigner.nip44Encrypt(opts.recipientRootPub, JSON.stringify(payload))
  const unsigned: UnsignedEvent = {
    kind: MDM_KIND,
    created_at: createdAt,
    tags: [['d', opts.d ?? randomD()], ['p', opts.recipientRootPub]],
    content,
    pubkey: maskedPub,
  }
  const real = await mSigner.signEvent(unsigned)
  return { real, maskedPub }
}

export interface MdmDecrypted {
  payload: MdmPayload
  /** the sender's real root, taken from `from` and confirmed against the masked author (docs §1.3) */
  senderRootPub: string
  /** true once `getPeerBlindedPubkey(from) == event.pubkey`; false = spoofed/unverifiable `from` */
  verified: boolean
}

/** A decrypted payload is a tombstone when it carries no message content and no reaction (docs §2.1 / §6). */
export function isTombstone(p: MdmPayload): boolean {
  return !p.text && !p.reaction && !(p.attachments && p.attachments.length)
}

/**
 * Decrypt a RECEIVED masked event (I am the recipient, unmasked) and verify its sender (docs §1.3, §3.2).
 * Decryption uses my real key against the visible masked author; verification re-derives the claimed
 * sender's masked key and checks it equals the author. The payload may be a message, a reaction, or a
 * tombstone; the caller routes on `reaction` / {@link isTombstone}.
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
 * Decrypt one of MY OWN events (refetched from relays, docs §3.4): I am the sender `M`, so the conversation
 * key is `conversationKey(M_priv, R)` with `R` the event's `p` tag. Works for a message, reaction, or
 * tombstone (same envelope).
 */
export async function decryptOwnMdm(event: Event, keys: MdmKeys): Promise<MdmPayload | null> {
  const recipientRootPub = event.tags.find((t) => t[0] === 'p')?.[1]
  if (!recipientRootPub) return null
  try {
    const payload: MdmPayload = JSON.parse(await maskedSigner(recipientRootPub, keys).nip44Decrypt(recipientRootPub, event.content))
    if (!payload || payload.v !== 1) return null
    return payload
  } catch {
    return null
  }
}

/**
 * Build the sender's sent-contacts index event (docs §3.4): author `C_from`, p = `C_to`, with the packed,
 * base64-encoded list of recipient ROOT pubkeys (most-recent first, capped) NIP-44-encrypted from
 * `C_from` to `C_to`. Reuse the existing `d` so updates replace in place; on first create pass a random one.
 */
export async function buildSentContactsIndex(opts: {
  roots: string[]
  keys: MdmKeys
  d: string
  createdAt?: number
}): Promise<Event> {
  const fromSigner = makeSubkeySigner(MDM_COPY_FROM, opts.keys)
  const [cFrom, cTo] = await Promise.all([fromSigner.getPublicKey(), makeSubkeySigner(MDM_COPY_TO, opts.keys).getPublicKey()])
  const capped = opts.roots.slice(0, MDM_INDEX_CAP)
  const bytes = new Uint8Array(1 + capped.length * 32)
  bytes[0] = INDEX_VERSION
  capped.forEach((r, i) => bytes.set(hexToBytes(r), 1 + i * 32))
  const content = await fromSigner.nip44Encrypt(cTo, toB64(bytes))
  const unsigned: UnsignedEvent = {
    kind: MDM_KIND,
    created_at: opts.createdAt ?? nowSeconds(),
    tags: [['d', opts.d], ['p', cTo]],
    content,
    pubkey: cFrom,
  }
  return fromSigner.signEvent(unsigned)
}

/** Decrypt a sent-contacts index event (I am `C_to`) and return its recipient-root list (docs §3.4). */
export async function parseSentContactsIndex(event: Event, keys: MdmKeys): Promise<string[] | null> {
  try {
    const b64 = await makeSubkeySigner(MDM_COPY_TO, keys).nip44Decrypt(event.pubkey, event.content)
    const bytes = fromB64(b64)
    if (bytes.length === 0 || bytes[0] !== INDEX_VERSION) return null
    const out: string[] = []
    for (let i = 1; i + 32 <= bytes.length; i += 32) out.push(bytesToHex(bytes.subarray(i, i + 32)))
    return out
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

/** The addressable coordinate of a masked event, for `reply` refs and reactions (docs §2.1, §6). */
export function mdmCoordinate(event: Pick<Event, 'pubkey' | 'tags'>): string | null {
  const d = event.tags.find((t) => t[0] === 'd')?.[1]
  return d ? `${MDM_KIND}:${event.pubkey}:${d}` : null
}
