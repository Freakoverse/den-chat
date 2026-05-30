/**
 * NIP-NSP — Nostr Silent Payments (sender-side subset for DEN Chat donations)
 *
 * Implements tweak generation, public-key tweaking, multi-chain address derivation,
 * kind 1604 notification creation, and NIP-78 sent-list persistence.
 *
 * Follows the NIP-NSP specification: §2.1 (tweak), §2.4 (chain derivation),
 * §4 (notification), §5b (sent list).
 */

import { Point, etc } from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import { nip44, getPublicKey, finalizeEvent } from 'nostr-tools'

// ── Constants ──

export const KIND_NSP_NOTIFICATION = 1604
export const KIND_NSP_SENT_LIST = 30078
export const NSP_SENT_DTAG = 'nostr-silent-payment-sent-list'

export type NspChain = 'bitcoin' | 'ethereum' | 'bnb' | 'polygon' | 'avalanche' | 'base'

export interface NspPayload {
  address: string
  chain: NspChain
  asset: string
  token: string | null
  tweak: string
  txid: string
  amount: string
  timestamp: number
  senderNpub?: string
}

export interface NspSentEntry {
  txid: string
  chain: NspChain
  asset: string
  token: string | null
  amount: string
  address: string
  tweak: string
  recipientPubkey: string
  senderNsec: string
  timestamp: number
}

// ── 1. Tweak Generation (§2.1) ──

export function generateTweak(): string {
  const preimage = `${Date.now()}:${crypto.randomUUID()}`
  const data = new TextEncoder().encode(preimage)
  const hash = sha256(data)
  return bytesToHex(hash)
}

// ── 2. Public Key Tweaking (§2.1 — sender side) ──

/**
 * P' = P + t·G  (natural parity, per NIP-NSP §2.1)
 * Input: 32-byte x-only pubkey hex, 32-byte tweak hex.
 * Returns: 33-byte compressed point (Uint8Array).
 */
export function tweakPublicKey(xOnlyPubkeyHex: string, tweakHex: string): Uint8Array {
  // Reconstruct even-y point from x-only (Nostr/BIP-340 convention)
  const P = Point.fromHex('02' + xOnlyPubkeyHex)
  const t = etc.bytesToNumberBE(hexToBytes(tweakHex))
  // t·G
  const tG = Point.BASE.multiply(t)
  // P' = P + t·G  — natural parity
  const tweakedPoint = P.add(tG)
  return tweakedPoint.toBytes(true) // compressed, 33 bytes
}

// ── 3. Bech32m (minimal, for P2TR encoding) ──

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

// ── 4. Chain-Specific Address Derivation (§2.4) ──

/**
 * Derive a Bitcoin Taproot (P2TR) address from a tweaked public key.
 * Taproot uses x-only (parity irrelevant).
 */
export function deriveTaprootAddress(xOnlyPubkeyHex: string, tweakHex: string): string {
  const tweakedCompressed = tweakPublicKey(xOnlyPubkeyHex, tweakHex)
  // x-only: skip the 02/03 prefix byte
  const xOnly = tweakedCompressed.slice(1) // 32 bytes
  // witness version 1
  const words = [1, ...convertBits(xOnly, 8, 5, true)]
  return bech32mEncode('bc', words)
}

/**
 * Derive an EVM (checksummed) address from a tweaked public key.
 * EVM uses natural parity — keccak256(uncompressed x||y) → last 20 bytes → EIP-55.
 */
export function deriveEvmAddress(xOnlyPubkeyHex: string, tweakHex: string): string {
  const tweakedCompressed = tweakPublicKey(xOnlyPubkeyHex, tweakHex)
  // Decompress to get full (x, y)
  const tweakedPoint = Point.fromBytes(tweakedCompressed)
  const uncompressed = tweakedPoint.toBytes(false) // 65 bytes: 04 || x || y
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

// ── 5. Payment URI (§3) ──

export function buildPaymentURI(
  chain: NspChain,
  address: string,
  tokenContract?: string | null,
): string {
  let uri = `${chain}:${address}`
  if (tokenContract) uri += `?token=${tokenContract}`
  return uri
}

// ── 6. NIP-44 Helpers ──

function nip44Encrypt(senderPrivkeyHex: string, recipientPubkeyHex: string, plaintext: string): string {
  const sk = hexToBytes(senderPrivkeyHex)
  const conversationKey = nip44.v2.utils.getConversationKey(sk, recipientPubkeyHex)
  return nip44.v2.encrypt(plaintext, conversationKey)
}

// ── 7. Kind 1604 — NSP Notification (§4) ──

export function createNspNotification(
  recipientPubkeyHex: string,
  payload: NspPayload,
): { event: ReturnType<typeof finalizeEvent>; ephemeralPubkey: string; ephemeralSkHex: string } {
  // Generate ephemeral key pair
  const ephemeralSk = crypto.getRandomValues(new Uint8Array(32))
  const skHex = bytesToHex(ephemeralSk)
  const ephemeralPubkey = getPublicKey(ephemeralSk)

  // Encrypt payload to recipient
  const plaintext = JSON.stringify(payload)
  const encrypted = nip44Encrypt(skHex, recipientPubkeyHex, plaintext)

  const template = {
    kind: KIND_NSP_NOTIFICATION,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', recipientPubkeyHex]],
    content: encrypted,
  }

  const signedEvent = finalizeEvent(template, ephemeralSk)

  return { event: signedEvent, ephemeralPubkey, ephemeralSkHex: skHex }
}

// ── 8. NIP-78 Sent List Helpers (§5b) ──

/**
 * Encrypt content to self using NIP-44.
 */
export function nip44EncryptSelf(privateKeyHex: string, plaintext: string): string {
  const sk = hexToBytes(privateKeyHex)
  const pubkey = getPublicKey(sk)
  const conversationKey = nip44.v2.utils.getConversationKey(sk, pubkey)
  return nip44.v2.encrypt(plaintext, conversationKey)
}

export function nip44DecryptSelf(privateKeyHex: string, ciphertext: string): string {
  const sk = hexToBytes(privateKeyHex)
  const pubkey = getPublicKey(sk)
  const conversationKey = nip44.v2.utils.getConversationKey(sk, pubkey)
  return nip44.v2.decrypt(ciphertext, conversationKey)
}

// ── 9. NIP-65 Relay List Fetch ──

const FALLBACK_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
]

/**
 * Fetch a user's NIP-65 relay list (kind 10002) from fallback relays.
 * Returns read-capable relay URLs.
 */
export async function fetchNip65Relays(pubkeyHex: string): Promise<string[]> {
  const readRelays: string[] = []

  return new Promise((resolve) => {
    const subId = 'nsp_rl_' + Math.random().toString(36).slice(2, 8)
    let best: { tags: string[][]; created_at: number } | null = null
    let resolved = false
    const sockets: WebSocket[] = []
    let doneCount = 0

    const finish = () => {
      if (resolved) return
      resolved = true
      sockets.forEach(s => { try { s.close() } catch {} })
      if (best) {
        for (const tag of best.tags || []) {
          if (tag[0] === 'r') {
            const marker = tag[2] || ''
            if (!marker || marker === 'read') readRelays.push(tag[1])
          }
        }
      }
      resolve(readRelays)
    }

    setTimeout(finish, 5000)

    for (const relay of FALLBACK_RELAYS.slice(0, 3)) {
      try {
        const ws = new WebSocket(relay)
        sockets.push(ws)
        ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, {
          kinds: [10002],
          authors: [pubkeyHex],
          limit: 1,
        }]))
        ws.onmessage = (msg) => {
          try {
            const data = JSON.parse(msg.data)
            if (data[0] === 'EVENT' && data[2]) {
              if (!best || data[2].created_at > best.created_at) best = data[2]
            }
            if (data[0] === 'EOSE') { try { ws.close() } catch {} doneCount++; if (doneCount >= 3) finish() }
          } catch {}
        }
        ws.onerror = () => { doneCount++; if (doneCount >= 3) finish() }
      } catch { doneCount++; if (doneCount >= 3) finish() }
    }
  })
}
