import { create } from 'zustand'

/* ─── RPC Endpoint Store ───
 *
 * Manages user-configurable RPC nodes for blockchain queries.
 * Persisted to localStorage. Free public RPCs as defaults (matching DENOS).
 *
 * Bitcoin: ordered list of fallback REST API nodes.
 * EVM chains: ordered list of fallback JSON-RPC nodes.
 */

export type RpcChain = 'bitcoin' | 'ethereum' | 'bnb' | 'polygon' | 'avalanche' | 'base'
export type EvmChain = Exclude<RpcChain, 'bitcoin'>

export interface EvmChainConfig {
  nodes: string[]
}

interface RpcState {
  /** Bitcoin-specific: ordered list of REST API nodes for failover */
  bitcoinNodes: string[]
  /** EVM chains: ordered list of JSON-RPC nodes */
  evmChains: Record<EvmChain, EvmChainConfig>

  // Bitcoin node management
  setBitcoinNodes: (nodes: string[]) => void
  addBitcoinNode: (url: string) => void
  removeBitcoinNode: (url: string) => void

  // EVM node management
  setEvmNodes: (chain: EvmChain, nodes: string[]) => void
  addEvmNode: (chain: EvmChain, url: string) => void
  removeEvmNode: (chain: EvmChain, url: string) => void

  /** Get the node list for an EVM chain */
  getEffectiveNodes: (chain: EvmChain) => string[]

  // GoldRush (Covalent) API key — global, used as fallback for tx history
  goldrushApiKey: string
  setGoldrushApiKey: (key: string) => void

  // Etherscan API key — global, used for explorer queries
  etherscanApiKey: string
  setEtherscanApiKey: (key: string) => void

  // Reset
  resetDefaults: () => void
  resetChain: (chain: RpcChain) => void
}

const STORAGE_KEY_LEGACY = 'den-chat-rpc-endpoints'
const BTC_NODES_KEY = 'den-chat-bitcoin-nodes'
const EVM_KEY = 'den-chat-evm-chains'
const GOLDRUSH_KEY = 'den-chat-goldrush-apikey'
const ETHERSCAN_KEY = 'den-chat-etherscan-apikey'

// ── Defaults (matching DENOS, reordered for browser CORS compatibility) ──

const DEFAULT_BITCOIN_NODES: string[] = [
  'https://blockstream.info/api',
  'https://mempool.space/api',
  'https://mempool.emzy.de/api',
]

const DEFAULT_EVM_CHAINS: Record<EvmChain, EvmChainConfig> = {
  ethereum: {
    nodes: [
      'https://ethereum-rpc.publicnode.com',
      'https://1rpc.io/eth',
      'https://eth.drpc.org',
    ],
  },
  bnb: {
    nodes: [
      'https://1rpc.io/bnb',
      'https://bsc.drpc.org',
      'https://bsc-rpc.publicnode.com',
    ],
  },
  polygon: {
    nodes: [
      'https://1rpc.io/matic',
      'https://polygon.drpc.org',
      'https://polygon-bor-rpc.publicnode.com',
    ],
  },
  avalanche: {
    nodes: [
      'https://1rpc.io/avax/c',
      'https://avax.drpc.org',
      'https://avalanche-c-chain-rpc.publicnode.com',
    ],
  },
  base: {
    nodes: [
      'https://1rpc.io/base',
      'https://base.drpc.org',
      'https://base-rpc.publicnode.com',
    ],
  },
}

// ── Persistence helpers ──

function loadBitcoinNodes(): string[] {
  try {
    const raw = localStorage.getItem(BTC_NODES_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    }
  } catch { /* ignore */ }
  return [...DEFAULT_BITCOIN_NODES]
}

function loadEvmChains(): Record<EvmChain, EvmChainConfig> {
  try {
    const raw = localStorage.getItem(EVM_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      const result = { ...DEFAULT_EVM_CHAINS }
      for (const key of Object.keys(parsed)) {
        if (key in result) {
          result[key as EvmChain] = {
            ...DEFAULT_EVM_CHAINS[key as EvmChain],
            ...parsed[key],
          }
        }
      }
      return result
    }
  } catch { /* ignore */ }
  // Migrate: clear legacy data
  try { localStorage.removeItem(STORAGE_KEY_LEGACY) } catch { /* ignore */ }
  return deepCloneEvmChains(DEFAULT_EVM_CHAINS)
}

function saveBitcoinNodes(nodes: string[]) {
  try { localStorage.setItem(BTC_NODES_KEY, JSON.stringify(nodes)) } catch { /* ignore */ }
}

function saveEvmChains(chains: Record<EvmChain, EvmChainConfig>) {
  try { localStorage.setItem(EVM_KEY, JSON.stringify(chains)) } catch { /* ignore */ }
}

function deepCloneEvmChains(src: Record<EvmChain, EvmChainConfig>): Record<EvmChain, EvmChainConfig> {
  const result = {} as Record<EvmChain, EvmChainConfig>
  for (const key of Object.keys(src) as EvmChain[]) {
    result[key] = { nodes: [...src[key].nodes] }
  }
  return result
}

function loadGoldrushApiKey(): string {
  try {
    return localStorage.getItem(GOLDRUSH_KEY) || ''
  } catch { return '' }
}

function saveGoldrushApiKey(key: string) {
  try {
    if (key) localStorage.setItem(GOLDRUSH_KEY, key)
    else localStorage.removeItem(GOLDRUSH_KEY)
  } catch { /* ignore */ }
}

function loadEtherscanApiKey(): string {
  try {
    return localStorage.getItem(ETHERSCAN_KEY) || ''
  } catch { return '' }
}

function saveEtherscanApiKey(key: string) {
  try {
    if (key) localStorage.setItem(ETHERSCAN_KEY, key)
    else localStorage.removeItem(ETHERSCAN_KEY)
  } catch { /* ignore */ }
}

// ── Store ──

export const useRpcStore = create<RpcState>((set, get) => ({
  bitcoinNodes: loadBitcoinNodes(),
  evmChains: loadEvmChains(),
  goldrushApiKey: loadGoldrushApiKey(),
  etherscanApiKey: loadEtherscanApiKey(),

  // ── Bitcoin ──

  setBitcoinNodes: (nodes) => {
    set({ bitcoinNodes: nodes })
    saveBitcoinNodes(nodes)
  },
  addBitcoinNode: (url) => {
    const normalized = url.replace(/\/+$/, '')
    const current = get().bitcoinNodes
    if (!current.includes(normalized)) {
      const updated = [...current, normalized]
      set({ bitcoinNodes: updated })
      saveBitcoinNodes(updated)
    }
  },
  removeBitcoinNode: (url) => {
    const updated = get().bitcoinNodes.filter((n) => n !== url)
    set({ bitcoinNodes: updated })
    saveBitcoinNodes(updated)
  },

  // ── EVM ──

  setEvmNodes: (chain, nodes) => {
    const updated = { ...get().evmChains, [chain]: { ...get().evmChains[chain], nodes } }
    set({ evmChains: updated })
    saveEvmChains(updated)
  },
  addEvmNode: (chain, url) => {
    const normalized = url.replace(/\/+$/, '')
    const current = get().evmChains[chain].nodes
    if (!current.includes(normalized)) {
      const updated = {
        ...get().evmChains,
        [chain]: { ...get().evmChains[chain], nodes: [...current, normalized] },
      }
      set({ evmChains: updated })
      saveEvmChains(updated)
    }
  },
  removeEvmNode: (chain, url) => {
    const updated = {
      ...get().evmChains,
      [chain]: {
        ...get().evmChains[chain],
        nodes: get().evmChains[chain].nodes.filter((n) => n !== url),
      },
    }
    set({ evmChains: updated })
    saveEvmChains(updated)
  },

  getEffectiveNodes: (chain) => {
    return get().evmChains[chain].nodes
  },

  setGoldrushApiKey: (key) => {
    set({ goldrushApiKey: key.trim() })
    saveGoldrushApiKey(key.trim())
  },

  setEtherscanApiKey: (key) => {
    set({ etherscanApiKey: key.trim() })
    saveEtherscanApiKey(key.trim())
  },

  // ── Reset ──

  resetDefaults: () => {
    const btc = [...DEFAULT_BITCOIN_NODES]
    const evm = deepCloneEvmChains(DEFAULT_EVM_CHAINS)
    set({ bitcoinNodes: btc, evmChains: evm, etherscanApiKey: '' })
    saveBitcoinNodes(btc)
    saveEvmChains(evm)
    saveEtherscanApiKey('')
  },

  resetChain: (chain) => {
    if (chain === 'bitcoin') {
      const btc = [...DEFAULT_BITCOIN_NODES]
      set({ bitcoinNodes: btc })
      saveBitcoinNodes(btc)
    } else {
      const updated = {
        ...get().evmChains,
        [chain]: { nodes: [...DEFAULT_EVM_CHAINS[chain].nodes] },
      }
      set({ evmChains: updated })
      saveEvmChains(updated)
    }
  },
}))

export { DEFAULT_BITCOIN_NODES, DEFAULT_EVM_CHAINS }
