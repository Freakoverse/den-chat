/**
 * HKDF — Domain-separated key derivation for NIP-CHAT
 *
 * Uses HKDF-SHA256 to derive encryption keys with domain isolation.
 * Each key derivation includes a static UUID salt to prevent cross-protocol
 * key reuse and a context-specific info string.
 *
 * Implements HKDF manually via HMAC-SHA256 (RFC 5869) to avoid
 * @noble/hashes/hkdf subpath export issues in Vite/browser.
 */

import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha256'
import { DOMAIN_SALT } from './constants'

const textEncoder = new TextEncoder()

/**
 * HKDF-Extract: converts input key material into a pseudorandom key.
 */
function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return hmac(sha256, salt, ikm)
}

/**
 * HKDF-Expand: expands pseudorandom key to desired length.
 */
function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const hashLen = 32 // SHA-256 output length
  const n = Math.ceil(length / hashLen)
  const okm = new Uint8Array(n * hashLen)
  let prev = new Uint8Array(0)

  for (let i = 0; i < n; i++) {
    const input = new Uint8Array(prev.length + info.length + 1)
    input.set(prev, 0)
    input.set(info, prev.length)
    input[prev.length + info.length] = i + 1
    prev = hmac(sha256, prk, input) as Uint8Array<ArrayBuffer>
    okm.set(prev, i * hashLen)
  }

  return okm.slice(0, length)
}

/**
 * Full HKDF (Extract + Expand).
 */
function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const prk = hkdfExtract(salt, ikm)
  return hkdfExpand(prk, info, length)
}

/**
 * Derive a 32-byte encryption key using HKDF-SHA256 with NIP-CHAT domain separation.
 *
 * @param inputKeyMaterial - The shared secret or hub secret (32 bytes)
 * @param info - Context string (e.g., channel UUID, "hub-messages", etc.)
 * @returns 32-byte derived key as Uint8Array
 */
export function deriveKey(inputKeyMaterial: Uint8Array, info: string): Uint8Array {
  const salt = textEncoder.encode(DOMAIN_SALT)
  const infoBytes = textEncoder.encode(info)

  return hkdfSha256(inputKeyMaterial, salt, infoBytes, 32)
}

/**
 * Derive a channel-specific message key from a hub or group secret.
 *
 * @param secret - Hub secret or grouped role secret (32 bytes)
 * @param channelId - Channel UUID
 * @param epoch - Current epoch number
 * @returns 32-byte channel message key
 */
export function deriveChannelKey(secret: Uint8Array, channelId: string, epoch: number): Uint8Array {
  return deriveKey(secret, `channel:${channelId}:epoch:${epoch}`)
}

/**
 * Derive a hub-events encryption key from the hub secret.
 * Used for calendar events (kind 31923) and RSVPs (kind 31925).
 * Separate domain from channel keys since events are hub-wide, not channel-scoped.
 *
 * @param secret - Hub secret (32 bytes)
 * @param hubDTag - Hub d tag
 * @param epoch - Current epoch number
 * @returns 32-byte events encryption key
 */
export function deriveEventsKey(secret: Uint8Array, hubDTag: string, epoch: number): Uint8Array {
  return deriveKey(secret, `events:${hubDTag}:epoch:${epoch}`)
}

/**
 * Derive a hub-reports encryption key from the hub secret.
 * Used for report events (kind 36948).
 * Separate domain from channel and events keys since reports are hub-wide moderation data.
 *
 * @param secret - Hub secret (32 bytes)
 * @param hubDTag - Hub d tag
 * @param epoch - Current epoch number
 * @returns 32-byte reports encryption key
 */
export function deriveReportsKey(secret: Uint8Array, hubDTag: string, epoch: number): Uint8Array {
  return deriveKey(secret, `reports:${hubDTag}:epoch:${epoch}`)
}
