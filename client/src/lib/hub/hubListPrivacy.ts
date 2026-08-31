/**
 * Hub-list privacy — keep v2 (private) hub memberships out of the PUBLIC user hub list.
 *
 * The user hub list (kind 16942) is a single replaceable event authored by the user's real key
 * R (so it syncs across their devices). v1 hubs sit in public `v` tags. But a v2 hub's whole
 * point is private membership, so listing its dTag publicly would let anyone query the user's
 * kind-16942 and see they belong to it. Instead, v2 entries go in the NIP-51 **encrypted
 * content** (nip44 to self) — same one list, no extra UI, only the owner can read the private
 * half. (Timestamp correlation on republish is an accepted, weak residual.)
 */

import { nip44 } from 'nostr-tools'
import type { UnsignedEvent, Event } from 'nostr-tools'
import type { ISigner } from '@/stores/userStore'
import { guardedEncrypt, guardedDecrypt } from '@/lib/auth/signerGuard'
import { createHubListEvent } from '@/lib/nostr/events'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { getMaxVersionSeen } from '@/lib/hub/versionGuard'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { publishWithFailover, getRelays } from '@/lib/nostr/relay-pool'

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  return bytes
}

/** nip44-encrypt to self (own pubkey as counterparty). */
export async function nip44SelfEncrypt(plaintext: string, myPubkey: string, signer: ISigner | null, privateKey: string | null): Promise<string> {
  if (privateKey) return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(hexToBytes(privateKey), myPubkey))
  return guardedEncrypt(plaintext, myPubkey, signer, null, 'nip44')
}

/** nip44-decrypt from self. */
export async function nip44SelfDecrypt(ciphertext: string, myPubkey: string, signer: ISigner | null, privateKey: string | null): Promise<string> {
  if (privateKey) return nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(hexToBytes(privateKey), myPubkey))
  return guardedDecrypt(ciphertext, myPubkey, signer, null, 'nip44')
}

/**
 * Build the user hub-list event with v2 memberships hidden. Store-aware wrapper over
 * `createHubListEvent`: determines which entries are v2 (from the hub store) and self-encrypts
 * them. Replaces direct `createHubListEvent(entries, folders)` calls.
 */
export async function buildHubListEvent(
  entries: Array<{ dTag: string; relayHint?: string; position: number; folderId?: string }>,
  folders: Array<{ id: string; name: string; color?: string; position: number }>,
): Promise<UnsignedEvent> {
  const hubs = useHubStore.getState().hubs
  const { pubkey, signer, privateKey } = useUserStore.getState()
  // Classify as v2 (→ private/encrypted half) if the store says so OR we've EVER accepted this hub as v2
  // (version high-water mark). Falling back to the mark closes a leak: if the hub is transiently absent
  // from the store when the list is rebuilt (folder reorder, resort, eviction), keying only off the store
  // would misclassify a private v2 membership as public and publish its dTag in a plaintext `v` tag on the
  // R-authored kind-16942 — linking R to the private hub. Over-including errs toward privacy.
  const v2DTags = new Set(entries.filter(e => hubs[e.dTag]?.version === 2 || getMaxVersionSeen(e.dTag) >= 2).map(e => e.dTag))
  const selfEncrypt = v2DTags.size > 0 && pubkey
    ? (pt: string) => nip44SelfEncrypt(pt, pubkey, signer, privateKey)
    : undefined
  return createHubListEvent(entries, folders, { v2DTags, selfEncrypt })
}

/**
 * Parse the private (encrypted) v2 hub entries out of a kind-16942 event's content. Returns the
 * decrypted `v` tags (same shape as public ones) to merge with the public tags. `[]` on failure.
 */
export async function parsePrivateHubEntries(
  content: string,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<string[][]> {
  if (!content) return []
  try {
    const decrypted = await nip44SelfDecrypt(content, myPubkey, signer, privateKey)
    const parsed = JSON.parse(decrypted)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Publish the (signed) user hub-list event (kind 16942) with failover. The hub list is a CRITICAL
 * replaceable event — if it doesn't land, hubs vanish from the sidebar on reload — and it's authored
 * by the user's real key R, so it belongs on the user's own relays. Seeds with the normal
 * getPublishRelays() pick, then fails over across the FULL client + NIP-65 relay set so a dead relay
 * in the 3-pick can't strand it. Returns the relays that accepted ([] only if every one is dead).
 */
export async function publishHubList(signed: Event, target = 3): Promise<string[]> {
  const seed = getPublishRelays()
  // Personal-event failover scope: all client relays + the user's NIP-65 relays (deduped in the
  // helper). NOT hub relays — the hub list is an R-authored personal event.
  const pool = [...getRelays(), ...useUserListsStore.getState().userRelays]
  return publishWithFailover(signed, seed, { pool, target })
}
