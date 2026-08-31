/**
 * NIP-SKD — Sub-Key Derivation (client reference implementation)
 *
 * Deterministically derives application-scoped sub-keypairs from the user's
 * identity key, per `docs/NIP-SKD.md` (salt `"nip-skd-v1"`).
 *
 * This is the LOCAL-KEY path and the **reference implementation**: a remote
 * NIP-SKD signer (e.g. DENOS) MUST produce byte-identical results, verified by
 * the shared test vectors (NIP-SKD §8). Two derivation forms:
 *
 *   - self   : HKDF( root_priv,               salt="nip-skd-v1", info=context )
 *   - shared : HKDF( ECDH_x(root_priv, peer), salt="nip-skd-v1", info=context )
 *
 * A 48-byte HKDF output is reduced mod n to a secp256k1 private key; its x-only
 * public key is the sub-key identifier. The 48-byte (384-bit) width is the
 * RFC 9380 §5 wide-reduction size for a 256-bit order with a 128-bit security
 * margin (L = ceil((256 + 128) / 8)), so the reduction is unbiased BY
 * CONSTRUCTION (statistical distance from uniform ≈ 2^-256).
 *
 * NIP-CHAT v2 uses this for the owner pseudonym `O` (self) and the member
 * pseudonym `P` (shared with the owner `O_pub`). See NIP-CHAT §0.1, §4.5, §6.3.
 *
 * SECURITY: this module derives real private keys, so it is used ONLY when the
 * client legitimately holds `root_priv` (local key). On a remote signer, never
 * call {@link deriveSubKeyLocal}; route through the signer's NIP-SKD surface so
 * the private material never leaves it (see {@link resolveSubkeyPubkey}).
 */

import { getSharedSecret, getPublicKey } from '@noble/secp256k1'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils'
import { hkdfWithSalt } from './hkdf'

/** NIP-SKD scheme salt (frozen). Family `skd`, version `1`. */
export const SKD_SALT = 'nip-skd-v1'

/** Default hub signer scheme (`family:version`). `skd:1` is the 48-byte wide-reduction derivation. */
export const DEFAULT_SIGNER_SCHEME = 'skd:1'

/** Signer scheme(s) this client implements. A hub advertising anything else can't be derived correctly. */
export const SUPPORTED_SIGNER_SCHEMES = ['skd:1'] as const

/** secp256k1 group order n. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

function bytesToBigIntBE(b: Uint8Array): bigint {
  let n = 0n
  for (const byte of b) n = (n << 8n) | BigInt(byte)
  return n
}

function scalarToBytes(d: bigint): Uint8Array {
  return hexToBytes(d.toString(16).padStart(64, '0'))
}

/**
 * Reduce a wide (48-byte / 384-bit) HKDF output to a valid secp256k1 private scalar in [1, n-1].
 * The extra 128 bits over the 256-bit order make `mod n` unbiased by construction (RFC 9380 §5).
 */
function seedToPrivKey(seed: Uint8Array): Uint8Array {
  let d = bytesToBigIntBE(seed) % SECP256K1_N
  if (d === 0n) d = 1n // ~2^-384 chance; keep the derivation total
  return scalarToBytes(d)
}

/**
 * Raw ECDH x-coordinate (32 bytes) between a private key and an x-only pubkey.
 *
 * NB: this is the **raw** x-coordinate (the same value NIP-44 feeds into its
 * KDF), NOT `sha256(x)`. It differs from {@link import('./ecdh').computeSharedSecret},
 * which sha256-hashes the point for the v1 hub-secret mechanism. NIP-SKD pins the
 * raw x so its output is defined solely by the spec.
 */
function ecdhX(rootPrivHex: string, peerPubXOnlyHex: string): Uint8Array {
  // Nostr x-only pubkey → even-y compressed (02 prefix). Shared point is
  // returned compressed (33 bytes); its x-coordinate is bytes 1..33.
  const point = getSharedSecret(hexToBytes(rootPrivHex), hexToBytes('02' + peerPubXOnlyHex), true)
  return point.slice(1)
}

export interface SubKey {
  /** 32-byte private key hex. Local-derivation only — never surfaced in remote mode. */
  privHex: string
  /** 32-byte x-only public key hex — the sub-key identifier. */
  pubHex: string
}

/**
 * Derive a NIP-SKD sub-key from a LOCAL private key (reference implementation).
 *
 * @param rootPrivHex 32-byte identity private key (hex)
 * @param context     NIP-SKD info string — MUST be non-empty and namespaced
 * @param peerPubHex  optional peer x-only pubkey → shared (ECDH) form; omit for self
 */
export function deriveSubKeyLocal(rootPrivHex: string, context: string, peerPubHex?: string): SubKey {
  if (!context) throw new Error('NIP-SKD: context must be non-empty')
  const ikm = peerPubHex ? ecdhX(rootPrivHex, peerPubHex) : hexToBytes(rootPrivHex)
  // 48-byte wide reduction (RFC 9380 §5): unbiased mod-n by construction. NB: the HKDF length, salt, and
  // reduction fully determine every pseudonym — a remote NIP-SKD signer (e.g. DENOS) MUST match this
  // byte-for-byte (verified against the NIP-SKD §8 test vectors) or members derive mismatched pseudonyms.
  const seed = hkdfWithSalt(ikm, SKD_SALT, context, 48)
  const privBytes = seedToPrivKey(seed)
  const pubHex = bytesToHex(getPublicKey(privBytes, true).slice(1)) // x-only (drop 02/03 prefix)
  return { privHex: bytesToHex(privBytes), pubHex }
}

// ── NIP-CHAT v2 context builders (see NIP-CHAT §0.1) ─────────────────────────

export const ChatContext = {
  /** Owner pseudonym `O` — self derivation. */
  owner: (dTag: string) => `nip-chat:v2:owner-pseudonym:${dTag}`,
  /** Member pseudonym `P` — shared derivation with the owner `O_pub`. */
  member: (dTag: string) => `nip-chat:v2:member-pseudonym:${dTag}`,
  /** Sealed-join throwaway address — shared derivation with the owner `O_pub`. */
  joinAddr: (dTag: string) => `nip-chat:v2:join-addr:${dTag}`,
  /**
   * Facilitated pseudonym `Pf` — a non-member's per-facilitator identity, shared derivation with
   * the **facilitator's member pseudonym `P_fac`** (NOT the owner). It mirrors the member pseudonym
   * exactly, with the facilitator playing the owner's role: the facilitated user posts under `Pf`
   * and appears as a leaf in the facilitator's mesh tree. See NIP-CHAT §5.6 / v2 §4.7.
   */
  facilitated: (dTag: string) => `nip-chat:v2:facilitated-pseudonym:${dTag}`,
} as const

/**
 * Owner pseudonym `O` (self) — from the creator's key. Local path; a remote
 * signer derives the identical `O` via NIP-SKD self mode.
 */
export function deriveOwnerPseudonym(rootPrivHex: string, dTag: string): SubKey {
  return deriveSubKeyLocal(rootPrivHex, ChatContext.owner(dTag))
}

/**
 * Member pseudonym `P` (shared with the owner pseudonym `O_pub`). The owner
 * re-derives the same `P` from `ECDH(O_priv, R_pub)` — owner-verification and
 * squat-resistance (NIP-CHAT §6.3).
 */
export function deriveMemberPseudonym(rootPrivHex: string, ownerPubHex: string, dTag: string): SubKey {
  return deriveSubKeyLocal(rootPrivHex, ChatContext.member(dTag), ownerPubHex)
}

/**
 * The **owner** re-derives a member's pseudonym `P` from their real key `R` (local key only).
 * By ECDH symmetry `ECDH(O_priv, R) == ECDH(R_priv, O)`, so this equals the member's own
 * `deriveMemberPseudonym(R_priv, O_pub, dTag)`. Used to locate a member's leaf when `P` isn't
 * already cached (e.g. kicking). Returns the pseudonym pubkey `P_pub`.
 */
export function deriveMemberPseudonymForOwner(ownerRootPrivHex: string, dTag: string, memberRPub: string): string {
  const oPriv = deriveOwnerPseudonym(ownerRootPrivHex, dTag).privHex
  return deriveSubKeyLocal(oPriv, ChatContext.member(dTag), memberRPub).pubHex
}

/**
 * Facilitated pseudonym `Pf` (shared with the facilitator's member pseudonym `P_fac`). The
 * facilitated user derives it from `ECDH(R_f_priv, P_fac_pub)`; the facilitator re-derives the same
 * `Pf` from `ECDH(P_fac_priv, R_f_pub)` (see {@link deriveFacilitatedPseudonymForFacilitator}) — the
 * same owner↔member symmetry, one level down. Local-key path; a NIP-SKD remote signer produces the
 * identical `Pf` via shared mode with `context = ChatContext.facilitated(dTag)`, `peer = P_fac`.
 */
export function deriveFacilitatedPseudonym(rootPrivHex: string, facilitatorPPubHex: string, dTag: string): SubKey {
  return deriveSubKeyLocal(rootPrivHex, ChatContext.facilitated(dTag), facilitatorPPubHex)
}

/**
 * The **facilitator** re-derives a vouched user's `Pf` from their real key `R_f` (local key only).
 * The facilitator first derives their own member pseudonym `P_fac` (peer = owner `O`), then derives
 * `Pf` from `ECDH(P_fac_priv, R_f_pub)`. By ECDH symmetry this equals the facilitated user's own
 * `deriveFacilitatedPseudonym(R_f_priv, P_fac_pub, dTag)`. Lets a facilitator add people **by npub**
 * — `R_f` never enters the tree, only `Pf`. Returns `Pf_pub`.
 *
 * NB: this is a sub-sub-key (derived from `P_fac_priv`), so it needs the facilitator's **local**
 * root key; a remote NIP-SKD signer cannot derive it (the facilitated side, deriving from its own
 * root, works on any signer). Callers gate the facilitator role on `privateKey` being present.
 */
export function deriveFacilitatedPseudonymForFacilitator(
  facilitatorRootPrivHex: string,
  ownerPubHex: string,
  dTag: string,
  memberRPub: string,
): string {
  const pFacPriv = deriveMemberPseudonym(facilitatorRootPrivHex, ownerPubHex, dTag).privHex
  return deriveSubKeyLocal(pFacPriv, ChatContext.facilitated(dTag), memberRPub).pubHex
}

// ── Remote-signer routing (NIP-SKD-capable signer) ───────────────────────────

/** Optional NIP-SKD surface a signer may expose (NIP-07 shape, `docs/NIP-SKD.md` §6). */
export interface SkdSigner {
  skd?: {
    getSubkeyPubkey(context: string, peerPub?: string): Promise<string>
    signAsSubkey(context: string, event: unknown, peerPub?: string): Promise<unknown>
    /** nip44-encrypt FROM the sub-key TO `recipientPub` — e.g. an owner (`O`) wrapping a
     *  member's leaf key. `peerPub` is the sub-key's derivation peer (omitted for self). */
    nip44EncryptAsSubkey(context: string, recipientPub: string, plaintext: string, peerPub?: string): Promise<string>
    /** nip44-decrypt a ciphertext addressed to the sub-key from `senderPub`. */
    nip44DecryptAsSubkey(context: string, senderPub: string, ciphertext: string, peerPub?: string): Promise<string>
  }
}

/** Thrown when neither a local key nor a NIP-SKD signer is available. */
export class SkdUnsupportedError extends Error {
  constructor() {
    super('This signer does not support NIP-SKD; v2 hubs need the DEN client or a NIP-SKD signer.')
    this.name = 'SkdUnsupportedError'
  }
}

/** Whether a signer advertises NIP-SKD support (feature-detect). */
export function signerSupportsSkd(signer: unknown): signer is Required<SkdSigner> {
  return typeof (signer as SkdSigner | null)?.skd?.getSubkeyPubkey === 'function'
}

/**
 * Resolve a sub-key's public key via the correct path:
 *   - local private key → derive directly (reference impl);
 *   - NIP-SKD signer    → ask the signer (private material stays inside it);
 *   - neither           → throw {@link SkdUnsupportedError} (caller shows the
 *                         "use a NIP-SKD signer" page — never publishes in the clear).
 */
export async function resolveSubkeyPubkey(
  context: string,
  opts: { privateKey?: string | null; signer?: unknown; peerPub?: string }
): Promise<string> {
  if (opts.privateKey) return deriveSubKeyLocal(opts.privateKey, context, opts.peerPub).pubHex
  if (signerSupportsSkd(opts.signer)) return opts.signer.skd.getSubkeyPubkey(context, opts.peerPub)
  throw new SkdUnsupportedError()
}

/** Whether v2 participation is possible with the given key setup. */
export function canUseV2(opts: { privateKey?: string | null; signer?: unknown }): boolean {
  return !!opts.privateKey || signerSupportsSkd(opts.signer)
}
