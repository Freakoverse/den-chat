/**
 * NIP-04 DM — Standard Encrypted Direct Messages (Kind 4)
 *
 * Uses NIP-04 encryption (ECDH shared secret + AES-256-CBC).
 * Less private than NIP-17 (metadata visible) but supports
 * replies, thread replies, and emoji reactions.
 *
 * All remote-signer calls are routed through SignerGuard for
 * exponential backoff and circuit-breaker protection.
 */

import { nip04 } from 'nostr-tools'
import { guardedDecrypt, guardedEncrypt } from '@/lib/auth/signerGuard'
import type { ISigner } from '@/stores/userStore'

/**
 * Encrypt content for a NIP-04 DM.
 * Handles all signer paths: raw key, NIP-07, NIP-46, PC55, UPV2.
 * Remote signers are protected by SignerGuard (backoff + circuit breaker).
 */
export async function encryptNip04(
  content: string,
  recipientPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  return guardedEncrypt(content, recipientPubkey, signer, privateKey, 'nip04')
}

/**
 * Decrypt content from a NIP-04 DM.
 * Handles all signer paths: raw key, NIP-07, NIP-46, PC55, UPV2.
 * Remote signers are protected by SignerGuard (backoff + circuit breaker).
 */
export async function decryptNip04(
  ciphertext: string,
  senderPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  return guardedDecrypt(ciphertext, senderPubkey, signer, privateKey, 'nip04')
}
