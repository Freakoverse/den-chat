/**
 * NIP-04 DM — Standard Encrypted Direct Messages (Kind 4)
 *
 * Uses NIP-04 encryption (ECDH shared secret + AES-256-CBC).
 * Less private than NIP-17 (metadata visible) but supports
 * replies, thread replies, and emoji reactions.
 */

import { nip04 } from 'nostr-tools'
import type { ISigner } from '@/stores/userStore'

/**
 * Encrypt content for a NIP-04 DM.
 * Handles all signer paths: raw key, NIP-07, NIP-46, PC55, UPV2.
 */
export async function encryptNip04(
  content: string,
  recipientPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  if (privateKey) {
    return nip04.encrypt(privateKey, recipientPubkey, content)
  }
  if (signer?.nip04?.encrypt) {
    return signer.nip04.encrypt(recipientPubkey, content)
  }
  if ((signer as any)?.nip04Encrypt) {
    return (signer as any).nip04Encrypt(recipientPubkey, content)
  }
  throw new Error('No private key or NIP-04 signer available for encryption')
}

/**
 * Decrypt content from a NIP-04 DM.
 * Handles all signer paths: raw key, NIP-07, NIP-46, PC55, UPV2.
 */
export async function decryptNip04(
  ciphertext: string,
  senderPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  if (privateKey) {
    return nip04.decrypt(privateKey, senderPubkey, ciphertext)
  }
  if (signer?.nip04?.decrypt) {
    return signer.nip04.decrypt(senderPubkey, ciphertext)
  }
  if ((signer as any)?.nip04Decrypt) {
    return (signer as any).nip04Decrypt(senderPubkey, ciphertext)
  }
  throw new Error('No private key or NIP-04 signer available for decryption')
}
