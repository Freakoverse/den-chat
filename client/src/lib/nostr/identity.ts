/**
 * NIP-CHAT v2 — per-message identity attestation (the `identity` tag)
 *
 * In a v2 hub every member event is authored by the member's pseudonym `P`, and
 * carries an encrypted `identity` tag binding it to the member's real key `R`
 * with a **per-message** signature (NIP-CHAT §0.1, §4.5). Per-message (not a
 * static binding) is required because the hub owner can derive any member's
 * `P_priv` (it shares the `ECDH(R, O)`), so only a fresh `R` signature over *this*
 * event stops the owner — or anyone — from forging a member's messages.
 *
 * ── Why an attestation *event*, not a raw schnorr signature ──
 * `R` lives on the member's normal signer, and signers only expose `signEvent`
 * (they cannot sign an arbitrary 32-byte digest). So `R`'s per-message signature
 * is produced by signing a small, never-published **attestation event** that
 * commits to the message via an `m` tag. Verification reconstructs that event
 * from `(R_pub, message.created_at, digest)` and checks the signature. This works
 * identically for local keys and remote signers.
 *
 * ── The digest ──
 * `R` signs `computeIdentityDigest(event)` = the message's event hash computed
 * over all fields EXCEPT the volatile `identity` (circular — it holds the sig)
 * and `nonce` (PoW mining varies it) tags. So the attestation binds `R` to the
 * message content and all semantic tags, yet stays stable across mining and does
 * not depend on the tag it lives in.
 *
 * Ordering for senders (see plan §6.5): set `pubkey = P` and the semantic tags
 * and final `created_at` first → build the identity tag → mine (`nonce`) →
 * `P`-sign the full event.
 */

import { verifyEvent, type UnsignedEvent, type Event } from 'nostr-tools'
import { getEventHash } from 'nostr-tools/pure'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { signWithSigner } from './events'
import type { ISigner } from '@/stores/userStore'

/**
 * Kind of the internal R→message attestation event. **Never published** — it is
 * reconstructed locally for verification only, so this value only needs to be
 * stable for domain separation.
 */
export const V2_IDENTITY_KIND = 27492

/** Tags excluded from the identity digest: the `identity` tag (circular) and the PoW `nonce`. */
const DIGEST_EXCLUDED_TAGS = new Set(['identity', 'nonce'])

type DigestibleEvent = Pick<UnsignedEvent, 'kind' | 'created_at' | 'tags' | 'content' | 'pubkey'>

/**
 * Canonical digest the member's real key `R` signs for a v2 message: the event
 * hash over all fields except the `identity` and `nonce` tags. `event.pubkey`
 * MUST already be the pseudonym `P`.
 */
export function computeIdentityDigest(event: DigestibleEvent): string {
  const filtered: UnsignedEvent = {
    kind: event.kind,
    created_at: event.created_at,
    tags: event.tags.filter((t) => !DIGEST_EXCLUDED_TAGS.has(t[0])),
    content: event.content,
    pubkey: event.pubkey,
  }
  return getEventHash(filtered)
}

/** The never-published attestation event `R` signs to commit to a message digest. */
function attestationTemplate(rPub: string, createdAt: number, digest: string): UnsignedEvent {
  return {
    kind: V2_IDENTITY_KIND,
    created_at: createdAt,
    tags: [['m', digest]],
    content: '',
    pubkey: rPub,
  }
}

/**
 * Produce the member's per-message `R` signature over a message. Uses the normal
 * signer (local key or remote) via {@link signWithSigner}, so it signs as the
 * active real key `R`.
 *
 * @returns the real key `R_pub` (authoritative, from the signature) and `sig_R`.
 */
export async function signMessageIdentity(
  messageEvent: DigestibleEvent,
  rPubHint: string,
  signer: ISigner | null,
  privateKey: string | null,
): Promise<{ rPub: string; sigR: string }> {
  const digest = computeIdentityDigest(messageEvent)
  const template = attestationTemplate(rPubHint, messageEvent.created_at, digest)
  const signed = await signWithSigner(template, signer, privateKey)
  return { rPub: signed.pubkey, sigR: signed.sig }
}

/** Encrypt `R_pub || sig_R` with the channel/hub key for the event's epoch. */
export async function encryptIdentityTag(key: Uint8Array, rPub: string, sigR: string): Promise<string> {
  return aesEncrypt(key, `${rPub}:${sigR}`)
}

/** Decrypt an `identity` tag ciphertext back to `{ rPub, sigR }`. */
export async function decryptIdentityTag(key: Uint8Array, ciphertext: string): Promise<{ rPub: string; sigR: string }> {
  const pt = await aesDecrypt(key, ciphertext)
  const idx = pt.indexOf(':')
  if (idx < 0) throw new Error('Malformed identity tag')
  const rPub = pt.slice(0, idx)
  const sigR = pt.slice(idx + 1)
  if (!rPub || !sigR) throw new Error('Malformed identity tag')
  return { rPub, sigR }
}

/**
 * Build the full `["identity", ciphertext]` tag for a message. Call after the
 * event's `pubkey` (= `P`), semantic tags, and `created_at` are final, but before
 * mining and before `P`-signing (see the ordering note at the top).
 */
export async function buildIdentityTag(
  messageEvent: DigestibleEvent,
  rPub: string,
  signer: ISigner | null,
  privateKey: string | null,
  key: Uint8Array,
): Promise<[string, string]> {
  const { rPub: realPub, sigR } = await signMessageIdentity(messageEvent, rPub, signer, privateKey)
  const ct = await encryptIdentityTag(key, realPub, sigR)
  return ['identity', ct]
}

/** Whether an event carries an `identity` tag (cheap plaintext presence check — the drop rule's first gate). */
export function hasIdentityTag(event: Pick<Event, 'tags'>): boolean {
  return event.tags.some((t) => t[0] === 'identity')
}

/**
 * Verify a v2 event's identity: decrypt the `identity` tag, reconstruct the
 * attestation event, and confirm `sig_R` is `R`'s valid signature over this
 * message's digest. Returns the resolved real key on success.
 *
 * CONTRACT: call this only on events whose OUTER signature has already been verified — every event
 * that arrives over the network is signature-checked by the relay pool (`new SimplePool()` verifies by
 * default), so all wire/cached events qualify. We deliberately do NOT re-run `verifyEvent(event)` here:
 * the attestation digest already binds `pubkey`, `kind`, `created_at`, `content`, and every semantic
 * tag (all except `identity`+`nonce`), so any *meaningful* tamper changes the digest and fails this
 * check regardless of the outer signature — re-verifying it would only duplicate the pool's work at a
 * per-message cost. If you ever feed this function events from an UNVERIFIED source, verify them first.
 *
 * @param key - the channel/hub key for the event's epoch (members-only)
 */
export async function verifyEventIdentity(
  event: Event,
  key: Uint8Array,
): Promise<{ ok: boolean; rPub?: string }> {
  const tag = event.tags.find((t) => t[0] === 'identity')
  if (!tag || !tag[1]) return { ok: false }
  if (!event.pubkey) return { ok: false } // P must be present

  let rPub: string
  let sigR: string
  try {
    ;({ rPub, sigR } = await decryptIdentityTag(key, tag[1]))
  } catch {
    return { ok: false }
  }

  const digest = computeIdentityDigest(event)
  const template = attestationTemplate(rPub, event.created_at, digest)
  const reconstructed = {
    ...template,
    id: getEventHash(template),
    sig: sigR,
  } as Event

  return verifyEvent(reconstructed) ? { ok: true, rPub } : { ok: false }
}
