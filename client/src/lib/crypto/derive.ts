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

import { Point, etc } from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex } from '@noble/hashes/utils'

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

// ── EVM Address ──

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

function bech32mEncode(hrp: string, data: number[]): string {
  const checksum = bech32mCreateChecksum(hrp, data)
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
