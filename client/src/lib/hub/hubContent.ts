/**
 * NIP-CHAT v2 — hub-event content encryption + owner attestation.
 *
 * In a v2 hub the hub event's structural `content` (roles, categories, channel
 * names, permissions, plugins) is encrypted with `hub_content_key` so only
 * members can read it, while the public face (`n`, `picture`, `banner`, `about`,
 * `t`) stays in plaintext tags (NIP-CHAT §0.3, §6.1). The hub is authored by the
 * owner pseudonym `O`; a one-time **owner attestation** — encrypted with the hub
 * secret — reveals the real creator `R_owner` to members only (§4.5).
 *
 * Like the per-message identity attestation, the owner attestation is
 * **event-based**: `R_owner` signs a small, never-published event committing to
 * the hub coordinate via `signEvent`, because signers (local or NIP-SKD) sign
 * events, not raw digests.
 */

import { verifyEvent, type UnsignedEvent, type Event } from 'nostr-tools'
import { getEventHash } from 'nostr-tools/pure'
import { deriveKey } from '@/lib/crypto/hkdf'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { signWithSigner } from '@/lib/nostr/events'
import type { ISigner } from '@/stores/userStore'

// ── Content encryption (hub_content_key, NIP-CHAT §4.2) ──────────────────────

/** Derive the v2 hub-content key from the hub secret for a given epoch. */
export function deriveHubContentKey(hubSecret: Uint8Array, epoch: number): Uint8Array {
  return deriveKey(hubSecret, `hub-content:epoch:${epoch}`)
}

/** Encrypt the hub's structural content object (v2) → AES-GCM base64. */
export async function encryptHubContent(key: Uint8Array, contentObj: unknown): Promise<string> {
  return aesEncrypt(key, JSON.stringify(contentObj))
}

/** Decrypt a v2 hub's structural content → parsed object. */
export async function decryptHubContent<T = unknown>(key: Uint8Array, ciphertext: string): Promise<T> {
  return JSON.parse(await aesDecrypt(key, ciphertext)) as T
}

// ── Owner attestation (R_owner ↔ hub coordinate) ─────────────────────────────

/** Kind of the internal owner-attestation event. **Never published** — reconstructed for verification only. */
export const V2_HUB_OWNER_KIND = 27493

function ownerAttTemplate(rOwnerPub: string, createdAt: number, coord: string): UnsignedEvent {
  return { kind: V2_HUB_OWNER_KIND, created_at: createdAt, tags: [['a', coord]], content: '', pubkey: rOwnerPub }
}

export interface OwnerAttestation {
  rOwnerPub: string
  createdAt: number
  sigOwner: string
}

/**
 * Build the owner attestation for `coord = 36942:O_pub:dTag`, signed by the real
 * key `R_owner` (via the normal signer — local or remote).
 */
export async function buildOwnerAttestation(
  coord: string,
  rOwnerPubHint: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<OwnerAttestation> {
  const createdAt = Math.floor(Date.now() / 1000)
  const signed = await signWithSigner(ownerAttTemplate(rOwnerPubHint, createdAt, coord), signer, privateKey)
  return { rOwnerPub: signed.pubkey, createdAt: signed.created_at, sigOwner: signed.sig }
}

/** Verify the owner attestation binds `R_owner` to the hub coordinate. */
export function verifyOwnerAttestation(coord: string, att: OwnerAttestation): boolean {
  const t = ownerAttTemplate(att.rOwnerPub, att.createdAt, coord)
  const reconstructed = { ...t, id: getEventHash(t), sig: att.sigOwner } as Event
  return verifyEvent(reconstructed)
}

/** Encrypt the owner attestation with a hub-secret-derived key (members-only). */
export async function encryptOwnerAttestation(hubSecret: Uint8Array, att: OwnerAttestation): Promise<string> {
  return aesEncrypt(deriveKey(hubSecret, 'hub-owner-attestation'), JSON.stringify(att))
}

/** Decrypt the owner attestation. */
export async function decryptOwnerAttestation(hubSecret: Uint8Array, ciphertext: string): Promise<OwnerAttestation> {
  return JSON.parse(await aesDecrypt(deriveKey(hubSecret, 'hub-owner-attestation'), ciphertext)) as OwnerAttestation
}

// ── Roster segment (v2 group-encrypted P→R map, members-only; NIP-CHAT §5.2.1) ─
//
// Each leaf page carries ONE group-encrypted roster segment — a { P: R } map for
// the members on that page — encrypted with a hub-secret-derived key and STAMPED
// with the epoch whose secret encrypts it. Leaf pages stay otherwise plaintext
// (keyed on the unlinkable P, so member bootstrap is unchanged).
//
// On a kick/add the page's segment is rewritten under the CURRENT epoch; untouched
// pages keep their old stamp, and readers pick the matching epoch secret from
// history. This gives forward-secret identity: a rotated-out secret can't open a
// segment written after it, so a kicked member (or a leaked old secret) can read
// the members who were present when they had the key but never anyone added later.
// One group AES op per page (not per member), and it uses the client-held hub
// secret — no signer round-trips, so owner ops stay v1-class even with a remote
// signer.

/** P (hex) → R (hex) for the members on one leaf page. */
export type RosterMap = Record<string, string>

// The roster key binds the page's stamped `epoch` into the HKDF info (`roster:epoch:<n>`), matching how
// channel keys derive (`channel:<id>:epoch:<n>`). The per-epoch secret ALREADY makes the key unique per
// epoch, so this is belt-and-suspenders: it keeps the roster key correct-by-construction (self-evidently
// distinct per epoch) rather than correct-only-because-the-secret-is-always-fresh. Reads try the
// epoch-bound key first and fall back to the legacy un-epoched key, so blobs written before this change
// still decrypt; the fallback becomes dead code once every hub has rotated once.
function rosterKey(epochSecret: Uint8Array, epoch: number): Uint8Array {
  return deriveKey(epochSecret, `roster:epoch:${epoch}`)
}

/** Group-encrypt a page's P→R roster map with the epoch's hub secret (epoch-bound key). */
export async function encryptRoster(epochSecret: Uint8Array, roster: RosterMap, epoch: number): Promise<string> {
  return aesEncrypt(rosterKey(epochSecret, epoch), JSON.stringify(roster))
}

/** Decrypt a page's roster segment (readers supply the secret + the page's stamped epoch). */
export async function decryptRoster(epochSecret: Uint8Array, ciphertext: string, epoch: number): Promise<RosterMap> {
  try {
    return JSON.parse(await aesDecrypt(rosterKey(epochSecret, epoch), ciphertext)) as RosterMap
  } catch {
    return JSON.parse(await aesDecrypt(deriveKey(epochSecret, 'roster'), ciphertext)) as RosterMap // legacy fallback
  }
}

// ── Ban list (v2, encrypted; stores real keys R; NIP-CHAT §5.3) ───────────────
//
// Banned members are removed from the tree, so the ban list can't ride in a leaf —
// it's its own file, encrypted with a hub-secret-derived key (members-only). Re-encrypted
// under the current secret whenever it changes (e.g. on a kick, which rotates the secret).

// The ban-list key binds the ban page's epoch into its HKDF info (`ban-list:epoch:<n>`), matching the
// roster + channel keys. The epoch is STAMPED on the ban page's index entry (§ members.ts parseIndexFile
// / banPageToken), so the reader keys off the writer's recorded epoch — the two can't disagree, and a
// preserved page carries its stamp forward. Redundant today (the per-epoch secret already makes the key
// unique), but correct-by-construction. Reads try the epoch-bound key, then fall back to the legacy
// un-epoched key so pre-stamp ban pages still decrypt (dead code once every hub re-writes its bans once).
function banListKey(hubSecret: Uint8Array, epoch: number | undefined): Uint8Array {
  return deriveKey(hubSecret, epoch != null ? `ban-list:epoch:${epoch}` : 'ban-list')
}

/** Encrypt a ban-page body (`<R>,<reason>` lines) with the epoch-bound ban-list key. */
export async function encryptBanList(hubSecret: Uint8Array, plaintext: string, epoch: number): Promise<string> {
  return aesEncrypt(banListKey(hubSecret, epoch), plaintext)
}

/** Decrypt a v2 ban-page body (readers supply the page's stamped epoch; undefined → legacy pages). */
export async function decryptBanList(hubSecret: Uint8Array, ciphertext: string, epoch?: number): Promise<string> {
  try {
    return await aesDecrypt(banListKey(hubSecret, epoch), ciphertext)
  } catch {
    return await aesDecrypt(deriveKey(hubSecret, 'ban-list'), ciphertext) // legacy (un-epoched) fallback
  }
}
