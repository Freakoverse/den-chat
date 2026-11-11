/**
 * backupCrypto — the encrypted seed-backup file format (shared across desktop + PWA + vault).
 *
 * Two versions, one mental model (both AES-256-GCM):
 *   - v2 (current, what new backups use): Argon2id(password) → AES-256-GCM.
 *   - v1 (legacy, read-only): PBKDF2-SHA256 (600k) → AES-256-GCM.
 *
 * New exports are always v2. Decryption/verification accept BOTH, dispatched on the `kdf`/`version`
 * field, so every old v1 backup file still imports unchanged. Argon2id runs via @noble/hashes'
 * async variant (already a dependency) so the webview doesn't freeze; AES-GCM is WebCrypto.
 *
 * Argon2 params are stored IN the payload, so they're tunable later without breaking old files.
 */

import { argon2idAsync } from '@noble/hashes/argon2'

export interface BackupPayloadV1 {
  version: 1
  alg: 'AES-256-GCM'
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: string        // base64
  iv: string          // base64
  ciphertext: string  // base64
}

export interface BackupPayloadV2 {
  version: 2
  alg: 'AES-256-GCM'
  kdf: 'Argon2id'
  m: number           // memory cost, KiB
  t: number           // time cost (iterations)
  p: number           // parallelism (lanes)
  salt: string        // base64
  iv: string          // base64
  ciphertext: string  // base64
}

export type BackupPayload = BackupPayloadV1 | BackupPayloadV2

// v1 (legacy) KDF parameter.
const DEFAULT_ITERATIONS = 600_000
// v2 Argon2id parameters. Pure-JS in the webview, so moderate memory (still far stronger than PBKDF2
// for a short PIN). One-time cost on backup create/import.
const ARGON2_M = 19 * 1024 // 19 MiB, in KiB
const ARGON2_T = 2
const ARGON2_P = 1

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

// ── v1 (PBKDF2) key derivation — kept for decrypting legacy backups ──
async function deriveKeyPbkdf2(password: string, salt: Uint8Array, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

// ── v2 (Argon2id) key derivation ──
async function deriveKeyArgon2(password: string, salt: Uint8Array, m: number, t: number, p: number, usage: KeyUsage): Promise<CryptoKey> {
  const raw = await argon2idAsync(new TextEncoder().encode(password), salt, { m, t, p, dkLen: 32 })
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [usage])
}

/** Encrypt a secret (mnemonic / nsec) with a password into a v2 (Argon2id) backup payload. */
export async function encryptBackup(secret: string, password: string): Promise<BackupPayloadV2> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKeyArgon2(password, salt, ARGON2_M, ARGON2_T, ARGON2_P, 'encrypt')
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret)))
  return {
    version: 2,
    alg: 'AES-256-GCM',
    kdf: 'Argon2id',
    m: ARGON2_M,
    t: ARGON2_T,
    p: ARGON2_P,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(ciphertext),
  }
}

/** Decrypt a v1 (PBKDF2) or v2 (Argon2id) backup payload. Throws if the password is wrong. */
export async function decryptBackup(payload: BackupPayload, password: string): Promise<string> {
  if (payload.alg !== 'AES-256-GCM') throw new Error('Unrecognized backup format')
  const salt = unb64(payload.salt)
  const iv = unb64(payload.iv)
  const ciphertext = unb64(payload.ciphertext)
  let key: CryptoKey
  if (payload.version === 2 && payload.kdf === 'Argon2id') {
    key = await deriveKeyArgon2(password, salt, payload.m || ARGON2_M, payload.t || ARGON2_T, payload.p || ARGON2_P, 'decrypt')
  } else if (payload.version === 1 && payload.kdf === 'PBKDF2-SHA256') {
    key = await deriveKeyPbkdf2(password, salt, payload.iterations || DEFAULT_ITERATIONS, 'decrypt')
  } else {
    throw new Error('Unrecognized backup format')
  }
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return new TextDecoder().decode(plain)
}

/** Parse + validate a backup file's JSON text. Returns null if it isn't a v1 or v2 backup. */
export function parseBackupPayload(text: string): BackupPayload | null {
  try {
    const d = JSON.parse(text)
    if (d?.alg !== 'AES-256-GCM' || !d?.salt || !d?.iv || !d?.ciphertext) return null
    if (d.version === 2 && d.kdf === 'Argon2id') return d as BackupPayloadV2
    if (d.version === 1 && d.kdf === 'PBKDF2-SHA256') return d as BackupPayloadV1
  } catch { /* not json */ }
  return null
}

export type VerifyResult = 'ok' | 'not-a-backup' | 'wrong-password' | 'mismatch'

/**
 * Verify a re-uploaded backup file during onboarding: confirm it's a valid backup (v1 or v2), that
 * the given password decrypts it, and that it contains the secret the user just backed up. Proves the
 * file is saved, retrievable, and correct.
 */
export async function verifyBackupMatches(fileText: string, password: string, expectedSecret: string): Promise<VerifyResult> {
  const payload = parseBackupPayload(fileText)
  if (!payload) return 'not-a-backup'
  let decrypted: string
  try { decrypted = await decryptBackup(payload, password) }
  catch { return 'wrong-password' }
  return decrypted.trim() === expectedSecret.trim() ? 'ok' : 'mismatch'
}
