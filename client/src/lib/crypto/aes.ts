/**
 * AES-256-GCM — Authenticated encryption for NIP-CHAT messages
 *
 * Format: base64(12-byte-IV || ciphertext || 16-byte-auth-tag)
 * This matches the spec in NIP-CHAT §5.2.
 */

import { AES_IV_LENGTH } from './constants'

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * @param key - 32-byte encryption key (Uint8Array)
 * @param plaintext - UTF-8 string to encrypt
 * @returns base64 string: base64(IV || ciphertext || auth-tag)
 */
export async function aesEncrypt(key: Uint8Array, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH))
  const encodedText = new TextEncoder().encode(plaintext)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.slice() as Uint8Array<ArrayBuffer>,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  )

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    encodedText
  )

  // Combine: IV || ciphertext (which includes the 16-byte auth tag appended by WebCrypto)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)

  return btoa(String.fromCharCode(...combined))
}

/**
 * Decrypt AES-256-GCM ciphertext.
 *
 * @param key - 32-byte encryption key (Uint8Array)
 * @param encoded - base64 string: base64(IV || ciphertext || auth-tag)
 * @returns Decrypted UTF-8 string
 * @throws Error if decryption fails (wrong key, tampered data)
 */
export async function aesDecrypt(key: Uint8Array, encoded: string): Promise<string> {
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))

  if (combined.length < AES_IV_LENGTH + 16) {
    throw new Error('Ciphertext too short')
  }

  const iv = combined.slice(0, AES_IV_LENGTH)
  const ciphertext = combined.slice(AES_IV_LENGTH)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key.slice() as Uint8Array<ArrayBuffer>,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  )

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    ciphertext
  )

  return new TextDecoder().decode(plaintext)
}
