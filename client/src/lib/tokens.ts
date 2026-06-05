import type { EvmChain } from '@/stores/rpcStore'

/* ─── Token Metadata ───
 *
 * ERC-20 token definitions for all supported EVM chains.
 * Data matches DENOS exactly. Native tokens use contractAddress: null.
 */

export interface TokenInfo {
  symbol: string
  name: string
  contractAddress: string | null  // null = native token
  decimals: number
  color: string
  iconPath?: string  // import path alias, we'll set actual imports in the component
}

/** ERC-20 `balanceOf(address)` function selector */
export const BALANCE_OF_SELECTOR = '0x70a08231'

export const CHAIN_TOKENS: Record<EvmChain, TokenInfo[]> = {
  ethereum: [
    { symbol: 'ETH',  name: 'Ethereum',    contractAddress: null,                                           decimals: 18, color: '#627EEA' },
    { symbol: 'USDT', name: 'Tether USD',  contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',    decimals: 6,  color: '#26A17B' },
    { symbol: 'USDC', name: 'USD Coin',    contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',    decimals: 6,  color: '#2775CA' },
    { symbol: 'DAI',  name: 'Dai',         contractAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',    decimals: 18, color: '#F5AC37' },
    { symbol: 'PYUSD', name: 'PayPal USD', contractAddress: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',    decimals: 6,  color: '#0070BA' },
    { symbol: 'EURC', name: 'Euro Coin',   contractAddress: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',    decimals: 6,  color: '#2B6CB0' },
  ],
  bnb: [
    { symbol: 'BNB',  name: 'BNB',         contractAddress: null,                                           decimals: 18, color: '#F0B90B' },
    { symbol: 'USDT', name: 'Tether USD',  contractAddress: '0x55d398326f99059fF775485246999027B3197955',    decimals: 18, color: '#26A17B' },
    { symbol: 'USDC', name: 'USD Coin',    contractAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',    decimals: 18, color: '#2775CA' },
    { symbol: 'BUSD', name: 'Binance USD', contractAddress: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',    decimals: 18, color: '#F0B90B' },
  ],
  polygon: [
    { symbol: 'POL',  name: 'POL',         contractAddress: null,                                           decimals: 18, color: '#8247E5' },
    { symbol: 'USDT', name: 'Tether USD',  contractAddress: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',    decimals: 6,  color: '#26A17B' },
    { symbol: 'USDC', name: 'USD Coin',    contractAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',    decimals: 6,  color: '#2775CA' },
  ],
  avalanche: [
    { symbol: 'AVAX', name: 'Avalanche',   contractAddress: null,                                           decimals: 18, color: '#E84142' },
    { symbol: 'USDT', name: 'Tether USD',  contractAddress: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',    decimals: 6,  color: '#26A17B' },
    { symbol: 'USDC', name: 'USD Coin',    contractAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',    decimals: 6,  color: '#2775CA' },
  ],
  base: [
    { symbol: 'ETH',  name: 'Ethereum',    contractAddress: null,                                           decimals: 18, color: '#627EEA' },
    { symbol: 'USDC', name: 'USD Coin',    contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',    decimals: 6,  color: '#2775CA' },
    { symbol: 'EURC', name: 'Euro Coin',   contractAddress: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',    decimals: 6,  color: '#2B6CB0' },
  ],
}

/** Look up a token by chain and symbol (case-insensitive) */
export function getTokenForChain(chain: EvmChain, symbol: string): TokenInfo | undefined {
  const upper = symbol.toUpperCase()
  return CHAIN_TOKENS[chain].find((t) => t.symbol.toUpperCase() === upper)
}
