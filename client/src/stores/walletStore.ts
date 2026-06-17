import { create } from 'zustand'
import {
  deriveTaprootAddress, deriveSegwitAddress, deriveSegwitOddAddress, deriveEvmAddress,
  deriveStandardEvmAddress, deriveStandardSegwitAddress,
  type Chain,
} from '@/lib/crypto/derive'
import { useRpcStore, type EvmChain } from './rpcStore'
import { CHAIN_TOKENS, BALANCE_OF_SELECTOR, type TokenInfo } from '@/lib/tokens'

/* ─── Wallet Store ───
 *
 * Manages derived addresses, balance fetching, and transaction history
 * for the logged-in user's deterministic wallets.
 */

// ── Chain Metadata ──

export interface ChainMeta {
  id: Chain
  name: string
  symbol: string
  color: string
  decimals: number
}

export const CHAIN_META: ChainMeta[] = [
  { id: 'bitcoin', name: 'Bitcoin', symbol: 'BTC', color: '#F7931A', decimals: 8 },
  { id: 'ethereum', name: 'Ethereum', symbol: 'ETH', color: '#627EEA', decimals: 18 },
  { id: 'bnb', name: 'BNB Chain', symbol: 'BNB', color: '#F0B90B', decimals: 18 },
  { id: 'polygon', name: 'Polygon', symbol: 'POL', color: '#8247E5', decimals: 18 },
  { id: 'avalanche', name: 'Avalanche', symbol: 'AVAX', color: '#E84142', decimals: 18 },
  { id: 'base', name: 'Base', symbol: 'ETH', color: '#0052FF', decimals: 18 },
]

// ── Types ──

export interface BalanceInfo {
  native: string       // truncated display balance (e.g. "0.00502")
  nativeFull?: string  // full-precision balance (e.g. "0.00502012345")
  nativeRaw?: bigint   // raw balance in smallest unit
  pending?: string     // for Bitcoin mempool
  loading: boolean
  error?: string
  lastFetched?: number // timestamp
}

export interface TxItem {
  txid: string
  type: 'in' | 'out'
  amount: string       // formatted
  timestamp: number
  confirmations: number
  from?: string        // EVM: single from address
  to?: string          // EVM: single to address
  // Bitcoin-specific
  fee?: number         // fee in sats
  fromAddresses?: string[]  // BTC: all input addresses
  toAddresses?: string[]    // BTC: all output addresses
  confirmed?: boolean
  // EVM-specific
  gasUsed?: string
  gasPrice?: string
  isError?: boolean
  blockNumber?: string
  tokenSymbol?: string
}

export interface TxHistory {
  txs: TxItem[]
  loading: boolean
  error?: string
  hasMore: boolean
}

interface WalletState {
  // Active addresses per chain (derived from the current mode + btc type)
  addresses: Partial<Record<Chain, string>>
  // Permanent snapshots (computed once at derive time, never mutated)
  btcTaprootAddress: string | null  // same in both modes (x-only)
  btcSegwitAddress: string | null   // nostr-mode segwit (even-y / 02)
  btcSegwitOddAddress: string | null // segwit from odd-y (03) — same x-only key, other parity
  nostrEvmAddress: string | null    // EVM address from even-y pubkey
  // Standard (natural-parity) — only for nsec/seed users
  standardEvmAddress: string | null
  standardBtcSegwitAddress: string | null
  // Balance per chain (native token)
  balances: Partial<Record<Chain, BalanceInfo>>
  // Native BTC balance per address type — for the Bitcoin address-type selector boxes
  btcTypeBalances: Partial<Record<'taproot' | 'segwit' | 'segwit-odd', BalanceInfo>>
  // ERC-20 token balances: chain → contractAddress → formatted balance
  tokenBalances: Partial<Record<Chain, Record<string, { balance: string; balanceFull?: string; loading: boolean; error?: string }>>>
  // Transaction history per chain
  transactions: Partial<Record<Chain, TxHistory>>
  // Selected chain for detail view
  selectedChain: Chain
  // Selected token (null = native, or token symbol)
  selectedToken: string | null
  // Bitcoin address type ('segwit' = even-y; 'segwit-odd' = odd-y)
  bitcoinAddressType: 'taproot' | 'segwit' | 'segwit-odd'
  // Address derivation mode: nostr (even-y) or standard (natural parity)
  addressMode: 'nostr' | 'standard'
  // Whether addresses have been derived
  derived: boolean

  // Actions
  deriveAddresses: (pubkeyHex: string, privateKeyHex?: string | null) => void
  fetchBalance: (chain: Chain) => Promise<void>
  fetchAllBitcoinBalances: () => Promise<void>
  fetchTokenBalance: (chain: EvmChain, token: TokenInfo, address: string) => Promise<void>
  fetchAllTokenBalances: (chain: EvmChain, address: string) => Promise<void>
  fetchTransactions: (chain: Chain, address: string, contractAddress?: string) => Promise<void>
  setSelectedChain: (chain: Chain) => void
  setSelectedToken: (token: string | null) => void
  setBitcoinAddressType: (type: 'taproot' | 'segwit' | 'segwit-odd') => void
  setAddressMode: (mode: 'nostr' | 'standard') => void
  refreshAll: () => Promise<void>
}

// ── Formatters ──

function formatBtc(sats: number): string {
  return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') || '0'
}

function formatEvm(weiStr: string, decimals: number): { display: string; full: string } {
  if (!weiStr || weiStr === '0x0' || weiStr === '0') return { display: '0', full: '0' }
  const wei = BigInt(weiStr)
  const divisor = BigInt(10 ** decimals)
  const whole = wei / divisor
  const frac = wei % divisor
  if (frac === 0n) return { display: whole.toString(), full: whole.toString() }
  const fullFracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  const full = fullFracStr ? `${whole}.${fullFracStr}` : whole.toString()
  const truncFracStr = frac.toString().padStart(decimals, '0').slice(0, 6).replace(/0+$/, '')
  const display = truncFracStr ? `${whole}.${truncFracStr}` : whole.toString()
  return { display, full }
}

// ── Bitcoin Failover ──

/**
 * Fetch from Bitcoin nodes in order, falling back on failure.
 * Uses the user-configurable node list from rpcStore.
 */
async function btcFetchWithFallback(path: string): Promise<Response> {
  const nodes = useRpcStore.getState().bitcoinNodes
  if (nodes.length === 0) throw new Error('No Bitcoin nodes configured')

  let lastError: Error | null = null
  for (const baseUrl of nodes) {
    try {
      const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(8000) })
      if (res.ok) return res
      lastError = new Error(`${baseUrl}: HTTP ${res.status}`)
    } catch (e: any) {
      lastError = e
    }
  }
  throw lastError || new Error('All Bitcoin nodes failed')
}

async function fetchBtcBalance(address: string): Promise<BalanceInfo> {
  const res = await btcFetchWithFallback(`/address/${address}`)
  const data = await res.json()
  const confirmed = (data.chain_stats?.funded_txo_sum || 0) - (data.chain_stats?.spent_txo_sum || 0)
  const pending = (data.mempool_stats?.funded_txo_sum || 0) - (data.mempool_stats?.spent_txo_sum || 0)
  return {
    native: formatBtc(confirmed),
    nativeRaw: BigInt(confirmed),
    pending: pending !== 0 ? formatBtc(pending) : undefined,
    loading: false,
    lastFetched: Date.now(),
  }
}

// ── EVM Failover ──

/**
 * Make a JSON-RPC call to EVM nodes in order, falling back on failure.
 * Uses the user-configurable node list from rpcStore (mirror-aware).
 */
async function evmRpcCall(chain: EvmChain, method: string, params: any[] = []): Promise<any> {
  const nodes = useRpcStore.getState().getEffectiveNodes(chain)
  if (nodes.length === 0) throw new Error(`No ${chain} RPC nodes configured`)

  let lastError: Error | null = null
  for (const url of nodes) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) { lastError = new Error(`${url}: HTTP ${res.status}`); console.warn(`[wallet] ${chain} node failed: ${url} → HTTP ${res.status}`); continue }
      const data = await res.json()
      if (data.error) { lastError = new Error(data.error.message || 'RPC error'); console.warn(`[wallet] ${chain} node error: ${url} → ${data.error.message}`); continue }
      return data.result
    } catch (e: any) {
      console.warn(`[wallet] ${chain} node unreachable: ${url} → ${e.message}`)
      lastError = e
    }
  }
  throw lastError || new Error(`All ${chain} nodes failed`)
}

async function fetchEvmBalance(chain: EvmChain, address: string, decimals: number): Promise<BalanceInfo> {
  const hexBalance = await evmRpcCall(chain, 'eth_getBalance', [address, 'latest'])
  const { display, full } = formatEvm(hexBalance, decimals)
  return {
    native: display,
    nativeFull: display !== full ? full : undefined,
    nativeRaw: BigInt(hexBalance),
    loading: false,
    lastFetched: Date.now(),
  }
}

/**
 * Fetch ERC-20 token decimals from the contract via eth_call.
 * Selector: 0x313ce567 = decimals()
 * Results are cached in-memory so each contract is only queried once.
 */
const decimalsCache = new Map<string, number>()

async function fetchTokenDecimals(chain: EvmChain, contractAddress: string, fallback: number): Promise<number> {
  const cacheKey = `${chain}:${contractAddress.toLowerCase()}`
  const cached = decimalsCache.get(cacheKey)
  if (cached !== undefined) return cached

  try {
    const result = await evmRpcCall(chain, 'eth_call', [
      { to: contractAddress, data: '0x313ce567' },
      'latest',
    ])
    const decimals = parseInt(result, 16)
    if (decimals >= 0 && decimals <= 77) { // sanity check (uint8 range + safe)
      decimalsCache.set(cacheKey, decimals)
      if (decimals !== fallback) {
        console.warn(`[wallet] ${chain} token ${contractAddress}: on-chain decimals=${decimals} differs from hardcoded=${fallback}`)
      }
      return decimals
    }
  } catch (e) {
    console.warn(`[wallet] Failed to fetch decimals for ${contractAddress} on ${chain}, using hardcoded=${fallback}`)
  }
  decimalsCache.set(cacheKey, fallback)
  return fallback
}

/**
 * Fetch ERC-20 token balance using eth_call with balanceOf(address).
 * Fetches on-chain decimals to ensure correct formatting.
 */
async function fetchErc20Balance(chain: EvmChain, contractAddress: string, ownerAddress: string, hardcodedDecimals: number): Promise<{ display: string; full: string }> {
  const paddedAddress = ownerAddress.replace('0x', '').padStart(64, '0')
  const calldata = BALANCE_OF_SELECTOR + paddedAddress
  // Fetch balance and on-chain decimals in parallel
  const [result, decimals] = await Promise.all([
    evmRpcCall(chain, 'eth_call', [
      { to: contractAddress, data: calldata },
      'latest',
    ]),
    fetchTokenDecimals(chain, contractAddress, hardcodedDecimals),
  ])
  return formatEvm(result, decimals)
}

async function fetchBtcTransactions(address: string): Promise<TxItem[]> {
  const res = await btcFetchWithFallback(`/address/${address}/txs`)
  const txs = await res.json()
  const items: TxItem[] = []
  for (const tx of txs.slice(0, 50)) {
    // Determine if incoming or outgoing by checking if our address is in inputs
    const isOutgoing = tx.vin?.some((v: any) => v.prevout?.scriptpubkey_address === address)
    // Calculate amount
    let received = 0, sent = 0
    for (const vout of tx.vout || []) {
      if (vout.scriptpubkey_address === address) received += vout.value
    }
    for (const vin of tx.vin || []) {
      if (vin.prevout?.scriptpubkey_address === address) sent += vin.prevout.value
    }
    const netAmount = isOutgoing ? sent - received : received
    // Collect unique from/to addresses
    const fromAddrs = [...new Set((tx.vin || []).map((v: any) => v.prevout?.scriptpubkey_address).filter(Boolean))]
    const toAddrs = [...new Set((tx.vout || []).map((v: any) => v.scriptpubkey_address).filter(Boolean))]
    items.push({
      txid: tx.txid,
      type: isOutgoing ? 'out' : 'in',
      amount: formatBtc(Math.abs(netAmount)),
      timestamp: tx.status?.block_time || Math.floor(Date.now() / 1000),
      confirmations: tx.status?.confirmed ? 1 : 0,
      fee: tx.fee,
      fromAddresses: fromAddrs,
      toAddresses: toAddrs,
      confirmed: !!tx.status?.confirmed,
    })
  }
  return items
}
// EVM chain IDs for Etherscan V2 API
const EVM_CHAIN_IDS: Record<EvmChain, number> = {
  ethereum: 1,
  bnb: 56,
  polygon: 137,
  avalanche: 43114,
  base: 8453,
}

// Routescan: free Etherscan-compatible API (no key needed, 2 req/s)
const ROUTESCAN_BASE = 'https://api.routescan.io/v2/network/mainnet/evm'


// GoldRush (Covalent) chain name mapping
const GOLDRUSH_CHAIN_NAMES: Record<number, string> = {
  1: 'eth-mainnet',
  56: 'bsc-mainnet',
  137: 'matic-mainnet',
  43114: 'avalanche-mainnet',
  8453: 'base-mainnet',
}

/**
 * Try fetching tx history from a given Etherscan-compatible API URL.
 * Returns parsed TxItem[] on success, null on failure.
 */
async function tryEtherscanFetch(
  url: string, address: string, decimals: number, label: string
): Promise<TxItem[] | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!res.ok) { console.warn(`[${label}] HTTP ${res.status}`); return null }
    const data = await res.json()
    if (data.status !== '1' || !Array.isArray(data.result)) {
      if (data.message === 'No transactions found') return null
      console.warn(`[${label}] status=${data.status} msg=${data.message}`)
      return null
    }
    return parseEtherscanResult(data.result, address, decimals)
  } catch (e) {
    console.warn(`[${label}] fetch error:`, e)
    return null
  }
}

/** Parse Etherscan-compatible result array into TxItem[] */
function parseEtherscanResult(result: any[], address: string, decimals: number): TxItem[] {
  const items: TxItem[] = []
  const addrLower = address.toLowerCase()
  for (const tx of result) {
    const isOutgoing = tx.from?.toLowerCase() === addrLower
    const valueWei = BigInt(tx.value || '0')
    const whole = valueWei / BigInt(10 ** decimals)
    const frac = valueWei % BigInt(10 ** decimals)
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '') || '0'
    const formatted = frac === 0n ? whole.toString() : `${whole}.${fracStr}`

    items.push({
      txid: tx.hash,
      type: isOutgoing ? 'out' : 'in',
      amount: formatted,
      timestamp: parseInt(tx.timeStamp) || Math.floor(Date.now() / 1000),
      confirmations: parseInt(tx.confirmations) || 0,
      from: tx.from,
      to: tx.to,
      gasUsed: tx.gasUsed,
      gasPrice: tx.gasPrice,
      isError: tx.isError === '1',
      blockNumber: tx.blockNumber,
      tokenSymbol: tx.tokenSymbol,
      confirmed: true,
    })
  }
  return items
}

/**
 * Fetch tx history from GoldRush (Covalent) API.
 * Requires a user-provided API key. Returns null if no key or on failure.
 */
async function tryGoldrushFetch(
  chainId: number, address: string, decimals: number, contractAddress?: string
): Promise<TxItem[] | null> {
  const chainName = GOLDRUSH_CHAIN_NAMES[chainId]
  if (!chainName) return null
  const apiKey = useRpcStore.getState().goldrushApiKey
  if (!apiKey) return null

  try {
    const url = contractAddress
      ? `https://api.covalenthq.com/v1/${chainName}/address/${address}/transfers_v2/?contract-address=${contractAddress}&page-size=50`
      : `https://api.covalenthq.com/v1/${chainName}/address/${address}/transactions_v3/?page-size=50&no-logs=true`
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) { console.warn(`[GoldRush] HTTP ${res.status} for ${chainName}`); return null }
    const data = await res.json()
    if (!data.data?.items || !Array.isArray(data.data.items)) {
      console.warn(`[GoldRush] No items for ${chainName}:`, data.error_message || 'unknown')
      return null
    }

    const items: TxItem[] = []
    const addrLower = address.toLowerCase()

    if (contractAddress) {
      // Token transfers: each item has a `transfers` array
      for (const item of data.data.items) {
        if (!item.transfers) continue
        for (const t of item.transfers) {
          const isOutgoing = (t.from_address || '').toLowerCase() === addrLower
          const valueWei = BigInt(t.delta || '0')
          const d = t.contract_decimals ?? decimals
          const whole = valueWei / BigInt(10 ** d)
          const frac = valueWei % BigInt(10 ** d)
          const fracStr = frac.toString().padStart(d, '0').replace(/0+$/, '') || '0'
          const formatted = frac === 0n ? whole.toString() : `${whole}.${fracStr}`
          items.push({
            txid: item.tx_hash || '',
            type: isOutgoing ? 'out' : 'in',
            amount: formatted,
            timestamp: Math.floor(new Date(item.block_signed_at).getTime() / 1000),
            confirmations: 1,
            from: t.from_address,
            to: t.to_address,
            tokenSymbol: t.contract_ticker_symbol,
            confirmed: item.successful !== false,
          })
        }
      }
    } else {
      // Native transfers
      for (const item of data.data.items.filter((i: any) => i.value && i.value !== '0' && BigInt(i.value) !== 0n)) {
        const isOutgoing = (item.from_address || '').toLowerCase() === addrLower
        const valueWei = BigInt(item.value || '0')
        const whole = valueWei / BigInt(10 ** decimals)
        const frac = valueWei % BigInt(10 ** decimals)
        const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '') || '0'
        const formatted = frac === 0n ? whole.toString() : `${whole}.${fracStr}`
        items.push({
          txid: item.tx_hash || '',
          type: isOutgoing ? 'out' : 'in',
          amount: formatted,
          timestamp: Math.floor(new Date(item.block_signed_at).getTime() / 1000),
          confirmations: 1,
          from: item.from_address,
          to: item.to_address,
          gasUsed: (item.gas_spent || 0).toString(),
          gasPrice: (item.gas_price || 0).toString(),
          confirmed: item.successful !== false,
        })
      }
    }
    return items
  } catch (e) {
    console.warn(`[GoldRush] fetch error:`, e)
    return null
  }
}

/**
 * Fetch EVM transactions with multi-provider fallback:
 * 1. Etherscan V2 (user's API key, unified endpoint — free tier excludes BNB/Base)
 * 2. Routescan (free, no key — BNB dropped March 2026)
 * 3. GoldRush/Covalent (user's API key — covers all chains)
 */
async function fetchEvmTransactions(chain: EvmChain, address: string, decimals: number, contractAddress?: string): Promise<TxItem[]> {
  const chainId = EVM_CHAIN_IDS[chain]
  const action = contractAddress ? 'tokentx' : 'txlist'
  const contractParam = contractAddress ? `&contractaddress=${contractAddress}` : ''
  const baseParams = `module=account&action=${action}&address=${address}${contractParam}&startblock=0&endblock=99999999&page=1&offset=50&sort=desc`

  // 1. Try Etherscan V2 unified endpoint (global API key)
  const etherscanKey = useRpcStore.getState().etherscanApiKey
  if (etherscanKey) {
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&${baseParams}&apikey=${etherscanKey}`
    const result = await tryEtherscanFetch(url, address, decimals, `Etherscan V2 ${chain}`)
    if (result !== null && result.length > 0) return result
  }

  // 2. Routescan fallback (free, no key, Etherscan-compatible)
  const routescanUrl = `${ROUTESCAN_BASE}/${chainId}/etherscan/api?${baseParams}`
  const routescanResult = await tryEtherscanFetch(routescanUrl, address, decimals, `Routescan ${chain}`)
  if (routescanResult !== null && routescanResult.length > 0) return routescanResult

  // 3. GoldRush (Covalent) fallback — covers all chains including BNB and Base
  const goldrushResult = await tryGoldrushFetch(chainId, address, decimals, contractAddress)
  if (goldrushResult !== null && goldrushResult.length > 0) return goldrushResult

  return []
}

// ── Store ──

export const useWalletStore = create<WalletState>((set, get) => ({
  addresses: {},
  btcTaprootAddress: null,
  btcSegwitAddress: null,
  btcSegwitOddAddress: null,
  nostrEvmAddress: null,
  standardEvmAddress: null,
  standardBtcSegwitAddress: null,
  balances: {},
  btcTypeBalances: {},
  tokenBalances: {},
  transactions: {},
  selectedChain: 'bitcoin',
  selectedToken: null,
  bitcoinAddressType: 'taproot',
  addressMode: 'nostr',
  derived: false,

  deriveAddresses: (pubkeyHex: string, privateKeyHex?: string | null) => {
    const btcTaprootAddr = deriveTaprootAddress(pubkeyHex)
    const btcSegwitAddr = deriveSegwitAddress(pubkeyHex)
    const btcSegwitOddAddr = deriveSegwitOddAddress(pubkeyHex)
    const evmAddr = deriveEvmAddress(pubkeyHex)

    // Standard (natural-parity) addresses — only if we have the private key
    let stdEvmAddr: string | null = null
    let stdBtcSegwit: string | null = null
    if (privateKeyHex) {
      stdEvmAddr = deriveStandardEvmAddress(privateKeyHex)
      stdBtcSegwit = deriveStandardSegwitAddress(privateKeyHex)
    }

    set({
      addresses: {
        bitcoin: btcTaprootAddr, // default to taproot
        ethereum: evmAddr,
        bnb: evmAddr,
        polygon: evmAddr,
        avalanche: evmAddr,
        base: evmAddr,
      },
      btcTaprootAddress: btcTaprootAddr,
      btcSegwitAddress: btcSegwitAddr,
      btcSegwitOddAddress: btcSegwitOddAddr,
      nostrEvmAddress: evmAddr,
      standardEvmAddress: stdEvmAddr,
      standardBtcSegwitAddress: stdBtcSegwit,
      derived: true,
    })
  },

  fetchBalance: async (chain: Chain) => {
    const address = get().addresses[chain]
    if (!address) return

    // Set loading
    set((s) => ({
      balances: {
        ...s.balances,
        [chain]: { ...s.balances[chain], loading: true, error: undefined },
      },
    }))

    try {
      const meta = CHAIN_META.find((m) => m.id === chain)
      let balance: BalanceInfo

      if (chain === 'bitcoin') {
        balance = await fetchBtcBalance(address)
      } else {
        balance = await fetchEvmBalance(chain as EvmChain, address, meta?.decimals ?? 18)
      }

      set((s) => ({
        balances: { ...s.balances, [chain]: balance },
      }))
    } catch (err) {
      set((s) => ({
        balances: {
          ...s.balances,
          [chain]: {
            native: '—',
            nativeRaw: 0n,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to fetch balance',
          },
        },
      }))
    }
  },

  // Fetch native BTC balance for ALL three address types at once, so the
  // address-type selector boxes can show balances without switching to each
  // (mirrors fetchAllTokenBalances for EVM tokens).
  fetchAllBitcoinBalances: async () => {
    const state = get()
    // Even-segwit follows the nostr/standard mode; taproot + odd-segwit are x-only derived.
    const evenAddr = state.addressMode === 'standard' && state.standardBtcSegwitAddress
      ? state.standardBtcSegwitAddress
      : state.btcSegwitAddress
    const entries: Array<['taproot' | 'segwit' | 'segwit-odd', string | null]> = [
      ['taproot', state.btcTaprootAddress],
      ['segwit', evenAddr],
      ['segwit-odd', state.btcSegwitOddAddress],
    ]

    // Mark each as loading
    set((s) => {
      const next = { ...s.btcTypeBalances }
      for (const [type, addr] of entries) {
        if (addr) next[type] = { native: next[type]?.native ?? '0', loading: true, error: undefined }
      }
      return { btcTypeBalances: next }
    })

    await Promise.all(entries.map(async ([type, addr]) => {
      if (!addr) return
      try {
        const bal = await fetchBtcBalance(addr)
        set((s) => ({ btcTypeBalances: { ...s.btcTypeBalances, [type]: bal } }))
      } catch (err) {
        set((s) => ({
          btcTypeBalances: {
            ...s.btcTypeBalances,
            [type]: { native: '—', loading: false, error: err instanceof Error ? err.message : 'Failed to fetch balance' },
          },
        }))
      }
    }))
  },

  fetchTokenBalance: async (chain: EvmChain, token: TokenInfo, address: string) => {
    if (!token.contractAddress) return // native token uses fetchBalance

    const contractKey = token.contractAddress.toLowerCase()

    // Set loading for this token
    set((s) => ({
      tokenBalances: {
        ...s.tokenBalances,
        [chain]: {
          ...(s.tokenBalances[chain] || {}),
          [contractKey]: { balance: '—', loading: true },
        },
      },
    }))

    try {
      const { display, full } = await fetchErc20Balance(chain, token.contractAddress, address, token.decimals)
      set((s) => ({
        tokenBalances: {
          ...s.tokenBalances,
          [chain]: {
            ...(s.tokenBalances[chain] || {}),
            [contractKey]: { balance: display, balanceFull: display !== full ? full : undefined, loading: false },
          },
        },
      }))
    } catch (err) {
      set((s) => ({
        tokenBalances: {
          ...s.tokenBalances,
          [chain]: {
            ...(s.tokenBalances[chain] || {}),
            [contractKey]: {
              balance: '—',
              loading: false,
              error: err instanceof Error ? err.message : 'Failed to fetch token balance',
            },
          },
        },
      }))
    }
  },

  fetchAllTokenBalances: async (chain: EvmChain, address: string) => {
    const tokens = CHAIN_TOKENS[chain]
    if (!tokens) return
    // Fetch all ERC-20 token balances in parallel (skip native)
    const erc20Tokens = tokens.filter((t) => t.contractAddress !== null)
    await Promise.allSettled(
      erc20Tokens.map((t) => get().fetchTokenBalance(chain, t, address))
    )
  },

  fetchTransactions: async (chain: Chain, address: string, contractAddress?: string) => {
    set((s) => ({
      transactions: {
        ...s.transactions,
        [chain]: { txs: [], loading: true, hasMore: false },
      },
    }))

    try {
      let txs: TxItem[] = []

      if (chain === 'bitcoin') {
        txs = await fetchBtcTransactions(address)
      } else {
        // For token txs, use the token's decimals; for native, use chain decimals
        let decimals = 18
        if (contractAddress) {
          const tokens = CHAIN_TOKENS[chain as EvmChain]
          const token = tokens?.find((t) => t.contractAddress?.toLowerCase() === contractAddress.toLowerCase())
          decimals = token?.decimals ?? 18
        } else {
          const meta = CHAIN_META.find((m) => m.id === chain)
          decimals = meta?.decimals ?? 18
        }
        txs = await fetchEvmTransactions(chain as EvmChain, address, decimals, contractAddress)
      }

      set((s) => ({
        transactions: {
          ...s.transactions,
          [chain]: { txs, loading: false, hasMore: false },
        },
      }))
    } catch (err) {
      set((s) => ({
        transactions: {
          ...s.transactions,
          [chain]: {
            txs: [],
            loading: false,
            hasMore: false,
            error: err instanceof Error ? err.message : 'Failed to fetch transactions',
          },
        },
      }))
    }
  },

  setSelectedChain: (chain: Chain) => set({ selectedChain: chain, selectedToken: null }),

  setSelectedToken: (token: string | null) => set({ selectedToken: token }),

  setBitcoinAddressType: (type: 'taproot' | 'segwit' | 'segwit-odd') => {
    const state = get()
    if (type === state.bitcoinAddressType) return
    // Pick the right address based on current address mode
    let newAddr: string | null = null
    if (type === 'segwit') {
      newAddr = state.addressMode === 'standard' && state.standardBtcSegwitAddress
        ? state.standardBtcSegwitAddress
        : state.btcSegwitAddress
    } else if (type === 'segwit-odd') {
      newAddr = state.btcSegwitOddAddress // odd-y segwit — same in both modes (x-only derived)
    } else {
      newAddr = state.btcTaprootAddress // taproot is same in both modes
    }
    if (!newAddr) return
    set({
      bitcoinAddressType: type,
      addresses: { ...state.addresses, bitcoin: newAddr },
      // Clear stale balance & tx for re-fetch
      balances: { ...state.balances, bitcoin: undefined },
      transactions: { ...state.transactions, bitcoin: undefined },
    })
  },

  setAddressMode: (mode: 'nostr' | 'standard') => {
    const state = get()
    if (mode === state.addressMode) return
    if (mode === 'standard' && !state.standardEvmAddress) return // no private key

    // Pick the EVM address for this mode
    const evmAddr = mode === 'standard' ? state.standardEvmAddress! : state.nostrEvmAddress!

    // Pick the BTC address (taproot + odd-segwit are mode-independent; even-segwit differs by mode)
    const btcAddr = state.bitcoinAddressType === 'segwit'
      ? (mode === 'standard' ? state.standardBtcSegwitAddress! : state.btcSegwitAddress!)
      : state.bitcoinAddressType === 'segwit-odd'
        ? state.btcSegwitOddAddress!
        : state.btcTaprootAddress!

    set({
      addressMode: mode,
      addresses: {
        bitcoin: btcAddr,
        ethereum: evmAddr,
        bnb: evmAddr,
        polygon: evmAddr,
        avalanche: evmAddr,
        base: evmAddr,
      },
      // Clear all balances & txs for re-fetch with new addresses
      balances: {},
      tokenBalances: {},
      transactions: {},
    })
  },

  refreshAll: async () => {
    const { addresses, fetchBalance, fetchAllTokenBalances } = get()
    const chains = Object.keys(addresses) as Chain[]
    await Promise.allSettled([
      ...chains.map((c) => fetchBalance(c)),
      ...chains.filter((c) => c !== 'bitcoin').map((c) =>
        fetchAllTokenBalances(c as EvmChain, addresses[c]!)
      ),
    ])
  },
}))

/**
 * Get the on-chain decimals for a token contract (if already fetched),
 * falling back to the provided hardcoded value.
 */
export function getTokenDecimals(chain: EvmChain, contractAddress: string, fallback: number): number {
  const cached = decimalsCache.get(`${chain}:${contractAddress.toLowerCase()}`)
  return cached ?? fallback
}
