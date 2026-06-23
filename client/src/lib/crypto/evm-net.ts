/**
 * EVM network I/O — JSON-RPC (gas price / nonce / estimate), broadcast, and the
 * high-level send orchestrator. Kept separate from evm-tx.ts so the signing crypto
 * there stays pure and portable (the vault reuses evm-tx.ts; it never does network I/O).
 */
import { etc } from '@noble/secp256k1'
import { bytesToHex } from '@noble/hashes/utils'
import { useRpcStore } from '@/stores/rpcStore'
import type { EvmChain } from '@/stores/rpcStore'
import { signEvmTransaction, deriveEvmAddress, getEvmSigningKey } from './evm-tx'

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

/** Fetch the current gas price from the network (in wei). */
export async function getGasPrice(chain: EvmChain): Promise<bigint> {
  const result = (await evmRpc(chain, 'eth_gasPrice', [])) as string
  return BigInt(result)
}

/** Estimate gas required for a transaction. */
export async function estimateGas(
  chain: EvmChain,
  tx: { from: string; to: string; value?: string; data?: string },
): Promise<bigint> {
  const result = (await evmRpc(chain, 'eth_estimateGas', [tx])) as string
  return BigInt(result)
}

/** Get the next nonce (transaction count) for an address. */
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

/**
 * High-level function to build, sign, and broadcast an EVM transaction.
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
