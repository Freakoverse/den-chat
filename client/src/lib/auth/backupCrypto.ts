/**
 * backupCrypto — the encrypted seed-backup file format (shared, web-only).
 *
 * Matches the existing LoginScreen backup exactly so files are interchangeable
 * across desktop and PWA:
 *   PBKDF2-SHA256 (600k iterations) → AES-256-GCM, payload JSON v1.
 *
 * Pure WebCrypto — no native code, works in the browser and the vault origin.
 * The same format is used both for the downloadable/QR backup file AND for the
 * at-rest blob the vault stores in IndexedDB (one format, one mental model).
 */

export interface BackupPayloadV1 {
  version: 1
  alg: 'AES-256-GCM'
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: string        // base64
  iv: string          // base64
  ciphertext: string  // base64
}

const DEFAULT_ITERATIONS = 600_000

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function deriveKey(password: string, salt: Uint8Array, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

/** Encrypt a secret (mnemonic / nsec) with a password into the v1 backup payload. */
export async function encryptBackup(secret: string, password: string, iterations = DEFAULT_ITERATIONS): Promise<BackupPayloadV1> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(password, salt, iterations, 'encrypt')
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret)))
  return {
    version: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(ciphertext),
  }
}

/** Decrypt a v1 backup payload with a password. Throws if the password is wrong. */
export async function decryptBackup(payload: BackupPayloadV1, password: string): Promise<string> {
  if (payload.version !== 1 || payload.alg !== 'AES-256-GCM') throw new Error('Unrecognized backup format')
  const salt = unb64(payload.salt)
  const iv = unb64(payload.iv)
  const ciphertext = unb64(payload.ciphertext)
  const key = await deriveKey(password, salt, payload.iterations || DEFAULT_ITERATIONS, 'decrypt')
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plain)
}

/** Parse + validate a backup file's JSON text. Returns null if it isn't a v1 backup. */
export function parseBackupPayload(text: string): BackupPayloadV1 | null {
  try {
    const d = JSON.parse(text)
    if (d?.version === 1 && d?.alg === 'AES-256-GCM' && d?.salt && d?.iv && d?.ciphertext) return d as BackupPayloadV1
  } catch { /* not json */ }
  return null
}

export type VerifyResult = 'ok' | 'not-a-backup' | 'wrong-password' | 'mismatch'

/**
 * Verify a re-uploaded backup file during onboarding: confirm it's a valid v1
 * backup, that the given password decrypts it, and that it contains the secret
 * the user just backed up. Proves the file is saved, retrievable, and correct.
 */
export async function verifyBackupMatches(fileText: string, password: string, expectedSecret: string): Promise<VerifyResult> {
  const payload = parseBackupPayload(fileText)
  if (!payload) return 'not-a-backup'
  let decrypted: string
  try { decrypted = await decryptBackup(payload, password) }
  catch { return 'wrong-password' }
  return decrypted.trim() === expectedSecret.trim() ? 'ok' : 'mismatch'
}
