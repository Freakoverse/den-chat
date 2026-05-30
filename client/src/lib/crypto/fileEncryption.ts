/**
 * File Encryption — AES-256-GCM for NIP-17 kind 15 file messages
 *
 * Encrypts files client-side before uploading to Blossom servers,
 * so that only conversation participants (who receive the decryption
 * key inside the gift-wrapped kind 15 rumor) can view the file content.
 *
 * Uses the Web Crypto API (SubtleCrypto) — zero dependencies.
 */

/* ─── Helpers ─── */

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data.slice() as Uint8Array<ArrayBuffer>)
  return bytesToHex(new Uint8Array(hash))
}

/* ─── Types ─── */

export interface EncryptedFile {
  /** The encrypted file bytes (ciphertext + AES-GCM auth tag) */
  cipherBytes: Uint8Array
  /** AES-256 key in hex (64 chars) */
  keyHex: string
  /** AES-GCM nonce/IV in hex (24 chars = 12 bytes) */
  nonceHex: string
  /** SHA-256 hash of the original plaintext file (hex) */
  originalHashHex: string
  /** SHA-256 hash of the encrypted file (hex) — used as Blossom address */
  encryptedHashHex: string
}

/* ─── Encrypt ─── */

/**
 * Encrypt a file using AES-256-GCM.
 *
 * Generates a random 256-bit key and 96-bit nonce, encrypts the file,
 * and returns the ciphertext alongside the key/nonce needed for decryption.
 *
 * The ciphertext includes the GCM authentication tag (appended by SubtleCrypto).
 */
export async function encryptFile(plainBytes: Uint8Array): Promise<EncryptedFile> {
  // Generate random key (256 bits) and nonce (96 bits)
  const rawKey = crypto.getRandomValues(new Uint8Array(32))
  const nonce = crypto.getRandomValues(new Uint8Array(12))

  // Import the key for AES-GCM
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  )

  // Encrypt (returns ciphertext + 128-bit auth tag appended)
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cryptoKey,
    plainBytes.slice() as Uint8Array<ArrayBuffer>,
  )

  const cipherBytes = new Uint8Array(cipherBuffer)

  // Compute hashes
  const [originalHashHex, encryptedHashHex] = await Promise.all([
    sha256Hex(plainBytes),
    sha256Hex(cipherBytes),
  ])

  return {
    cipherBytes,
    keyHex: bytesToHex(rawKey),
    nonceHex: bytesToHex(nonce),
    originalHashHex,
    encryptedHashHex,
  }
}

/* ─── Decrypt ─── */

/**
 * Decrypt a file that was encrypted with AES-256-GCM.
 *
 * @param cipherBytes  The encrypted file bytes (ciphertext + auth tag)
 * @param keyHex       The AES-256 key in hex (64 chars)
 * @param nonceHex     The AES-GCM nonce in hex (24 chars)
 * @returns            The decrypted plaintext bytes
 */
export async function decryptFile(
  cipherBytes: Uint8Array,
  keyHex: string,
  nonceHex: string,
): Promise<Uint8Array> {
  const rawKey = hexToBytes(keyHex)
  const nonce = hexToBytes(nonceHex)

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey.slice() as Uint8Array<ArrayBuffer>,
    { name: 'AES-GCM' },
    false,
    ['decrypt'],
  )

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce.slice() as Uint8Array<ArrayBuffer> },
    cryptoKey,
    cipherBytes.slice() as Uint8Array<ArrayBuffer>,
  )

  return new Uint8Array(plainBuffer)
}
