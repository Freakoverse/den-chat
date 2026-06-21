/**
 * SignerGuard — Per-domain circuit breaker for remote signers
 *
 * Each protocol/domain ('nip04', 'nip44') gets its own independent:
 * - Sequential queue (prevents concurrent floods)
 * - Failure cache (skips known-bad ciphertexts)
 * - Circuit breaker (opens after 2 failures → blocks all requests for that domain)
 *
 * This means: max 2 signer prompts per protocol type, then silence.
 * Total worst case: 4 prompts (2 NIP-04 + 2 NIP-44).
 *
 * signEvent is NOT guarded (user-initiated, naturally self-throttling).
 * privateKey (nsec/seed) paths bypass the guard entirely (local crypto).
 */

import { nip04 } from 'nostr-tools'
import type { ISigner } from '@/stores/userStore'

/* ─── Constants ─── */

/** Failures before circuit opens (try once, retry once, then stop) */
const MAX_CONSECUTIVE_FAILURES = 2
const CIRCUIT_OPEN_DURATION_MS = 120_000 // 2 minutes (longer since threshold is lower)
const FAILURE_CACHE_MAX = 500
/**
 * Max time to wait for ONE remote-signer encrypt/decrypt before giving up.
 * Without this, a NIP-46 signer that never answers (e.g. the relay connection
 * dropped while the PWA was backgrounded) hangs the serialized queue forever —
 * which is what leaves hub loading stuck on "Loading hub data…". On timeout we
 * reject with a message `isSignerRejection` recognises, so the circuit opens and
 * the rest of the batch fast-fails instead of hanging.
 */
const SIGNER_CALL_TIMEOUT_MS = 20_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Signer ${label} timed out after ${ms / 1000}s`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/* ─── Error types ─── */

export class SignerCircuitOpenError extends Error {
  domain: string
  retryAfter: number
  constructor(domain: string, retryAfterMs: number) {
    super(`Signer circuit open for ${domain} — retry in ${Math.ceil(retryAfterMs / 1000)}s`)
    this.name = 'SignerCircuitOpenError'
    this.domain = domain
    this.retryAfter = retryAfterMs
  }
}

export class SignerCachedFailureError extends Error {
  constructor() {
    super('Decrypt previously failed for this ciphertext')
    this.name = 'SignerCachedFailureError'
  }
}

/* ─── Per-domain state ─── */

interface DomainState {
  failedCiphertexts: string[]
  failedSet: Set<string>
  consecutiveFailures: number
  circuitOpen: boolean
  circuitOpenUntil: number
  queue: Promise<void>
}

const domains: Record<string, DomainState> = {}

function getDomain(key: string): DomainState {
  if (!domains[key]) {
    domains[key] = {
      failedCiphertexts: [],
      failedSet: new Set(),
      consecutiveFailures: 0,
      circuitOpen: false,
      circuitOpenUntil: 0,
      queue: Promise.resolve(),
    }
  }
  return domains[key]
}

/* ─── Queue ─── */

function enqueue<T>(domain: DomainState, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    domain.queue = domain.queue.then(async () => {
      try {
        resolve(await fn())
      } catch (err) {
        reject(err)
      }
    })
  })
}

/* ─── Internal helpers ─── */

function ciphertextKey(ciphertext: string): string {
  return ciphertext.slice(0, 64)
}

function addToFailureCache(domain: DomainState, ciphertext: string): void {
  const key = ciphertextKey(ciphertext)
  if (domain.failedSet.has(key)) return
  domain.failedSet.add(key)
  domain.failedCiphertexts.push(key)
  while (domain.failedCiphertexts.length > FAILURE_CACHE_MAX) {
    const evicted = domain.failedCiphertexts.shift()!
    domain.failedSet.delete(evicted)
  }
}

function onSuccess(domain: DomainState): void {
  domain.consecutiveFailures = 0
  if (domain.circuitOpen) {
    domain.circuitOpen = false
    domain.circuitOpenUntil = 0
    console.log('[SignerGuard] Circuit closed — signer is responsive again')
  }
}

function onFailure(domain: DomainState, domainKey: string): void {
  domain.consecutiveFailures++
  console.warn(
    `[SignerGuard] ${domainKey} failure ${domain.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`,
  )

  if (domain.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    // (Re)open circuit — handles both first open and probe failures
    domain.circuitOpen = true
    domain.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS
    console.warn(
      `[SignerGuard] Circuit OPEN for ${domainKey} — blocking for ${CIRCUIT_OPEN_DURATION_MS / 1000}s`,
    )

    // Always dispatch event — banner component handles dedup/refresh
    window.dispatchEvent(
      new CustomEvent('signer-circuit-open', {
        detail: {
          domain: domainKey,
          message: `Remote signer declined ${domainKey.toUpperCase()} requests — pausing.`,
          retryAfter: CIRCUIT_OPEN_DURATION_MS,
        },
      }),
    )
  }
}

function checkPreconditions(domain: DomainState, domainKey: string): void {
  if (domain.circuitOpen) {
    if (Date.now() >= domain.circuitOpenUntil) {
      console.log(`[SignerGuard] ${domainKey} circuit half-open — probe request`)
    } else {
      throw new SignerCircuitOpenError(domainKey, domain.circuitOpenUntil - Date.now())
    }
  }
}

/**
 * Heuristic: is this error a true signer rejection (user denied, timeout, connection lost)?
 * Only these should count toward the circuit breaker.
 *
 * Everything else (crypto failures, bad ciphertext, wrong key, unknown errors from
 * extensions) means the signer DID process the request — it was responsive.
 * We invert the old logic: instead of trying to enumerate all possible crypto error
 * messages (which misses extension-specific patterns), we explicitly identify rejections.
 */
function isSignerRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('reject') ||
    msg.includes('denied') ||
    msg.includes('declined') ||
    msg.includes('cancel') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('time out') ||
    msg.includes('connection') ||
    msg.includes('not available') ||
    msg.includes('no signer') ||
    msg.includes('user refused') ||
    msg.includes('aborted')
  )
}

/* ─── Signer dispatch ─── */

function callSignerDecrypt(
  ciphertext: string,
  pubkey: string,
  signer: ISigner,
  protocol: 'nip04' | 'nip44',
): Promise<string> {
  if (protocol === 'nip04') {
    if (signer.nip04?.decrypt) return signer.nip04.decrypt(pubkey, ciphertext)
    if ((signer as any).nip04Decrypt) return (signer as any).nip04Decrypt(pubkey, ciphertext)
    throw new Error('No NIP-04 decrypt method on signer')
  } else {
    if (signer.nip44?.decrypt) return signer.nip44.decrypt(pubkey, ciphertext)
    throw new Error('No NIP-44 decrypt method on signer')
  }
}

function callSignerEncrypt(
  plaintext: string,
  pubkey: string,
  signer: ISigner,
  protocol: 'nip04' | 'nip44',
): Promise<string> {
  if (protocol === 'nip04') {
    if (signer.nip04?.encrypt) return signer.nip04.encrypt(pubkey, plaintext)
    if ((signer as any).nip04Encrypt) return (signer as any).nip04Encrypt(pubkey, plaintext)
    throw new Error('No NIP-04 encrypt method on signer')
  } else {
    if (signer.nip44?.encrypt) return signer.nip44.encrypt(pubkey, plaintext)
    throw new Error('No NIP-44 encrypt method on signer')
  }
}

/* ─── Public API ─── */

export async function guardedDecrypt(
  ciphertext: string,
  pubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  protocol: 'nip04' | 'nip44',
): Promise<string> {
  // Fast path: local key — no guard
  if (privateKey) {
    if (protocol === 'nip04') {
      return nip04.decrypt(privateKey, pubkey, ciphertext)
    }
    throw new Error('NIP-44 local decrypt should be handled by nip17.ts directly')
  }

  if (!signer) {
    throw new Error(`No private key or ${protocol.toUpperCase()} signer available for decryption`)
  }

  const domain = getDomain(protocol)

  // Layer 1: Failure cache (sync, before queue)
  const key = ciphertextKey(ciphertext)
  if (domain.failedSet.has(key)) {
    throw new SignerCachedFailureError()
  }

  // Layer 2-4: Queue → circuit → signer
  return enqueue(domain, async () => {
    // Re-check after waiting in queue
    if (domain.failedSet.has(key)) {
      throw new SignerCachedFailureError()
    }

    checkPreconditions(domain, protocol)

    try {
      const result = await withTimeout(callSignerDecrypt(ciphertext, pubkey, signer, protocol), SIGNER_CALL_TIMEOUT_MS, 'decrypt')
      onSuccess(domain)
      return result
    } catch (err) {
      addToFailureCache(domain, ciphertext)

      // Only trip circuit for true signer rejections (user denied, timeout, connection lost).
      // All other errors (crypto failures, bad ciphertext, extension-specific errors)
      // mean the signer DID process the request — it was responsive.
      if (isSignerRejection(err)) {
        onFailure(domain, protocol)
      }
      throw err
    }
  })
}

export async function guardedEncrypt(
  plaintext: string,
  pubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  protocol: 'nip04' | 'nip44',
): Promise<string> {
  // Fast path: local key
  if (privateKey) {
    if (protocol === 'nip04') {
      return nip04.encrypt(privateKey, pubkey, plaintext)
    }
    throw new Error('NIP-44 local encrypt should be handled by nip17.ts directly')
  }

  if (!signer) {
    throw new Error(`No private key or ${protocol.toUpperCase()} signer available for encryption`)
  }

  const domain = getDomain(protocol)

  return enqueue(domain, async () => {
    checkPreconditions(domain, protocol)

    try {
      const result = await withTimeout(callSignerEncrypt(plaintext, pubkey, signer, protocol), SIGNER_CALL_TIMEOUT_MS, 'encrypt')
      onSuccess(domain)
      return result
    } catch (err) {
      if (isSignerRejection(err)) {
        onFailure(domain, protocol)
      }
      throw err
    }
  })
}

/**
 * Reset the signer guard — clears all domain state.
 * Call from "Reconnect & Retry" button.
 */
export function resetSignerGuard(): void {
  for (const key of Object.keys(domains)) {
    delete domains[key]
  }
  console.log('[SignerGuard] All domains reset')
}

/** Check if any domain's circuit is open */
export function isSignerCircuitOpen(): boolean {
  for (const d of Object.values(domains)) {
    if (d.circuitOpen && Date.now() < d.circuitOpenUntil) return true
  }
  return false
}
