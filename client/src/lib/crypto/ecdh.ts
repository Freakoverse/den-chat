/**
 * ECDH — Shared secret derivation using secp256k1
 *
 * Used by hub creators to derive ECDH shared secrets with each member,
 * then encrypt the hub secret for each member individually.
 */

import { getSharedSecret } from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { hexToBytes } from '@noble/hashes/utils'

/**
 * Compute ECDH shared secret between two secp256k1 keys.
 *
 * @param privateKeyHex - 32-byte private key as hex string
 * @param publicKeyHex - 32-byte x-only public key as hex string (Nostr format)
 * @returns 32-byte shared secret as Uint8Array
 */
export function computeSharedSecret(privateKeyHex: string, publicKeyHex: string): Uint8Array {
  // Nostr uses x-only pubkeys (32 bytes). secp256k1 getSharedSecret needs
  // the full compressed pubkey (33 bytes with 02 prefix).
  const fullPubkey = '02' + publicKeyHex

  // getSharedSecret returns the x-coordinate of the shared point (32 bytes)
  const rawShared = getSharedSecret(hexToBytes(privateKeyHex), hexToBytes(fullPubkey), true)

  // Hash the raw shared point to get a uniform 32-byte key
  // (standard practice — same as NIP-44)
  return sha256(rawShared.slice(1)) // skip the 02 prefix byte
}
