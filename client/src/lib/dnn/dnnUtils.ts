/**
 * DNN (Decentralized Naming Network) — Utility functions
 *
 * Format detection and validation for DNN IDs stored in the nip05 profile field.
 * DNN IDs have no '@' character (standard NIP-05 always does).
 *
 * Valid formats:
 *   Encoded:  nabandonzooa, ndieseljazzas  (n + two BIP39 words + optional cycle + position letters)
 *   N-format: n4, n4.8, n5h, n5h.3        (n + digits + optional shorthand + .position)
 *   B-format: b922664, b922664.8, b1m50    (b + digits + optional shorthand + .position)
 */

/** Numeric DNN format: n4, n4.8, n5h.3, b922664, b1m50 etc. */
const NUMERIC_RE = /^[nb]\d+[hkmbtqdqtso]?(\.\d+)?$/i

/**
 * Encoded V2 format: n + 3+ letters (word1) + 3+ letters (word2) + optional cycle digits + 1+ position letters.
 * Minimum total length after prefix = 7 chars (3+3+1), so >= 8 total.
 */
const ENCODED_RE = /^n[a-z]{3,}[0-9]*[a-z]+$/i

/**
 * Returns true if the nip05 value is a DNN ID (no '@', valid DNN format).
 * Standard NIP-05 addresses always contain '@'.
 */
export function isDnnId(nip05: string | undefined | null): boolean {
  if (!nip05) return false
  const trimmed = nip05.trim()
  if (!trimmed || trimmed.includes('@')) return false
  return isValidDnnFormat(trimmed)
}

/**
 * Validate that a string is a valid DNN ID format.
 * Accepts encoded, n-format, and b-format.
 */
export function isValidDnnFormat(value: string): boolean {
  if (!value || value.length < 2) return false
  const first = value[0].toLowerCase()
  if (first !== 'n' && first !== 'b') return false

  const lower = value.toLowerCase()

  // Numeric format: n4, n4.8, b922664, n5h.3
  if (NUMERIC_RE.test(lower)) return true

  // Encoded V2 format: nabandonzooa (min 8 chars total)
  if (lower.length >= 8 && ENCODED_RE.test(lower)) return true

  return false
}

/**
 * Extract the DNN ID from a nip05 value.
 * If the value has no '@', returns the whole string as the DNN ID.
 * If it has '@', returns null (it's a standard NIP-05).
 */
export function extractDnnId(nip05: string | undefined | null): string | null {
  if (!nip05) return null
  const trimmed = nip05.trim()
  if (!trimmed || trimmed.includes('@')) return null
  return isValidDnnFormat(trimmed) ? trimmed : null
}
