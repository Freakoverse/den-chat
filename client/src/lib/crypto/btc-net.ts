/**
 * Bitcoin network I/O — UTXO/fee fetching + broadcast (uses the RPC store).
 *
 * Kept separate from btc-tx.ts so the signing crypto there stays pure and
 * portable (the vault reuses btc-tx.ts verbatim; the vault never does network I/O).
 */
import { useRpcStore } from '@/stores/rpcStore'
import { createTaprootTransaction, createSegwitTransaction, type UTXO, type BtcFeeEstimates } from './btc-tx'

/** Get list of Bitcoin API base URLs from the RPC store */
function getBtcNodes(): string[] {
  const nodes = useRpcStore.getState().bitcoinNodes
  if (nodes && nodes.length > 0) return nodes
  return ['https://blockstream.info/api', 'https://mempool.space/api']
}

/**
 * Fetch through the configured Bitcoin nodes — races them in parallel with a
 * per-node timeout, so the fastest valid response wins and a slow/hung node can't
 * stall the whole request (which made fee-rate loading hang).
 */
async function btcFetch(path: string, init?: RequestInit): Promise<Response> {
  const nodes = getBtcNodes()
  const attempts = nodes.map(async (base) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      return res
    } catch (err) {
      clearTimeout(timer)
      throw err instanceof Error ? err : new Error(String(err))
    }
  })
  try {
    return await Promise.any(attempts)
  } catch (agg) {
    const errors = (agg as AggregateError).errors ?? []
    throw errors[0] ?? new Error('No Bitcoin nodes responded')
  }
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
