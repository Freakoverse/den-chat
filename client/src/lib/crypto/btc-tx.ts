/**
 * Bitcoin Transaction Library
 *
 * Supports sending BTC via:
 *   - Taproot (P2TR) — key-path spend with Schnorr signatures (BIP-340/341)
 *   - SegWit (P2WPKH) — ECDSA with BIP-143 sighash
 *
 * Dependencies:
 *   - @noble/secp256k1 v3 — ECDSA + Schnorr signing
 *   - @noble/hashes — SHA-256, tagged hashes
 *   - @noble/hashes/utils — hex/bytes conversion
 *
 * No external Bitcoin libraries — all transaction construction is inline.
 */

import { sign as secp256k1Sign, schnorr, etc, getPublicKey, Point, hashes as secp256k1Hashes } from '@noble/secp256k1'
import { sha256 as nobleSha256 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex } from '@noble/hashes/utils'
import { useRpcStore } from '@/stores/rpcStore'

// Configure secp256k1 v3 sync hashes (required before sign/schnorr.sign work)
if (!secp256k1Hashes.hmacSha256) {
  secp256k1Hashes.hmacSha256 = (key, message) => hmac(nobleSha256, key, message)
}
if (!secp256k1Hashes.sha256) {
  secp256k1Hashes.sha256 = (message) => nobleSha256(message)
}

// ── Helpers ──

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  return etc.hexToBytes(h)
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((sum, a) => sum + a.length, 0)
  const result = new Uint8Array(totalLen)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data)
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data))
}

/** Write a uint32 in little-endian */
function writeU32LE(n: number): Uint8Array {
  const buf = new Uint8Array(4)
  buf[0] = n & 0xff
  buf[1] = (n >> 8) & 0xff
  buf[2] = (n >> 16) & 0xff
  buf[3] = (n >> 24) & 0xff
  return buf
}

/** Write a uint64 in little-endian */
function writeU64LE(n: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((n >> BigInt(i * 8)) & 0xffn)
  }
  return buf
}

/** Read uint64 LE from bytes at offset */
function readU64LE(buf: Uint8Array, offset: number): bigint {
  let val = 0n
  for (let i = 0; i < 8; i++) {
    val |= BigInt(buf[offset + i]) << BigInt(i * 8)
  }
  return val
}

/** Bitcoin variable-length integer (compactSize) encoding */
function writeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return new Uint8Array([n])
  if (n <= 0xffff) {
    const buf = new Uint8Array(3)
    buf[0] = 0xfd
    buf[1] = n & 0xff
    buf[2] = (n >> 8) & 0xff
    return buf
  }
  if (n <= 0xffffffff) {
    const buf = new Uint8Array(5)
    buf[0] = 0xfe
    buf[1] = n & 0xff
    buf[2] = (n >> 8) & 0xff
    buf[3] = (n >> 16) & 0xff
    buf[4] = (n >> 24) & 0xff
    return buf
  }
  throw new Error('VarInt too large')
}

/** BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || data) */
function taggedHash(tag: string, ...data: Uint8Array[]): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag))
  return sha256(concat(tagHash, tagHash, ...data))
}

/** Reverse bytes in-place (for txid LE ↔ BE conversion) */
function reverseBytes(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    result[i] = bytes[bytes.length - 1 - i]
  }
  return result
}

// secp256k1 curve order
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

// ── UTXO Types ──

export interface UTXO {
  txid: string
  vout: number
  value: number   // satoshis
  status: {
    confirmed: boolean
    block_height?: number
    block_hash?: string
    block_time?: number
  }
}

export interface BtcFeeEstimates {
  fastestFee: number
  halfHourFee: number
  hourFee: number
  economyFee: number
  minimumFee: number
}

// ── API Helpers ──

/** Get list of Bitcoin API base URLs from the RPC store */
function getBtcNodes(): string[] {
  const nodes = useRpcStore.getState().bitcoinNodes
  if (nodes && nodes.length > 0) return nodes
  return ['https://blockstream.info/api', 'https://mempool.space/api']
}

/** Fetch with fallback through configured Bitcoin nodes */
async function btcFetch(path: string, init?: RequestInit): Promise<Response> {
  const nodes = getBtcNodes()
  let lastError: Error | undefined
  for (const base of nodes) {
    try {
      const res = await fetch(`${base}${path}`, init)
      if (res.ok) return res
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw lastError ?? new Error('No Bitcoin nodes configured')
}

/** Fetch UTXOs for an address */
export async function fetchUTXOs(address: string): Promise<UTXO[]> {
  const res = await btcFetch(`/address/${address}/utxo`)
  return res.json()
}

/** Fetch fee rate estimates (sat/vB) */
export async function fetchFeeEstimates(): Promise<BtcFeeEstimates> {
  const res = await btcFetch('/v1/fees/recommended')
  const data = await res.json()
  return {
    fastestFee: Math.ceil(data.fastestFee || 1),
    halfHourFee: Math.ceil(data.halfHourFee || 1),
    hourFee: Math.ceil(data.hourFee || 1),
    economyFee: Math.ceil(data.economyFee || 1),
    minimumFee: Math.ceil(data.minimumFee || 1),
  }
}

/** Broadcast a raw transaction hex */
export async function broadcastTransaction(txHex: string): Promise<string> {
  const res = await btcFetch('/tx', {
    method: 'POST',
    body: txHex,
  })
  const txid = await res.text()
  if (txid.length !== 64) throw new Error(`Broadcast failed: ${txid}`)
  return txid
}

// ── Bech32 / Address Utilities ──

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i]
    }
  }
  return chk
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = []
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5)
  ret.push(0)
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31)
  return ret
}

function bech32Encode(hrp: string, data: number[], version: 'bech32' | 'bech32m'): string {
  const checksumConst = version === 'bech32' ? 1 : 0x2bc830a3
  const values = bech32HrpExpand(hrp).concat(data)
  const polymod = bech32Polymod(values.concat([0, 0, 0, 0, 0, 0])) ^ checksumConst
  const checksum: number[] = []
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31)
  return hrp + '1' + data.concat(checksum).map((d) => BECH32_CHARSET[d]).join('')
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const ret: number[] = []
  const maxv = (1 << toBits) - 1
  for (const value of data) {
    acc = (acc << fromBits) | value
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      ret.push((acc >> bits) & maxv)
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv)
  return ret
}

/** Create a P2TR scriptPubKey from an x-only pubkey (32 bytes) */
function p2trScriptPubKey(xOnlyPubkey: Uint8Array): Uint8Array {
  // OP_1 (0x51) + PUSH_32 (0x20) + xOnlyPubkey
  return concat(new Uint8Array([0x51, 0x20]), xOnlyPubkey)
}

/** Create a P2WPKH scriptPubKey from a HASH160 (20 bytes) */
function p2wpkhScriptPubKey(hash160: Uint8Array): Uint8Array {
  // OP_0 (0x00) + PUSH_20 (0x14) + hash160
  return concat(new Uint8Array([0x00, 0x14]), hash160)
}

// ── RIPEMD-160 (minimal inline) ──

const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e]
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000]
const RL = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]
const RR = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]
const SL = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]
const SR = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]

function ripemd160(msg: Uint8Array): Uint8Array {
  const msgLen = msg.length
  const bitLen = msgLen * 8
  const padLen = (msgLen % 64 < 56 ? 56 : 120) - (msgLen % 64)
  const padded = new Uint8Array(msgLen + padLen + 8)
  padded.set(msg)
  padded[msgLen] = 0x80
  padded[padded.length - 8] = bitLen & 0xff
  padded[padded.length - 7] = (bitLen >> 8) & 0xff
  padded[padded.length - 6] = (bitLen >> 16) & 0xff
  padded[padded.length - 5] = (bitLen >> 24) & 0xff

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
  const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0
  const f = (j: number, x: number, y: number, z: number) =>
    j < 16 ? (x ^ y ^ z) : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z)

  for (let off = 0; off < padded.length; off += 64) {
    const w = new Uint32Array(16)
    for (let i = 0; i < 16; i++) w[i] = padded[off + i * 4] | (padded[off + i * 4 + 1] << 8) | (padded[off + i * 4 + 2] << 16) | (padded[off + i * 4 + 3] << 24)
    let al = h0, bl = h1, cl = h2, dl = h3, el = h4
    let ar = h0, br = h1, cr = h2, dr = h3, er = h4
    for (let j = 0; j < 80; j++) {
      let tl = (al + f(j, bl, cl, dl) + w[RL[j]] + KL[j >> 4]) >>> 0
      tl = (rotl(tl, SL[j]) + el) >>> 0
      al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = tl
      let tr = (ar + f(79 - j, br, cr, dr) + w[RR[j]] + KR[j >> 4]) >>> 0
      tr = (rotl(tr, SR[j]) + er) >>> 0
      ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = tr
    }
    const t = (h1 + cl + dr) >>> 0
    h1 = (h2 + dl + er) >>> 0; h2 = (h3 + el + ar) >>> 0; h3 = (h4 + al + br) >>> 0; h4 = (h0 + bl + cr) >>> 0; h0 = t
  }
  const out = new Uint8Array(20)
  for (let i = 0; i < 5; i++) {
    const v = [h0, h1, h2, h3, h4][i]
    out[i * 4] = v & 0xff; out[i * 4 + 1] = (v >> 8) & 0xff; out[i * 4 + 2] = (v >> 16) & 0xff; out[i * 4 + 3] = (v >> 24) & 0xff
  }
  return out
}

function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data))
}

// ══════════════════════════════════════════════════════════
// ─── TAPROOT (P2TR) TRANSACTION ─────────────────────────
// ══════════════════════════════════════════════════════════

/**
 * BIP-341 sighash for a Taproot key-path spend (SIGHASH_DEFAULT = 0x00).
 *
 * The sighash commits to:
 *   - epoch (0x00)
 *   - hash type (0x00 = SIGHASH_DEFAULT)
 *   - version, locktime
 *   - sha256(prevouts), sha256(amounts), sha256(scriptPubKeys), sha256(sequences)
 *   - sha256(outputs)
 *   - spend_type (0x00 for key path, no annex)
 *   - input index
 */
function taprootSighash(
  txVersion: number,
  locktime: number,
  inputs: Array<{ prevTxid: Uint8Array; prevVout: number; prevAmount: bigint; prevScriptPubKey: Uint8Array }>,
  outputs: Array<{ value: bigint; scriptPubKey: Uint8Array }>,
  inputIndex: number,
): Uint8Array {
  // SHA256 of all prevouts (32-byte txid LE + 4-byte vout LE)
  const prevoutsData = concat(...inputs.map((inp) => concat(inp.prevTxid, writeU32LE(inp.prevVout))))
  const hashPrevouts = sha256(prevoutsData)

  // SHA256 of all amounts (8-byte LE each)
  const amountsData = concat(...inputs.map((inp) => writeU64LE(inp.prevAmount)))
  const hashAmounts = sha256(amountsData)

  // SHA256 of all scriptPubKeys (varint len + script for each)
  const scriptPubKeysData = concat(...inputs.map((inp) => concat(writeVarInt(inp.prevScriptPubKey.length), inp.prevScriptPubKey)))
  const hashScriptPubKeys = sha256(scriptPubKeysData)

  // SHA256 of all sequences (4 bytes each, all 0xfffffffd for RBF)
  const seqData = concat(...inputs.map(() => writeU32LE(0xfffffffd)))
  const hashSequences = sha256(seqData)

  // SHA256 of all outputs
  const outputsData = concat(...outputs.map((out) => concat(writeU64LE(out.value), writeVarInt(out.scriptPubKey.length), out.scriptPubKey)))
  const hashOutputs = sha256(outputsData)

  // Construct the sighash message
  const sigMsg = concat(
    new Uint8Array([0x00]),       // epoch
    new Uint8Array([0x00]),       // hash type (SIGHASH_DEFAULT)
    writeU32LE(txVersion),        // nVersion
    writeU32LE(locktime),         // nLockTime
    hashPrevouts,
    hashAmounts,
    hashScriptPubKeys,
    hashSequences,
    hashOutputs,
    new Uint8Array([0x00]),       // spend_type (key path, no annex)
    writeU32LE(inputIndex),       // input_index
  )

  return taggedHash('TapSighash', sigMsg)
}

/**
 * Create and sign a Taproot (P2TR) transaction.
 *
 * @param privateKeyHex - 32-byte private key (hex, no prefix)
 * @param utxos - UTXOs to spend (ALL will be used as inputs)
 * @param recipientAddress - Bech32m destination address
 * @param amountSats - Amount to send in satoshis
 * @param feeRate - Fee rate in sat/vB
 * @returns Signed transaction hex
 */
export function createTaprootTransaction(
  privateKeyHex: string,
  utxos: UTXO[],
  recipientAddress: string,
  amountSats: bigint,
  feeRate: number,
): string {
  const privKeyBytes = hexToBytes(privateKeyHex)

  // Get x-only internal pubkey (32 bytes)
  const internalPubkey = schnorr.getPublicKey(privKeyBytes)

  // Compute TapTweak: t = tagged_hash("TapTweak", internalPubkey)
  const tweak = taggedHash('TapTweak', internalPubkey)
  const tweakScalar = etc.bytesToNumberBE(tweak)

  // Tweaked private key: d' = d + t (mod n)
  // But we need to handle even-y: if the public key has odd y, negate the private key first
  let privScalar = etc.bytesToNumberBE(privKeyBytes)
  const P = Point.fromBytes(getPublicKey(privKeyBytes, true))
  if (P.y % 2n !== 0n) {
    privScalar = CURVE_ORDER - privScalar
  }
  const tweakedPrivScalar = etc.mod(privScalar + tweakScalar, CURVE_ORDER)
  const tweakedPrivKey = etc.numberToBytesBE(tweakedPrivScalar)

  // Get the tweaked output pubkey (x-only, for scriptPubKey)
  const tweakedPubkey = schnorr.getPublicKey(tweakedPrivKey)
  const senderScriptPubKey = p2trScriptPubKey(tweakedPubkey)

  // Decode recipient address to get their scriptPubKey
  const recipientScriptPubKey = decodeBech32Address(recipientAddress)

  // Calculate fee
  const numInputs = utxos.length
  const numOutputs = 2 // recipient + change (we may reduce to 1)
  const estimatedVbytes = Math.ceil(numInputs * 57.5 + numOutputs * 43 + 10.5)
  const fee = BigInt(Math.ceil(estimatedVbytes * feeRate))

  const totalInput = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n)
  const change = totalInput - amountSats - fee
  if (change < 0n) throw new Error(`Insufficient funds: need ${amountSats + fee} sats, have ${totalInput}`)

  // Build outputs
  const outputs: Array<{ value: bigint; scriptPubKey: Uint8Array }> = [
    { value: amountSats, scriptPubKey: recipientScriptPubKey },
  ]
  if (change > 546n) {
    outputs.push({ value: change, scriptPubKey: senderScriptPubKey })
  }

  // Build inputs for sighash
  const sighashInputs = utxos.map((u) => ({
    prevTxid: reverseBytes(hexToBytes(u.txid)),
    prevVout: u.vout,
    prevAmount: BigInt(u.value),
    prevScriptPubKey: senderScriptPubKey,
  }))

  // Sign each input
  const witnesses: Uint8Array[] = []
  for (let i = 0; i < utxos.length; i++) {
    const sighash = taprootSighash(2, 0, sighashInputs, outputs, i)
    const sig = schnorr.sign(sighash, tweakedPrivKey)
    // SIGHASH_DEFAULT (0x00) means no sighash byte appended
    witnesses.push(sig) // 64 bytes
  }

  // Serialize the transaction
  return serializeWitnessTransaction(2, utxos, outputs, witnesses, 'taproot')
}

// ══════════════════════════════════════════════════════════
// ─── SEGWIT (P2WPKH) TRANSACTION ───────────────────────
// ══════════════════════════════════════════════════════════

/**
 * BIP-143 sighash for SegWit P2WPKH.
 *
 * Double-SHA256 of:
 *   nVersion || hashPrevouts || hashSequence || outpoint || scriptCode || amount || nSequence || hashOutputs || nLockTime || nHashType
 */
function segwitSighash(
  txVersion: number,
  locktime: number,
  inputs: Array<{ prevTxid: Uint8Array; prevVout: number; prevAmount: bigint }>,
  outputs: Array<{ value: bigint; scriptPubKey: Uint8Array }>,
  inputIndex: number,
  scriptCode: Uint8Array,
): Uint8Array {
  // hashPrevouts = dSHA256(all outpoints)
  const prevoutsData = concat(...inputs.map((inp) => concat(inp.prevTxid, writeU32LE(inp.prevVout))))
  const hashPrevouts = doubleSha256(prevoutsData)

  // hashSequence = dSHA256(all sequences)
  const seqData = concat(...inputs.map(() => writeU32LE(0xfffffffd)))
  const hashSequence = doubleSha256(seqData)

  // hashOutputs = dSHA256(all outputs)
  const outputsData = concat(...outputs.map((out) => concat(writeU64LE(out.value), writeVarInt(out.scriptPubKey.length), out.scriptPubKey)))
  const hashOutputs = doubleSha256(outputsData)

  // Outpoint for this input
  const outpoint = concat(inputs[inputIndex].prevTxid, writeU32LE(inputs[inputIndex].prevVout))

  // Preimage
  const preimage = concat(
    writeU32LE(txVersion),
    hashPrevouts,
    hashSequence,
    outpoint,
    writeVarInt(scriptCode.length),
    scriptCode,
    writeU64LE(inputs[inputIndex].prevAmount),
    writeU32LE(0xfffffffd),  // nSequence
    hashOutputs,
    writeU32LE(locktime),
    writeU32LE(0x01),         // SIGHASH_ALL
  )

  return doubleSha256(preimage)
}

/**
 * Create and sign a SegWit P2WPKH transaction.
 */
export function createSegwitTransaction(
  privateKeyHex: string,
  utxos: UTXO[],
  recipientAddress: string,
  amountSats: bigint,
  feeRate: number,
): string {
  const privKeyBytes = hexToBytes(privateKeyHex)
  const compressedPubkey = getPublicKey(privKeyBytes, true) // 33 bytes, natural parity

  // HASH160 of compressed pubkey for P2WPKH
  const pubkeyHash = hash160(compressedPubkey)
  const senderScriptPubKey = p2wpkhScriptPubKey(pubkeyHash)

  // scriptCode for P2WPKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  const scriptCode = concat(
    new Uint8Array([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 PUSH_20
    pubkeyHash,
    new Uint8Array([0x88, 0xac]),       // OP_EQUALVERIFY OP_CHECKSIG
  )

  const recipientScriptPubKey = decodeBech32Address(recipientAddress)

  // Calculate fee
  const numInputs = utxos.length
  const estimatedVbytes = Math.ceil(numInputs * 68 + 2 * 31 + 10.5)
  const fee = BigInt(Math.ceil(estimatedVbytes * feeRate))

  const totalInput = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n)
  const change = totalInput - amountSats - fee
  if (change < 0n) throw new Error(`Insufficient funds: need ${amountSats + fee} sats, have ${totalInput}`)

  const outputs: Array<{ value: bigint; scriptPubKey: Uint8Array }> = [
    { value: amountSats, scriptPubKey: recipientScriptPubKey },
  ]
  if (change > 546n) {
    outputs.push({ value: change, scriptPubKey: senderScriptPubKey })
  }

  const sighashInputs = utxos.map((u) => ({
    prevTxid: reverseBytes(hexToBytes(u.txid)),
    prevVout: u.vout,
    prevAmount: BigInt(u.value),
  }))

  // Sign each input
  const witnesses: Uint8Array[] = []
  for (let i = 0; i < utxos.length; i++) {
    const sighash = segwitSighash(2, 0, sighashInputs, outputs, i, scriptCode)
    // ECDSA sign (prehash: false since we already hashed)
    const sigBytes = secp256k1Sign(sighash, privKeyBytes, {
      prehash: false,
      lowS: true,
      format: 'compact', // 64 bytes: r(32) + s(32)
    })
    // DER-encode the signature + SIGHASH_ALL byte
    const derSig = derEncodeSignature(sigBytes)
    const sigWithHashType = concat(derSig, new Uint8Array([0x01])) // SIGHASH_ALL
    witnesses.push(sigWithHashType)
  }

  return serializeWitnessTransaction(2, utxos, outputs, witnesses, 'segwit', compressedPubkey)
}

// ── DER Signature Encoding ──

function derEncodeSignature(compact: Uint8Array): Uint8Array {
  const r = compact.slice(0, 32)
  const s = compact.slice(32, 64)

  function encodeInt(bytes: Uint8Array): Uint8Array {
    // Strip leading zeros
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    let stripped = bytes.slice(start)
    // Add 0x00 prefix if high bit set (to keep positive)
    if (stripped[0] & 0x80) {
      const padded = new Uint8Array(stripped.length + 1)
      padded.set(stripped, 1)
      stripped = padded
    }
    return concat(new Uint8Array([0x02, stripped.length]), stripped)
  }

  const rEnc = encodeInt(r)
  const sEnc = encodeInt(s)
  return concat(new Uint8Array([0x30, rEnc.length + sEnc.length]), rEnc, sEnc)
}

// ── Transaction Serialization ──

function serializeWitnessTransaction(
  version: number,
  utxos: UTXO[],
  outputs: Array<{ value: bigint; scriptPubKey: Uint8Array }>,
  witnesses: Uint8Array[],
  type: 'taproot' | 'segwit',
  compressedPubkey?: Uint8Array,
): string {
  const parts: Uint8Array[] = []

  // Version
  parts.push(writeU32LE(version))

  // SegWit marker and flag
  parts.push(new Uint8Array([0x00, 0x01]))

  // Input count
  parts.push(writeVarInt(utxos.length))

  // Inputs
  for (const utxo of utxos) {
    parts.push(reverseBytes(hexToBytes(utxo.txid))) // prevout hash (LE)
    parts.push(writeU32LE(utxo.vout))               // prevout index
    parts.push(new Uint8Array([0x00]))               // scriptSig length (empty for witness)
    parts.push(writeU32LE(0xfffffffd))               // sequence (RBF enabled)
  }

  // Output count
  parts.push(writeVarInt(outputs.length))

  // Outputs
  for (const out of outputs) {
    parts.push(writeU64LE(out.value))
    parts.push(writeVarInt(out.scriptPubKey.length))
    parts.push(out.scriptPubKey)
  }

  // Witness data
  for (let i = 0; i < utxos.length; i++) {
    if (type === 'taproot') {
      parts.push(writeVarInt(1))                   // 1 witness item
      parts.push(writeVarInt(witnesses[i].length)) // signature length
      parts.push(witnesses[i])                     // signature
    } else {
      // P2WPKH witness: [signature, pubkey]
      parts.push(writeVarInt(2))                            // 2 witness items
      parts.push(writeVarInt(witnesses[i].length))          // sig length
      parts.push(witnesses[i])                              // DER sig + hashtype
      parts.push(writeVarInt(compressedPubkey!.length))     // pubkey length
      parts.push(compressedPubkey!)                         // compressed pubkey
    }
  }

  // Locktime
  parts.push(writeU32LE(0))

  return bytesToHex(concat(...parts))
}

// ── Address Decoding ──

/** Decode a bech32/bech32m address to its scriptPubKey */
function decodeBech32Address(address: string): Uint8Array {
  // Split hrp and data
  const lastOne = address.lastIndexOf('1')
  const data = address.slice(lastOne + 1)

  // Decode base-32
  const decoded: number[] = []
  for (const c of data) {
    const idx = BECH32_CHARSET.indexOf(c.toLowerCase())
    if (idx === -1) throw new Error(`Invalid bech32 character: ${c}`)
    decoded.push(idx)
  }

  // Strip 6-byte checksum
  const words = decoded.slice(0, -6)

  // First word is witness version
  const witnessVersion = words[0]
  const programWords = words.slice(1)

  // Convert 5-bit groups to 8-bit bytes
  const program = new Uint8Array(convertBits(new Uint8Array(programWords), 5, 8, false))

  // Construct scriptPubKey: OP_version PUSH_len program
  const versionOpcode = witnessVersion === 0 ? 0x00 : 0x50 + witnessVersion
  return concat(new Uint8Array([versionOpcode, program.length]), program)
}

// ── High-Level Send ──

/**
 * Build, sign, and broadcast a Bitcoin transaction.
 *
 * @returns The transaction ID (txid)
 */
export async function sendBitcoinTransaction(params: {
  privateKeyHex: string
  recipientAddress: string
  amountSats: bigint
  feeRate: number
  addressType: 'taproot' | 'segwit'
  senderAddress: string
}): Promise<string> {
  const { privateKeyHex, recipientAddress, amountSats, feeRate, addressType, senderAddress } = params

  // 1. Fetch UTXOs
  const utxos = await fetchUTXOs(senderAddress)
  if (utxos.length === 0) throw new Error('No UTXOs available')

  // 2. Build and sign transaction
  let txHex: string
  if (addressType === 'taproot') {
    txHex = createTaprootTransaction(privateKeyHex, utxos, recipientAddress, amountSats, feeRate)
  } else {
    txHex = createSegwitTransaction(privateKeyHex, utxos, recipientAddress, amountSats, feeRate)
  }

  // 3. Broadcast
  return broadcastTransaction(txHex)
}
