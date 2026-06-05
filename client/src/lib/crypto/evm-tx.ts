/**
 * EVM Transaction Library
 *
 * Complete Ethereum-compatible transaction construction, signing, and broadcasting.
 * Supports EIP-155 (legacy type 0) transactions with replay protection.
 *
 * Dependencies:
 *   - @noble/secp256k1 v3 — ECDSA signing & key derivation
 *   - @noble/hashes/sha3  — keccak-256 hashing
 *   - @noble/hashes/utils — hex/bytes conversion
 */

import { sign as secp256k1Sign, etc, getPublicKey, Point, hashes as secp256k1Hashes } from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { sha256 } from '@noble/hashes/sha256'
import { hmac } from '@noble/hashes/hmac'
import { bytesToHex } from '@noble/hashes/utils'
import { useRpcStore } from '@/stores/rpcStore'
import type { EvmChain } from '@/stores/rpcStore'

// Configure secp256k1 v3 sync hashes (required before sign() works)
secp256k1Hashes.hmacSha256 = (key, message) => hmac(sha256, key, message)
secp256k1Hashes.sha256 = (message) => sha256(message)

// secp256k1 curve order
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

// ─── Chain IDs ────────────────────────────────────────────────────────────────

/** EIP-155 chain identifiers for supported EVM networks. */
export const EVM_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  bnb: 56,
  polygon: 137,
  avalanche: 43114,
  base: 8453,
}

// ─── RLP Encoder ──────────────────────────────────────────────────────────────

/** Recursive type for RLP-encodable inputs. */
type RLPInput = Uint8Array | RLPInput[]

/**
 * Encode a length prefix for RLP byte strings or lists.
 *
 * @param len   - Length of the payload in bytes
 * @param offset - 0x80 for byte strings, 0xc0 for lists
 */
function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) {
    return new Uint8Array([offset + len])
  }
  // Length-of-length encoding: store `len` as big-endian bytes,
  // then prefix with (offset + 55 + number-of-length-bytes).
  const lenBytes = bigintToBytes(BigInt(len))
  const prefix = new Uint8Array(1 + lenBytes.length)
  prefix[0] = offset + 55 + lenBytes.length
  prefix.set(lenBytes, 1)
  return prefix
}

/**
 * Recursive Length Prefix (RLP) encoding for Ethereum data structures.
 *
 * Encoding rules (per Ethereum Yellow Paper, Appendix B):
 * - Single byte 0x00–0x7f: encoded as-is
 * - Byte string 0–55 bytes: 0x80 + length prefix, then data
 * - Byte string >55 bytes: 0xb7 + length-of-length prefix, then length, then data
 * - List 0–55 bytes total payload: 0xc0 + length prefix, then concatenated items
 * - List >55 bytes total payload: 0xf7 + length-of-length prefix, then length, then items
 */
function rlpEncode(input: RLPInput): Uint8Array {
  if (input instanceof Uint8Array) {
    // Single byte in [0x00, 0x7f] range — encode as-is
    if (input.length === 1 && input[0] < 0x80) {
      return input
    }
    // Empty or multi-byte string
    const prefix = encodeLength(input.length, 0x80)
    const out = new Uint8Array(prefix.length + input.length)
    out.set(prefix)
    out.set(input, prefix.length)
    return out
  }

  // List: recursively encode each element, then wrap with list prefix
  const encodedItems = input.map(rlpEncode)
  const totalLen = encodedItems.reduce((sum, item) => sum + item.length, 0)
  const prefix = encodeLength(totalLen, 0xc0)

  const out = new Uint8Array(prefix.length + totalLen)
  out.set(prefix)
  let offset = prefix.length
  for (const item of encodedItems) {
    out.set(item, offset)
    offset += item.length
  }
  return out
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a bigint to its minimal big-endian byte representation.
 * Returns an empty Uint8Array for 0n (per RLP convention).
 */
function bigintToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0)
  // Convert to hex, ensure even-length, then decode
  let hex = n.toString(16)
  if (hex.length % 2 !== 0) hex = '0' + hex
  return etc.hexToBytes(hex)
}

/**
 * Strip '0x' prefix from a hex string and convert to bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex
  return etc.hexToBytes(stripped)
}

// ─── RPC Helpers ──────────────────────────────────────────────────────────────

/**
 * Make a raw JSON-RPC call to an EVM chain.
 * Tries each configured node in order until one succeeds.
 *
 * @throws Error if all nodes fail
 */
async function evmRpc(
  chain: EvmChain,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const nodes = useRpcStore.getState().evmChains[chain]?.nodes
  if (!nodes || nodes.length === 0) {
    throw new Error(`No RPC nodes configured for chain "${chain}"`)
  }

  // Race all nodes in parallel — fastest valid response wins
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })

  const attempts = nodes.map(async (nodeUrl) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(nodeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      })
      clearTimeout(timeout)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const json = (await response.json()) as {
        result?: unknown
        error?: { code: number; message: string }
      }
      if (json.error) throw new Error(`RPC error ${json.error.code}: ${json.error.message}`)
      return json.result
    } catch (err) {
      clearTimeout(timeout)
      throw err
    }
  })

  try {
    return await Promise.any(attempts)
  } catch (agg) {
    // All nodes failed — extract the first error
    const errors = (agg as AggregateError).errors ?? []
    throw errors[0] ?? new Error(`All RPC nodes failed for "${chain}"`)
  }
}

/**
 * Fetch the current gas price from the network (in wei).
 */
export async function getGasPrice(chain: EvmChain): Promise<bigint> {
  const result = (await evmRpc(chain, 'eth_gasPrice', [])) as string
  return BigInt(result)
}

/**
 * Estimate gas required for a transaction.
 */
export async function estimateGas(
  chain: EvmChain,
  tx: { from: string; to: string; value?: string; data?: string },
): Promise<bigint> {
  const result = (await evmRpc(chain, 'eth_estimateGas', [tx])) as string
  return BigInt(result)
}

/**
 * Get the next nonce (transaction count) for an address.
 */
export async function getTransactionCount(
  chain: EvmChain,
  address: string,
): Promise<bigint> {
  const result = (await evmRpc(chain, 'eth_getTransactionCount', [
    address,
    'latest',
  ])) as string
  return BigInt(result)
}

/**
 * Broadcast a signed raw transaction to the network.
 * @returns The transaction hash
 */
export async function sendRawTransaction(
  chain: EvmChain,
  signedTx: string,
): Promise<string> {
  const result = (await evmRpc(chain, 'eth_sendRawTransaction', [
    signedTx,
  ])) as string
  return result
}

// ─── ERC-20 Transfer Encoding ─────────────────────────────────────────────────

/**
 * ABI-encode an ERC-20 `transfer(address, uint256)` function call.
 *
 * Layout (68 bytes total):
 *   [0..4)   — function selector 0xa9059cbb
 *   [4..36)  — address, left-padded to 32 bytes
 *   [36..68) — uint256 amount, left-padded to 32 bytes
 *
 * @param to     - Recipient address (0x-prefixed hex)
 * @param amount - Token amount in smallest unit
 */
export function encodeErc20Transfer(to: string, amount: bigint): Uint8Array {
  const selector = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb])

  // Address: strip 0x, decode to 20 bytes, left-pad to 32
  const addrBytes = hexToBytes(to)
  const addrPadded = new Uint8Array(32)
  addrPadded.set(addrBytes, 32 - addrBytes.length)

  // Amount: encode as big-endian, left-pad to 32
  const amountBytes = bigintToBytes(amount)
  const amountPadded = new Uint8Array(32)
  amountPadded.set(amountBytes, 32 - amountBytes.length)

  // Concatenate: selector + address + amount
  const data = new Uint8Array(68)
  data.set(selector, 0)
  data.set(addrPadded, 4)
  data.set(amountPadded, 36)
  return data
}

// ─── Transaction Signing ──────────────────────────────────────────────────────

/** Parameters for constructing an EVM transaction. */
export interface EvmTxParams {
  chain: EvmChain
  /** Recipient address (0x-prefixed) */
  to: string
  /** Transfer amount in wei */
  value: bigint
  /** Optional call data (e.g. from encodeErc20Transfer) */
  data?: Uint8Array
  /** Gas limit for the transaction */
  gasLimit: bigint
  /** Gas price in wei */
  gasPrice: bigint
  /** Sender's nonce */
  nonce: bigint
}

/**
 * Sign an EVM transaction using EIP-155 (legacy type 0) replay protection.
 *
 * Signing flow:
 *   1. Build unsigned tx fields: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
 *   2. RLP-encode the list
 *   3. keccak-256 hash → 32-byte message hash
 *   4. ECDSA sign with secp256k1 (recovered format)
 *   5. Compute v = recovery + chainId * 2 + 35 (EIP-155)
 *   6. Build signed tx fields: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
 *   7. RLP-encode → return as '0x'-prefixed hex string
 *
 * @param tx             - Transaction parameters
 * @param privateKeyHex  - 32-byte private key as hex string (no 0x prefix)
 * @returns Signed raw transaction hex string (0x-prefixed)
 */
export function signEvmTransaction(
  tx: EvmTxParams,
  privateKeyHex: string,
): string {
  const chainId = BigInt(EVM_CHAIN_IDS[tx.chain] ?? 1)
  const privKeyBytes = etc.hexToBytes(privateKeyHex)

  // Convert tx fields to Uint8Array
  const nonceBytes = bigintToBytes(tx.nonce)
  const gasPriceBytes = bigintToBytes(tx.gasPrice)
  const gasLimitBytes = bigintToBytes(tx.gasLimit)
  const toBytes = hexToBytes(tx.to) // 20-byte address
  const valueBytes = bigintToBytes(tx.value)
  const dataBytes = tx.data ?? new Uint8Array(0)
  const chainIdBytes = bigintToBytes(chainId)
  const empty = new Uint8Array(0)

  // Step 1–2: RLP-encode unsigned transaction (EIP-155 includes chainId, 0, 0)
  const unsignedFields: RLPInput[] = [
    nonceBytes,
    gasPriceBytes,
    gasLimitBytes,
    toBytes,
    valueBytes,
    dataBytes,
    chainIdBytes,
    empty,
    empty,
  ]
  const rlpUnsigned = rlpEncode(unsignedFields)

  // Step 3: Hash the encoded unsigned transaction
  const msgHash = keccak_256(rlpUnsigned)

  // Step 4: Sign with secp256k1
  // v3 recovered format = 65 bytes: recovery(1) + r(32) + s(32)  ← recovery byte FIRST
  const sigBytes = secp256k1Sign(msgHash, privKeyBytes, {
    prehash: false,
    lowS: true,
    format: 'recovered',
  })

  // Extract recovery, r, s (v3 puts recovery byte first)
  const recovery = sigBytes[0]
  const rRaw = sigBytes.slice(1, 33)
  const sRaw = sigBytes.slice(33, 65)

  function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    return i === 0 ? bytes : bytes.slice(i)
  }
  const r = stripLeadingZeros(rRaw)
  const s = stripLeadingZeros(sRaw)

  // Step 5: EIP-155 v value
  const v = BigInt(recovery) + chainId * 2n + 35n

  // Step 6–7: Build signed transaction and RLP-encode
  const signedFields: RLPInput[] = [
    nonceBytes,
    gasPriceBytes,
    gasLimitBytes,
    toBytes,
    valueBytes,
    dataBytes,
    bigintToBytes(v),
    r,
    s,
  ]
  const rlpSigned = rlpEncode(signedFields)

  return '0x' + bytesToHex(rlpSigned)
}

// ─── High-Level Send ──────────────────────────────────────────────────────────

/**
 * Derive an Ethereum address from a raw private key.
 *
 * Steps:
 *   1. Get uncompressed public key (65 bytes, 0x04 prefix)
 *   2. Take the x,y coordinates (bytes 1–64)
 *   3. keccak-256 hash the coordinates
 *   4. Take the last 20 bytes as the address
 *
 * @param privKeyBytes - 32-byte private key
 * @returns Checksumless 0x-prefixed lowercase address
 */
function deriveEvmAddress(privKeyBytes: Uint8Array): string {
  const uncompressed = getPublicKey(privKeyBytes, false) // 65 bytes
  const xy = uncompressed.slice(1) // 64 bytes (strip 0x04 prefix)
  const hash = keccak_256(xy)
  return '0x' + bytesToHex(hash).slice(-40)
}

/**
 * Get the effective signing key for EVM transactions.
 *
 * For 'nostr' mode: if the natural pubkey has odd y-parity, negate the
 * private key (n - d) so the signer matches the even-y derived address.
 * For 'standard' mode: use the raw private key as-is.
 */
function getEvmSigningKey(
  privKeyHex: string,
  addressMode: 'nostr' | 'standard',
): string {
  if (addressMode === 'standard') return privKeyHex
  // Check if the natural pubkey has odd y
  const privBytes = etc.hexToBytes(privKeyHex)
  const compressed = getPublicKey(privBytes, true)
  if (compressed[0] === 0x03) {
    // Odd y → negate: signing key = n - d
    const d = etc.bytesToNumberBE(privBytes)
    const negated = CURVE_ORDER - d
    let hex = negated.toString(16)
    if (hex.length % 2) hex = '0' + hex
    return hex.padStart(64, '0')
  }
  return privKeyHex
}

/**
 * High-level function to build, sign, and broadcast an EVM transaction.
 *
 * Handles the full lifecycle:
 *   1. Derives sender address from private key
 *   2. Fetches nonce from the network
 *   3. Fetches current gas price
 *   4. Estimates gas (or uses provided override)
 *   5. Signs the transaction (EIP-155)
 *   6. Broadcasts via eth_sendRawTransaction
 *
 * @returns The transaction hash
 */
export async function sendEvmTransaction(params: {
  chain: EvmChain
  /** 32-byte private key as hex (no 0x prefix) */
  privateKeyHex: string
  /** Recipient address (0x-prefixed) */
  to: string
  /** Transfer amount in wei */
  amountWei: bigint
  /** Optional call data (e.g. ERC-20 transfer) */
  data?: Uint8Array
  /** Override automatic gas estimation */
  gasLimitOverride?: bigint
  /** Override automatic gas price fetching (use pre-fetched value) */
  gasPriceOverride?: bigint
  /** Address mode — 'nostr' may require key negation for even-y */
  addressMode?: 'nostr' | 'standard'
  /** Override sender address (skip derivation) */
  senderAddress?: string
}): Promise<string> {
  const { chain, privateKeyHex, to, amountWei, data, gasLimitOverride,
          gasPriceOverride, addressMode = 'nostr', senderAddress } = params

  // Get the effective signing key (handles even-y negation for nostr mode)
  const signingKeyHex = getEvmSigningKey(privateKeyHex, addressMode)
  const signingKeyBytes = etc.hexToBytes(signingKeyHex)

  // 1. Derive sender address (or use override)
  const senderAddr = senderAddress ?? deriveEvmAddress(signingKeyBytes)

  // 2–4. Fetch nonce, gasPrice, gasLimit in parallel
  const [nonce, gasPrice, gasLimit] = await Promise.all([
    getTransactionCount(chain, senderAddr),
    gasPriceOverride != null ? Promise.resolve(gasPriceOverride) : getGasPrice(chain),
    gasLimitOverride != null
      ? Promise.resolve(gasLimitOverride)
      : estimateGas(chain, {
          from: senderAddr,
          to,
          value: '0x' + amountWei.toString(16),
          data: data ? '0x' + bytesToHex(data) : undefined,
        }),
  ])

  // 5. Sign the transaction with the effective signing key
  const signedTx = signEvmTransaction(
    { chain, to, value: amountWei, data, gasLimit, gasPrice, nonce },
    signingKeyHex,
  )

  // 6. Broadcast and return tx hash
  return sendRawTransaction(chain, signedTx)
}
