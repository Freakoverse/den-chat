/**
 * DM04 Contact Registry — NIP-78 persistent contact list for NIP-04 DMs
 *
 * Stores an encrypted list of counterparty pubkeys + lastSeen timestamps
 * in a NIP-78 (kind 30078) replaceable event, encrypted with NIP-44 to self.
 *
 * Features:
 * - 750-contact cap with LRU-style eviction (oldest lastSeen, non-followed first)
 * - Spam detection: rejects npubs with 20+ events in rapid 3-second chains
 * - 10-second debounced publishing to avoid excessive relay writes
 * - Generic d-tag "dm04-contact-registry" for cross-client interoperability
 */

import { nip44, getPublicKey } from 'nostr-tools'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { fetchReplaceable, publishEvent } from '@/lib/nostr/relay-pool'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import { guardedEncrypt, guardedDecrypt } from '@/lib/auth/signerGuard'
import type { ISigner } from '@/stores/userStore'
import type { Event } from 'nostr-tools'

/* ─── Constants ─── */

/** NIP-78 d-tag — intentionally generic (no client branding) for cross-client compat */
const D_TAG = 'dm04-contact-registry'

/** Maximum contacts in the registry */
const MAX_CONTACTS = 750

/** Debounce delay for publishing updated registry to relays */
const PUBLISH_DEBOUNCE_MS = 10_000

/** Spam detection: max events in a rapid chain */
const SPAM_CHAIN_MAX = 20
/** Spam detection: max gap between consecutive events in a chain (seconds) */
const SPAM_CHAIN_GAP_S = 3

/* ─── Types ─── */

export interface DM04Contact {
  /** Counterparty pubkey (hex) */
  pubkey: string
  /** Most recent created_at from their messages */
  lastSeen: number
}

export interface DM04ContactRegistry {
  contacts: DM04Contact[]
}

/* ─── NIP-44 encrypt/decrypt helpers ─── */

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

async function encryptToSelf(
  plaintext: string,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  if (privateKey) {
    const conversationKey = nip44.v2.utils.getConversationKey(
      hexToBytes(privateKey),
      myPubkey,
    )
    return nip44.v2.encrypt(plaintext, conversationKey)
  }
  // Signer path — route through guard
  return guardedEncrypt(plaintext, myPubkey, signer, null, 'nip44')
}

async function decryptFromSelf(
  ciphertext: string,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string> {
  if (privateKey) {
    const conversationKey = nip44.v2.utils.getConversationKey(
      hexToBytes(privateKey),
      myPubkey,
    )
    return nip44.v2.decrypt(ciphertext, conversationKey)
  }
  // Signer path — route through guard
  return guardedDecrypt(ciphertext, myPubkey, signer, null, 'nip44')
}

/* ─── Core Functions ─── */

/**
 * Load the contact registry from relay (NIP-78 kind 30078).
 * Decrypts the NIP-44 encrypted content and returns the parsed registry.
 * Returns an empty registry if no event exists or decryption fails.
 */
export async function loadContactRegistry(
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<DM04ContactRegistry> {
  try {
    const event = await fetchReplaceable(myPubkey, STANDARD_KINDS.APP_DATA, D_TAG)
    if (!event?.content) {
      console.log('[DM04Registry] No existing registry found — starting fresh')
      return { contacts: [] }
    }

    // Decrypt NIP-44 content
    const decrypted = await decryptFromSelf(event.content, myPubkey, signer, privateKey)
    const parsed = JSON.parse(decrypted) as DM04ContactRegistry

    // Validate structure
    if (!Array.isArray(parsed.contacts)) {
      console.warn('[DM04Registry] Invalid registry format — starting fresh')
      return { contacts: [] }
    }

    console.log(`[DM04Registry] Loaded ${parsed.contacts.length} contacts from relay`)
    return parsed
  } catch (err) {
    console.warn('[DM04Registry] Failed to load registry:', err)
    return { contacts: [] }
  }
}

/**
 * Save the contact registry to relay (NIP-78 kind 30078).
 * Encrypts the content with NIP-44 to self before publishing.
 */
export async function saveContactRegistry(
  registry: DM04ContactRegistry,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<boolean> {
  try {
    const plaintext = JSON.stringify(registry)
    const encrypted = await encryptToSelf(plaintext, myPubkey, signer, privateKey)

    const unsigned = createUnsignedEvent(
      STANDARD_KINDS.APP_DATA,
      encrypted,
      [['d', D_TAG]],
    )
    const signed = await signWithSigner(unsigned, signer, privateKey)
    const accepted = await publishEvent(signed)

    if (accepted.length > 0) {
      console.log(`[DM04Registry] Published registry with ${registry.contacts.length} contacts to ${accepted.length} relay(s)`)
      return true
    } else {
      console.warn('[DM04Registry] Registry published but no relay accepted')
      return false
    }
  } catch (err) {
    console.error('[DM04Registry] Failed to save registry:', err)
    return false
  }
}

/**
 * Add or update a contact in the registry.
 * Updates lastSeen if the contact already exists and the new timestamp is newer.
 * Returns true if the registry was modified.
 */
export function addContact(
  registry: DM04ContactRegistry,
  pubkey: string,
  lastSeen: number,
): boolean {
  const existing = registry.contacts.find((c) => c.pubkey === pubkey)
  if (existing) {
    if (lastSeen > existing.lastSeen) {
      existing.lastSeen = lastSeen
      return true
    }
    return false
  }

  if (registry.contacts.length < MAX_CONTACTS) {
    registry.contacts.push({ pubkey, lastSeen })
    return true
  }

  // At capacity — caller should use evictAndReplace instead
  return false
}

/**
 * When at 750 cap: evict the contact with the oldest lastSeen and replace with the new one.
 * Prioritizes evicting non-followed contacts first.
 * Returns the evicted contact's pubkey, or null if the new contact has an older lastSeen than everyone.
 */
export function evictAndReplace(
  registry: DM04ContactRegistry,
  newPubkey: string,
  newLastSeen: number,
  followList: Set<string>,
): string | null {
  if (registry.contacts.length < MAX_CONTACTS) {
    registry.contacts.push({ pubkey: newPubkey, lastSeen: newLastSeen })
    return null
  }

  // Find eviction candidate: non-followed with oldest lastSeen first
  let candidateIdx = -1
  let candidateLastSeen = Infinity

  for (let i = 0; i < registry.contacts.length; i++) {
    const c = registry.contacts[i]
    const isFollowed = followList.has(c.pubkey)

    if (!isFollowed && c.lastSeen < candidateLastSeen) {
      candidateIdx = i
      candidateLastSeen = c.lastSeen
    }
  }

  // If all contacts are followed, fall back to absolute oldest
  if (candidateIdx === -1) {
    for (let i = 0; i < registry.contacts.length; i++) {
      if (registry.contacts[i].lastSeen < candidateLastSeen) {
        candidateIdx = i
        candidateLastSeen = registry.contacts[i].lastSeen
      }
    }
  }

  if (candidateIdx === -1) return null

  // Don't evict if the new contact is older than the candidate
  if (newLastSeen <= candidateLastSeen) return null

  const evictedPubkey = registry.contacts[candidateIdx].pubkey
  registry.contacts[candidateIdx] = { pubkey: newPubkey, lastSeen: newLastSeen }
  console.log(`[DM04Registry] Evicted ${evictedPubkey.slice(0, 12)}… (lastSeen ${candidateLastSeen}) → replaced with ${newPubkey.slice(0, 12)}… (lastSeen ${newLastSeen})`)
  return evictedPubkey
}

/**
 * Spam detection: check if a set of events from a single npub show spam patterns.
 * Returns true if 20+ events have created_at within 3-second gaps in a continuous chain.
 */
export function isSpamBot(events: Event[]): boolean {
  if (events.length < SPAM_CHAIN_MAX) return false

  // Sort by created_at ascending
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at)

  let chainLength = 1
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].created_at - sorted[i - 1].created_at
    if (gap <= SPAM_CHAIN_GAP_S) {
      chainLength++
      if (chainLength >= SPAM_CHAIN_MAX) return true
    } else {
      chainLength = 1
    }
  }

  return false
}

/* ─── Debounced Publishing ─── */

let _publishTimer: ReturnType<typeof setTimeout> | null = null
let _pendingRegistry: DM04ContactRegistry | null = null
let _publishArgs: { myPubkey: string; signer: ISigner | null; privateKey: string | null } | null = null

/**
 * Schedule a debounced publish of the contact registry.
 * Resets the timer on each call — waits 10s of inactivity before publishing.
 */
export function scheduleRegistryPublish(
  registry: DM04ContactRegistry,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): void {
  _pendingRegistry = registry
  _publishArgs = { myPubkey, signer, privateKey }

  if (_publishTimer) clearTimeout(_publishTimer)

  _publishTimer = setTimeout(async () => {
    if (_pendingRegistry && _publishArgs) {
      await saveContactRegistry(_pendingRegistry, _publishArgs.myPubkey, _publishArgs.signer, _publishArgs.privateKey)
      _pendingRegistry = null
      _publishArgs = null
    }
    _publishTimer = null
  }, PUBLISH_DEBOUNCE_MS)
}

/**
 * Force an immediate publish of any pending registry (e.g., on app close).
 */
export async function flushRegistryPublish(): Promise<void> {
  if (_publishTimer) {
    clearTimeout(_publishTimer)
    _publishTimer = null
  }
  if (_pendingRegistry && _publishArgs) {
    await saveContactRegistry(_pendingRegistry, _publishArgs.myPubkey, _publishArgs.signer, _publishArgs.privateKey)
    _pendingRegistry = null
    _publishArgs = null
  }
}
