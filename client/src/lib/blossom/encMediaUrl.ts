/**
 * encMediaUrl — wire format for encrypted Blossom attachments in text content
 *
 * Some message types (NIP-04 DMs) carry attachments as plain URLs inside the
 * message body rather than as structured metadata. When a file is encrypted
 * before upload, the recipient needs the per-file AES-256-GCM key/nonce to
 * decrypt it. We deliver those by appending them as a URL *fragment*:
 *
 *   https://server/<ciphertextHash>.ext#dk=<keyHex>&dn=<nonceHex>&doh=<originalHashHex>
 *
 * The fragment is never transmitted in an HTTP request (browsers strip it), and
 * for DMs the whole URL lives inside the already end-to-end-encrypted message
 * body — so the key only ever reaches the two conversation parties.
 *
 *   dk  = decryption key (AES-256, 64 hex)
 *   dn  = decryption nonce (AES-GCM IV, 24 hex)
 *   doh = decrypted/original file hash (sha256 of plaintext, 64 hex) — integrity check
 */

export interface FileDecryptionInfo {
  keyHex: string
  nonceHex: string
  originalHashHex: string
}

/** Append AES-GCM decryption params to a media URL as a fragment. */
export function appendDecryptionFragment(url: string, enc: FileDecryptionInfo): string {
  return `${url}#dk=${enc.keyHex}&dn=${enc.nonceHex}&doh=${enc.originalHashHex}`
}

/**
 * Parse decryption params from a URL fragment (with or without the leading '#').
 * Returns null if the key/nonce are absent or malformed.
 */
export function parseDecryptionFragment(fragment: string): FileDecryptionInfo | null {
  const frag = fragment.startsWith('#') ? fragment.slice(1) : fragment
  if (!frag) return null
  const params = new URLSearchParams(frag)
  const keyHex = params.get('dk') || ''
  const nonceHex = params.get('dn') || ''
  const originalHashHex = params.get('doh') || ''
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) return null
  if (!/^[a-f0-9]{24}$/i.test(nonceHex)) return null
  return { keyHex, nonceHex, originalHashHex }
}
