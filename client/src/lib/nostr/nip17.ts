/**
 * NIP-17 Gift Wrap — Private Direct Messages
 *
 * Protocol: kind 14/15 (rumor, unsigned) → kind 13 (seal, NIP-44) → kind 1059 (gift wrap, NIP-44)
 *
 * - Rumor (kind 14): unsigned DM text content, deniable
 * - File  (kind 15): unsigned DM file attachment, deniable
 * - Seal (kind 13): encrypts rumor to recipient using sender's real key
 * - Gift Wrap (kind 1059): encrypts seal using a random throwaway key, hides metadata
 */

import { nip44, getPublicKey, finalizeEvent } from 'nostr-tools'
import { getEventHash } from 'nostr-tools/pure'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import type { ISigner } from '@/stores/userStore'

/* ─── Types ─── */

export interface DMRumor {
  kind: 14 | 15
  pubkey: string
  created_at: number
  tags: string[][]
  content: string
}

export interface UnwrappedDM {
  /** The inner kind-14 or kind-15 rumor */
  rumor: DMRumor
  /** Pubkey of the real sender (from the seal) */
  senderPubkey: string
  /** Pubkey of the gift wrap recipient (from p-tag on 1059) */
  recipientPubkey: string
  /** Gift wrap event id (for deduplication) */
  wrapId: string
  /** Timestamp of the gift wrap (randomized per spec, use rumor.created_at for ordering) */
  wrapCreatedAt: number
}

/* ─── Helpers ─── */

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Generate a random private key (32 bytes) */
function generateRandomPrivateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

/** Randomize timestamp within the past 48 hours (per NIP-17 spec).
 *  Only randomizes into the PAST — relays reject future `created_at` as "too late". */
function randomizedTimestamp(): number {
  const now = Math.floor(Date.now() / 1000)
  const twoDays = 2 * 24 * 60 * 60
  const offset = Math.floor(Math.random() * twoDays) // 0 to 48h
  return now - offset // Always in the past
}

/** Track whether we've already warned about NIP-44 unavailability */
let warnedNip44 = false

/* ─── NIP-44 encrypt/decrypt wrappers ─── */

async function nip44Encrypt(
  plaintext: string,
  senderPrivkeyHex: string | null,
  recipientPubkey: string,
  signer: ISigner | null,
): Promise<string> {
  // Raw key path
  if (senderPrivkeyHex) {
    const conversationKey = nip44.v2.utils.getConversationKey(
      hexToBytes(senderPrivkeyHex),
      recipientPubkey,
    )
    return nip44.v2.encrypt(plaintext, conversationKey)
  }

  // Signer path
  if (signer?.nip44?.encrypt) {
    return signer.nip44.encrypt(recipientPubkey, plaintext)
  }

  throw new Error('No private key or NIP-44 signer available for encryption')
}

async function nip44Decrypt(
  ciphertext: string,
  recipientPrivkeyHex: string | null,
  senderPubkey: string,
  signer: ISigner | null,
): Promise<string> {
  // Raw key path
  if (recipientPrivkeyHex) {
    const conversationKey = nip44.v2.utils.getConversationKey(
      hexToBytes(recipientPrivkeyHex),
      senderPubkey,
    )
    return nip44.v2.decrypt(ciphertext, conversationKey)
  }

  // Signer path
  if (signer?.nip44?.decrypt) {
    return signer.nip44.decrypt(senderPubkey, ciphertext)
  }

  if (!warnedNip44) {
    warnedNip44 = true
    console.warn('[NIP-17] No private key or NIP-44 signer available for decryption')
  }
  throw new Error('No private key or NIP-44 signer available for decryption')
}

/* ─── Gift Wrap (send) ─── */

/**
 * Create and publish a NIP-17 gift-wrapped DM.
 *
 * 1. Create kind 14 rumor (unsigned)
 * 2. Seal it in kind 13 (encrypted to recipient with sender's key)
 * 3. Gift-wrap in kind 1059 (encrypted with random throwaway key)
 *
 * Returns the gift wrap event ready to publish.
 * Must be published to BOTH sender's and recipient's relays.
 */
export async function createGiftWrap(
  content: string,
  recipientPubkey: string,
  senderPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  tags: string[][] = [],
): Promise<{ wrapForRecipient: Record<string, unknown>; wrapForSelf: Record<string, unknown>; rumor: DMRumor }> {

  // 1. Create the rumor (kind 14, unsigned)
  const rumorTags: string[][] = [
    ['p', recipientPubkey],
    ...tags,
  ]

  // Add client tag if enabled in preferences
  if (typeof window !== 'undefined' && localStorage.getItem('den-chat-client-tag') !== 'false') {
    rumorTags.push(['client', 'DEN Chat'])
  }

  const rumor: DMRumor = {
    kind: STANDARD_KINDS.DM_RUMOR,
    pubkey: senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: rumorTags,
    content,
  }

  const rumorJson = JSON.stringify(rumor)

  // 2. Create seal for recipient (kind 13)
  const sealForRecipient = await createSeal(rumorJson, senderPubkey, recipientPubkey, signer, privateKey)

  // 3. Gift-wrap the seal for recipient (kind 1059, throwaway key)
  const wrapForRecipient = createWrapEnvelope(JSON.stringify(sealForRecipient), recipientPubkey)

  // 4. Also create a copy gift-wrapped for self (so sender can read their own DMs)
  const sealForSelf = await createSeal(rumorJson, senderPubkey, senderPubkey, signer, privateKey)
  const wrapForSelf = createWrapEnvelope(JSON.stringify(sealForSelf), senderPubkey)

  return { wrapForRecipient, wrapForSelf, rumor }
}

/* ─── Rumor ID computation ─── */

/** Compute the deterministic ID for an unsigned rumor (same as a signed event, but no sig). */
export function computeRumorId(rumor: DMRumor): string {
  return getEventHash({
    pubkey: rumor.pubkey,
    created_at: rumor.created_at,
    kind: rumor.kind,
    tags: rumor.tags,
    content: rumor.content,
  })
}

/* ─── File Gift Wrap (kind 15) ─── */

export interface FileGiftWrapParams {
  /** URL of the encrypted file on Blossom */
  fileUrl: string
  /** Original file MIME type (before encryption) */
  mimeType: string
  /** AES-256-GCM decryption key (hex) */
  decryptionKey: string
  /** AES-GCM nonce (hex) */
  decryptionNonce: string
  /** SHA-256 of the encrypted file (hex) */
  encryptedHash: string
  /** SHA-256 of the original plaintext file (hex) */
  originalHash: string
  /** Encrypted file size in bytes */
  size?: number
  /** Image/video dimensions "widthxheight" */
  dim?: string
  /** Optional: ID of a kind-14 rumor this file is attached to */
  parentRumorId?: string
}

/**
 * Create a gift-wrapped kind-15 file message.
 *
 * The file URL goes in `.content`, all encryption metadata goes in tags.
 * If parentRumorId is provided, adds an `e` tag linking this file to a kind-14 text message.
 */
export async function createFileGiftWrap(
  params: FileGiftWrapParams,
  recipientPubkey: string,
  senderPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<{ wrapForRecipient: Record<string, unknown>; wrapForSelf: Record<string, unknown> }> {

  // Build tags for the kind-15 rumor
  const rumorTags: string[][] = [
    ['p', recipientPubkey],
    ['file-type', params.mimeType],
    ['encryption-algorithm', 'aes-gcm'],
    ['decryption-key', params.decryptionKey],
    ['decryption-nonce', params.decryptionNonce],
    ['x', params.encryptedHash],
    ['ox', params.originalHash],
  ]

  if (params.size !== undefined) {
    rumorTags.push(['size', String(params.size)])
  }
  if (params.dim) {
    rumorTags.push(['dim', params.dim])
  }

  // Link to parent kind-14 text message if provided
  if (params.parentRumorId) {
    rumorTags.push(['e', params.parentRumorId])
  }

  // Add client tag if enabled
  if (typeof window !== 'undefined' && localStorage.getItem('den-chat-client-tag') !== 'false') {
    rumorTags.push(['client', 'DEN Chat'])
  }

  const rumor: DMRumor = {
    kind: STANDARD_KINDS.DM_FILE,
    pubkey: senderPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: rumorTags,
    content: params.fileUrl,
  }

  const rumorJson = JSON.stringify(rumor)

  // Seal + gift-wrap (same flow as kind 14)
  const sealForRecipient = await createSeal(rumorJson, senderPubkey, recipientPubkey, signer, privateKey)
  const wrapForRecipient = createWrapEnvelope(JSON.stringify(sealForRecipient), recipientPubkey)

  const sealForSelf = await createSeal(rumorJson, senderPubkey, senderPubkey, signer, privateKey)
  const wrapForSelf = createWrapEnvelope(JSON.stringify(sealForSelf), senderPubkey)

  return { wrapForRecipient, wrapForSelf }
}

/** Create a kind 13 seal: encrypt the rumor JSON to the target pubkey */
async function createSeal(
  rumorJson: string,
  senderPubkey: string,
  targetPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<Record<string, unknown>> {
  const encryptedContent = await nip44Encrypt(rumorJson, privateKey, targetPubkey, signer)

  const sealEvent = {
    kind: STANDARD_KINDS.SEAL,
    pubkey: senderPubkey,
    created_at: randomizedTimestamp(),
    tags: [],
    content: encryptedContent,
  }

  // Sign the seal with the sender's real key
  if (privateKey) {
    return finalizeEvent(sealEvent, hexToBytes(privateKey)) as unknown as Record<string, unknown>
  }
  if (signer) {
    return await signer.signEvent(sealEvent)
  }
  throw new Error('No signer or private key available')
}

/** Create a kind 1059 gift wrap: encrypt the seal JSON with a random throwaway key */
function createWrapEnvelope(
  sealJson: string,
  recipientPubkey: string,
): Record<string, unknown> {
  const throwawayPriv = generateRandomPrivateKey()
  const throwawayPub = getPublicKey(throwawayPriv)

  const conversationKey = nip44.v2.utils.getConversationKey(throwawayPriv, recipientPubkey)
  const encryptedSeal = nip44.v2.encrypt(sealJson, conversationKey)

  const wrapEvent = {
    kind: STANDARD_KINDS.GIFT_WRAP,
    pubkey: throwawayPub,
    created_at: randomizedTimestamp(),
    tags: [['p', recipientPubkey]],
    content: encryptedSeal,
  }

  // Sign with the throwaway key
  return finalizeEvent(wrapEvent, throwawayPriv) as unknown as Record<string, unknown>
}

/* ─── Unwrap (receive) ─── */

/**
 * Unwrap a kind 1059 gift wrap event to extract the inner DM rumor.
 *
 * 1. Decrypt the outer gift wrap (NIP-44 with our key + gift wrap pubkey)
 * 2. Parse the kind 13 seal
 * 3. Decrypt the seal content (NIP-44 with our key + seal pubkey)
 * 4. Parse the kind 14 rumor
 */
export async function unwrapGiftWrap(
  giftWrapEvent: { id: string; pubkey: string; created_at: number; content: string; tags: string[][] },
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<UnwrappedDM | null> {
  try {
    // 1. Decrypt the gift wrap outer layer
    const sealJson = await nip44Decrypt(
      giftWrapEvent.content,
      privateKey,
      giftWrapEvent.pubkey, // throwaway pubkey
      signer,
    )

    // 2. Parse the seal (kind 13)
    const seal = JSON.parse(sealJson)
    if (seal.kind !== STANDARD_KINDS.SEAL) {
      console.warn('[NIP-17] Expected kind 13 seal, got:', seal.kind)
      return null
    }

    // 3. Decrypt the seal content
    const rumorJson = await nip44Decrypt(
      seal.content,
      privateKey,
      seal.pubkey, // sender's real pubkey
      signer,
    )

    // 4. Parse the rumor (kind 14 or 15)
    const rumor: DMRumor = JSON.parse(rumorJson)
    if (rumor.kind !== STANDARD_KINDS.DM_RUMOR && rumor.kind !== STANDARD_KINDS.DM_FILE) {
      console.warn('[NIP-17] Expected kind 14 or 15 rumor, got:', rumor.kind)
      return null
    }

    // Determine recipient from the gift wrap p-tag
    const recipientTag = giftWrapEvent.tags.find((t) => t[0] === 'p')
    const recipientPubkey = recipientTag?.[1] || myPubkey

    return {
      rumor,
      senderPubkey: seal.pubkey,
      recipientPubkey,
      wrapId: giftWrapEvent.id,
      wrapCreatedAt: giftWrapEvent.created_at,
    }
  } catch {
    // Silently skip events that can't be unwrapped (wrong key, different protocol, etc.)
    return null
  }
}
