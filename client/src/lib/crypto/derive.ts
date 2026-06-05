/**
 * Deterministic address derivation from a Nostr x-only pubkey.
 *
 * Bitcoin: x-only pubkey → BIP-341 TapTweak → Taproot P2TR (Bech32m bc1p…)
 *          Matches bitcoinjs-lib p2tr({ internalPubkey }) behavior (DENOS).
 * EVM:     x-only pubkey → even-y point → uncompressed → keccak256(x||y) → last 20 bytes → EIP-55
 *
 * No random tweak, no notification — address is deterministic and the owner
 * of the Nostr private key already controls the derived address.
 */

import { Point, etc, getPublicKey } from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'

// ── RIPEMD-160 (minimal inline, needed for P2WPKH HASH160) ──
// @noble/hashes/legacy is not exported for browser ESM in v2, so we inline it.

const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e]
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000]
const RL = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]
const RR = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]
const SL = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]
const SR = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]

function _rotl(x: number, n: number) { return (x << n) | (x >>> (32 - n)) }

function ripemd160(msg: Uint8Array): Uint8Array {
  // Pre-processing: padding
  const len = msg.length
  const bitLen = len * 8
  const padLen = ((56 - (len + 1) % 64) + 64) % 64
  const padded = new Uint8Array(len + 1 + padLen + 8)
  padded.set(msg)
  padded[len] = 0x80
  // Length in bits as 64-bit little-endian
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true)

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0

  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = new Array(16)
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, true)

    let al = h0, bl = h1, cl = h2, dl = h3, el = h4
    let ar = h0, br = h1, cr = h2, dr = h3, er = h4

    for (let j = 0; j < 80; j++) {
      const round = j >>> 4
      let fl: number, fr: number
      if (round === 0)      { fl = bl ^ cl ^ dl; fr = br ^ (cr | ~dr) }
      else if (round === 1) { fl = (bl & cl) | (~bl & dl); fr = (br & dr) | (cr & ~dr) }
      else if (round === 2) { fl = (bl | ~cl) ^ dl; fr = (br | ~cr) ^ dr }
      else if (round === 3) { fl = (bl & dl) | (cl & ~dl); fr = (br & cr) | (~br & dr) }
      else                  { fl = bl ^ (cl | ~dl); fr = br ^ cr ^ dr }

      let t = (al + fl + w[RL[j]] + KL[round]) >>> 0
      t = (_rotl(t, SL[j]) + el) >>> 0
      al = el; el = dl; dl = _rotl(cl, 10); cl = bl; bl = t

      t = (ar + fr + w[RR[j]] + KR[round]) >>> 0
      t = (_rotl(t, SR[j]) + er) >>> 0
      ar = er; er = dr; dr = _rotl(cr, 10); cr = br; br = t
    }

    const t = (h1 + cl + dr) >>> 0
    h1 = (h2 + dl + er) >>> 0
    h2 = (h3 + el + ar) >>> 0
    h3 = (h4 + al + br) >>> 0
    h4 = (h0 + bl + cr) >>> 0
    h0 = t
  }

  const out = new Uint8Array(20)
  const ov = new DataView(out.buffer)
  ov.setUint32(0, h0, true); ov.setUint32(4, h1, true); ov.setUint32(8, h2, true)
  ov.setUint32(12, h3, true); ov.setUint32(16, h4, true)
  return out
}

// ── Types ──

export type Chain = 'bitcoin' | 'ethereum' | 'bnb' | 'polygon' | 'avalanche' | 'base'

// ── BIP-340 Tagged Hash ──

/**
 * BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg)
 */
function taggedHash(tag: string, ...msgs: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag))
  const buf = new Uint8Array(tagHash.length * 2 + msgs.reduce((s, m) => s + m.length, 0))
  buf.set(tagHash, 0)
  buf.set(tagHash, tagHash.length)
  let offset = tagHash.length * 2
  for (const m of msgs) {
    buf.set(m, offset)
    offset += m.length
  }
  return sha256(buf)
}

// ── Bitcoin Taproot (P2TR) ──

/**
 * Derive a Bitcoin Taproot (P2TR) address from a 32-byte x-only Nostr pubkey.
 *
 * Applies the BIP-341 TapTweak for a key-path-only spend (no script tree):
 *   t = taggedHash("TapTweak", internalPubkey)
 *   Q = P + t·G
 *   witness_program = x(Q)
 *
 * This matches `bitcoinjs-lib`'s `payments.p2tr({ internalPubkey })` used by DENOS.
 */
export function deriveTaprootAddress(xOnlyPubkeyHex: string): string {
  const xOnly = hexToU8(xOnlyPubkeyHex) // 32 bytes

  // BIP-341: t = taggedHash("TapTweak", internalPubkey)
  const t = taggedHash('TapTweak', xOnly)
  const tScalar = etc.bytesToNumberBE(t)

  // Q = P + t·G (even-y parity for the internal key)
  const P = Point.fromHex('02' + xOnlyPubkeyHex)
  const Q = P.add(Point.BASE.multiply(tScalar))

  // x-only output key (drop the 02/03 prefix)
  const outputKey = Q.toBytes(true).slice(1) // 32 bytes

  // witness version 1 + 32-byte program
  const words = [1, ...convertBits(outputKey, 8, 5, true)]
  return bech32mEncode('bc', words)
}

// ── Bitcoin SegWit (P2WPKH) ──

/**
 * Derive a Bitcoin SegWit (P2WPKH) address from a 32-byte x-only Nostr pubkey.
 *
 * Uses even-y reconstruction (02 prefix) → HASH160(compressed_pubkey) → Bech32 v0 (bc1q…).
 * This matches DENOS's privateKeyToBitcoinAddress() when used with a Nostr (even-y) key.
 */
export function deriveSegwitAddress(xOnlyPubkeyHex: string): string {
  // Reconstruct even-y compressed pubkey (33 bytes: 02 + x)
  const compressed = hexToU8('02' + xOnlyPubkeyHex)

  // HASH160 = RIPEMD160(SHA256(compressed_pubkey))
  const hash160 = ripemd160(sha256(compressed)) // 20 bytes

  // witness version 0 + 20-byte program → Bech32 (NOT Bech32m)
  const words = [0, ...convertBits(hash160, 8, 5, true)]
  return bech32Encode('bc', words)
}

/**
 * Derive an EVM (checksummed) address from a 32-byte x-only Nostr pubkey.
 * Reconstructs the even-y point, gets uncompressed (x||y), keccak256 → last 20 bytes → EIP-55.
 */
export function deriveEvmAddress(xOnlyPubkeyHex: string): string {
  // Reconstruct even-y point from x-only (Nostr/BIP-340 convention)
  const P = Point.fromHex('02' + xOnlyPubkeyHex)
  const uncompressed = P.toBytes(false) // 65 bytes: 04 || x || y
  const xy = uncompressed.slice(1) // 64 bytes
  // keccak256(x||y) → last 20 bytes
  const hash = keccak_256(xy)
  const rawAddr = bytesToHex(hash).slice(-40)
  // EIP-55 checksum
  const addrLower = rawAddr.toLowerCase()
  const checksumHash = bytesToHex(keccak_256(new TextEncoder().encode(addrLower)))
  let checksummed = '0x'
  for (let i = 0; i < addrLower.length; i++) {
    checksummed += parseInt(checksumHash[i], 16) >= 8
      ? addrLower[i].toUpperCase()
      : addrLower[i]
  }
  return checksummed
}

// ── Standard (natural-parity) derivation for nsec/seed users ──

/**
 * Helper: apply EIP-55 checksumming to a raw 40-char hex address.
 */
function eip55Checksum(rawAddr: string): string {
  const addrLower = rawAddr.toLowerCase()
  const checksumHash = bytesToHex(keccak_256(new TextEncoder().encode(addrLower)))
  let checksummed = '0x'
  for (let i = 0; i < addrLower.length; i++) {
    checksummed += parseInt(checksumHash[i], 16) >= 8
      ? addrLower[i].toUpperCase()
      : addrLower[i]
  }
  return checksummed
}

/**
 * Derive a "standard" EVM address from a private key using natural y-parity.
 * This produces the same address as MetaMask/traditional wallets.
 * Only for nsec/seed users who have the private key.
 */
export function deriveStandardEvmAddress(privateKeyHex: string): string {
  const privBytes = hexToU8(privateKeyHex)
  const uncompressed = getPublicKey(privBytes, false) // 65 bytes: 04 || x || y
  const xy = uncompressed.slice(1)                     // 64 bytes
  const hash = keccak_256(xy)
  return eip55Checksum(bytesToHex(hash).slice(-40))
}

/**
 * Derive a "standard" SegWit (P2WPKH) address from a private key using natural y-parity.
 * Uses the compressed pubkey with its natural 02/03 prefix.
 */
export function deriveStandardSegwitAddress(privateKeyHex: string): string {
  const privBytes = hexToU8(privateKeyHex)
  const compressed = getPublicKey(privBytes, true) // 33 bytes with natural 02 or 03 prefix
  const hash160 = ripemd160(sha256(compressed))
  const words = [0, ...convertBits(hash160, 8, 5, true)]
  return bech32Encode('bc', words)
}

// ── Payment URI ──

export function buildPaymentURI(
  chain: Chain,
  address: string,
  tokenContract?: string | null,
): string {
  if (chain === 'bitcoin') return `bitcoin:${address}`
  let uri = `${chain}:${address}`
  if (tokenContract) uri += `?token=${tokenContract}`
  return uri
}

// ── Bech32m (minimal, for P2TR encoding) ──

function hexToU8(hex: string): Uint8Array {
  const len = hex.length / 2
  const arr = new Uint8Array(len)
  for (let i = 0; i < len; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return arr
}

const BECH32M_CONST = 0x2bc830a3
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32mPolymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]
  }
  return chk
}

function bech32mHrpExpand(hrp: string): number[] {
  const ret: number[] = []
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5)
  ret.push(0)
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31)
  return ret
}

function bech32mCreateChecksum(hrp: string, data: number[]): number[] {
  const values = [...bech32mHrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const polymod = bech32mPolymod(values) ^ BECH32M_CONST
  return [0, 1, 2, 3, 4, 5].map(i => (polymod >> (5 * (5 - i))) & 31)
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const values = [...bech32mHrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const polymod = bech32mPolymod(values) ^ 1 // Bech32 (v0) uses constant 1
  return [0, 1, 2, 3, 4, 5].map(i => (polymod >> (5 * (5 - i))) & 31)
}

function bech32mEncode(hrp: string, data: number[]): string {
  const checksum = bech32mCreateChecksum(hrp, data)
  return hrp + '1' + [...data, ...checksum].map(d => BECH32_CHARSET[d]).join('')
}

function bech32Encode(hrp: string, data: number[]): string {
  const checksum = bech32CreateChecksum(hrp, data)
  return hrp + '1' + [...data, ...checksum].map(d => BECH32_CHARSET[d]).join('')
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0, bits = 0
  const result: number[] = []
  const maxv = (1 << toBits) - 1
  for (const value of data) {
    acc = (acc << fromBits) | value
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      result.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxv)
  }
  return result
}
