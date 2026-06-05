/**
 * WalletPage — Multi-chain wallet view
 *
 * Sidebar: chain wallet cards (Bitcoin, Ethereum, BNB, Polygon, Avalanche, Base)
 * Main: selected wallet detail with balance, address, send/receive, tx history
 *
 * - Bitcoin: Taproot P2TR derived from user's Nostr x-only pubkey
 * - EVM chains: same derived address (keccak256 of even-y pubkey)
 * - Send: only for nsec/seed users. Signer users see "How to send?" explainer
 */

import { useState, useEffect, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { TransactionDetailModal } from './TransactionDetailModal'
import { SendModal } from './SendModal'
import {
  Copy, Check, ArrowUpRight, ArrowDownLeft, RotateCw, Loader2, X,
  ExternalLink, AlertTriangle, Settings, Info, ChevronDown, ChevronUp,
  QrCode, Send, Download, Coins, ChevronRight, ShieldAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ResizablePanel } from '@/components/ui/ResizablePanel'
import { UserPanel } from '@/components/ui/UserPanel'
import { useUserStore } from '@/stores/userStore'
import { useNavigationStore } from '@/stores/navigationStore'
import { useWalletStore, CHAIN_META, type ChainMeta } from '@/stores/walletStore'
import { type EvmChain } from '@/stores/rpcStore'
import { CHAIN_TOKENS, type TokenInfo } from '@/lib/tokens'
import type { Chain } from '@/lib/crypto/derive'

// ── Token Icons ──
import iconUsdt from '@/assets/icons/blockchain/token/usdt128.png'
import iconUsdc from '@/assets/icons/blockchain/token/usdc128.png'
import iconPyusd from '@/assets/icons/blockchain/token/pyusd128.png'

const TOKEN_ICONS: Record<string, string> = {
  USDT: iconUsdt,
  USDC: iconUsdc,
  PYUSD: iconPyusd,
}

// ── Chain Icons ──

import iconBitcoin from '@/assets/icons/blockchain/native/bitcoin128.png'
import iconEthereum from '@/assets/icons/blockchain/native/ethereum128.png'
import iconBnb from '@/assets/icons/blockchain/native/bnbchain128.png'
import iconPolygon from '@/assets/icons/blockchain/native/polygon128.png'
import iconAvalanche from '@/assets/icons/blockchain/native/avalanche128.png'
import iconBase from '@/assets/icons/blockchain/native/base128.png'

const CHAIN_ICONS: Record<Chain, string> = {
  bitcoin: iconBitcoin,
  ethereum: iconEthereum,
  bnb: iconBnb,
  polygon: iconPolygon,
  avalanche: iconAvalanche,
  base: iconBase,
}

// ── Helpers ──

function truncateAddress(addr: string, head = 10, tail = 8): string {
  if (addr.length <= head + tail + 3) return addr
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`
}

function getExplorerUrl(chain: Chain, address: string): string {
  const explorers: Record<Chain, string> = {
    bitcoin: `https://blockstream.info/address/${address}`,
    ethereum: `https://etherscan.io/address/${address}`,
    bnb: `https://bscscan.com/address/${address}`,
    polygon: `https://polygonscan.com/address/${address}`,
    avalanche: `https://snowtrace.io/address/${address}`,
    base: `https://basescan.org/address/${address}`,
  }
  return explorers[chain]
}

function getTxExplorerUrl(chain: Chain, txid: string): string {
  const explorers: Record<Chain, string> = {
    bitcoin: `https://blockstream.info/tx/${txid}`,
    ethereum: `https://etherscan.io/tx/${txid}`,
    bnb: `https://bscscan.com/tx/${txid}`,
    polygon: `https://polygonscan.com/tx/${txid}`,
    avalanche: `https://snowtrace.io/tx/${txid}`,
    base: `https://basescan.org/tx/${txid}`,
  }
  return explorers[chain]
}

// ══════════════════════════════════════════════════════════
// ─── WALLET PAGE ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════
import { useMobile } from '@/hooks/useMobile'

export function WalletPage() {
  const pubkey = useUserStore((s) => s.pubkey)
  const privateKey = useUserStore((s) => s.privateKey)
  const authMethod = useUserStore((s) => s.authMethod)
  const derived = useWalletStore((s) => s.derived)
  const deriveAddresses = useWalletStore((s) => s.deriveAddresses)
  const selectedChain = useWalletStore((s) => s.selectedChain)
  const addresses = useWalletStore((s) => s.addresses)
  const balances = useWalletStore((s) => s.balances)
  const fetchBalance = useWalletStore((s) => s.fetchBalance)
  const setSelectedChain = useWalletStore((s) => s.setSelectedChain)
  const isMobile = useMobile()
  const [mobileDetail, setMobileDetail] = useState(false)

  const canSend = authMethod === 'nsec' || authMethod === 'seed'

  // Derive addresses on mount (pass private key for nsec/seed users to compute standard addresses)
  useEffect(() => {
    if (pubkey && !derived) {
      deriveAddresses(pubkey, privateKey)
    }
  }, [pubkey, derived])

  // Fetch balances once derived (re-fetch when address mode changes)
  const addressMode = useWalletStore((s) => s.addressMode)
  useEffect(() => {
    if (!derived) return
    for (const meta of CHAIN_META) {
      fetchBalance(meta.id)
    }
  }, [derived, addressMode])

  // Modals
  const [showReceive, setShowReceive] = useState(false)
  const [showHowToSend, setShowHowToSend] = useState(false)
  const [showWalletInfo, setShowWalletInfo] = useState(false)

  const currentAddress = addresses[selectedChain] || ''
  const currentMeta = CHAIN_META.find((m) => m.id === selectedChain)!
  const currentBalance = balances[selectedChain]

  const handleRefreshBalance = useCallback(() => {
    fetchBalance(selectedChain)
  }, [selectedChain])

  const handleSelectChain = useCallback((chain: Chain) => {
    setSelectedChain(chain)
    if (isMobile) setMobileDetail(true)
  }, [isMobile])

  // ── MOBILE LAYOUT ──
  if (isMobile) {
    return (
      <div className="flex flex-col flex-1 h-full overflow-hidden bg-background">
        {mobileDetail ? (
          /* Detail view with back */
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/30">
              <button
                onClick={() => setMobileDetail(false)}
                className="p-1.5 hover:bg-secondary/50 rounded-md transition-colors cursor-pointer"
              >
                <ChevronDown size={18} className="rotate-90 text-muted-foreground" />
              </button>
              <img src={CHAIN_ICONS[selectedChain]} alt="" className="w-5 h-5 rounded-full" />
              <span className="text-sm font-medium text-foreground">{currentMeta.name}</span>
            </div>
            <WalletDetailView
              meta={currentMeta}
              address={currentAddress}
              balance={currentBalance}
              canSend={canSend}
              onRefresh={handleRefreshBalance}
              onReceive={() => setShowReceive(true)}
              onHowToSend={() => setShowHowToSend(true)}
            />
          </div>
        ) : (
          /* Chain card list */
          <div className="flex-1 overflow-y-auto px-3 pt-3 pb-3 space-y-2">
            <div className="px-1 pb-2">
              <h2 className="text-sm font-semibold text-foreground">Wallet</h2>
              <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                Deterministic multi-chain wallets
                <button
                  onClick={() => setShowWalletInfo(true)}
                  className="text-muted-foreground/60 hover:text-primary transition-colors cursor-pointer"
                >
                  <ShieldAlert size={11} />
                </button>
              </p>
            </div>
            {CHAIN_META.map((meta) => (
              <WalletCard
                key={meta.id}
                meta={meta}
                icon={CHAIN_ICONS[meta.id]}
                address={addresses[meta.id]}
                balance={balances[meta.id]}
                isSelected={selectedChain === meta.id}
                onSelect={() => handleSelectChain(meta.id)}
              />
            ))}
          </div>
        )}

        {/* ── Receive Modal ── */}
        {showReceive && (
          <ReceiveModal
            chain={selectedChain}
            address={currentAddress}
            meta={currentMeta}
            onClose={() => setShowReceive(false)}
          />
        )}

        {/* ── How To Send Modal ── */}
        {showHowToSend && (
          <HowToSendModal onClose={() => setShowHowToSend(false)} />
        )}

        {/* ── Wallet Info Modal ── */}
        {showWalletInfo && (
          <WalletInfoModal onClose={() => setShowWalletInfo(false)} />
        )}
      </div>
    )
  }

  // ── DESKTOP LAYOUT ──
  return (
    <div className="flex flex-1 h-full overflow-hidden bg-background">
      {/* ── Sidebar ── */}
      <ResizablePanel
        id="wallet"
        defaultWidth={280}
        minWidth={220}
        maxWidth={400}
        className="flex flex-col border-r border-border bg-secondary/30"
      >
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold text-foreground">Wallet</h2>
          <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
            Deterministic multi-chain wallets
            <button
              onClick={() => setShowWalletInfo(true)}
              className="text-muted-foreground/60 hover:text-primary transition-colors cursor-pointer"
            >
              <ShieldAlert size={11} />
            </button>
          </p>
        </div>

        {/* Chain wallet cards */}
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
          {CHAIN_META.map((meta) => (
            <WalletCard
              key={meta.id}
              meta={meta}
              icon={CHAIN_ICONS[meta.id]}
              address={addresses[meta.id]}
              balance={balances[meta.id]}
              isSelected={selectedChain === meta.id}
              onSelect={() => setSelectedChain(meta.id)}
            />
          ))}
        </div>

        <div className="mt-auto">
          <UserPanel />
        </div>
      </ResizablePanel>

      {/* ── Main Detail View ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <WalletDetailView
          meta={currentMeta}
          address={currentAddress}
          balance={currentBalance}
          canSend={canSend}
          onRefresh={handleRefreshBalance}
          onReceive={() => setShowReceive(true)}
          onHowToSend={() => setShowHowToSend(true)}
        />
      </div>

      {/* ── Receive Modal ── */}
      {showReceive && (
        <ReceiveModal
          chain={selectedChain}
          address={currentAddress}
          meta={currentMeta}
          onClose={() => setShowReceive(false)}
        />
      )}

      {/* ── How To Send Modal ── */}
      {showHowToSend && (
        <HowToSendModal onClose={() => setShowHowToSend(false)} />
      )}

      {/* ── Wallet Info Modal ── */}
      {showWalletInfo && (
        <WalletInfoModal onClose={() => setShowWalletInfo(false)} />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// ─── WALLET CARD (Sidebar) ──────────────────────────────
// ══════════════════════════════════════════════════════════

function WalletCard({
  meta, icon, address, balance, isSelected, onSelect,
}: {
  meta: ChainMeta
  icon: string
  address?: string
  balance?: { native: string; pending?: string; loading: boolean; error?: string }
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'rounded-xl border transition-all duration-200 overflow-hidden w-full text-left cursor-pointer',
        isSelected
          ? 'border-primary/40 bg-primary/5 shadow-lg shadow-primary/5'
          : 'border-border/60 bg-background/60 hover:border-border hover:bg-background/80',
      )}
    >
      <div className="px-3.5 py-3">
        {/* Chain header */}
        <div className="flex items-center gap-2.5 mb-2">
          <img src={icon} alt={meta.name} className="w-8 h-8 rounded-full" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground leading-tight">{meta.name}</p>
            <p className="text-[10px] text-muted-foreground font-mono truncate">
              {address ? truncateAddress(address, 8, 6) : '—'}
            </p>
          </div>
        </div>

        {/* Balance */}
        <div>
          {balance?.loading ? (
            <div className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Fetching...</span>
            </div>
          ) : balance?.error ? (
            <div className="flex items-center gap-1.5">
              <AlertTriangle size={12} className="text-amber-500 shrink-0" />
              <span className="text-xs text-muted-foreground">Unavailable</span>
            </div>
          ) : (
            <div>
              <p className="text-base font-bold text-foreground leading-tight">
                {balance?.native || '0'} <span className="text-xs font-normal text-muted-foreground">{meta.symbol}</span>
              </p>
              {balance?.pending && (
                <p className="text-[10px] text-amber-400 mt-0.5">
                  +{balance.pending} pending
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  )
}

// ══════════════════════════════════════════════════════════
// ─── WALLET DETAIL VIEW ─────────────────────────────────
// ══════════════════════════════════════════════════════════

function WalletDetailView({
  meta, address, balance, canSend, onRefresh, onReceive, onHowToSend,
}: {
  meta: ChainMeta
  address: string
  balance?: { native: string; nativeRaw?: bigint; pending?: string; loading: boolean; error?: string }
  canSend: boolean
  onRefresh: () => void
  onReceive: () => void
  onHowToSend: () => void
}) {
  const privateKey = useUserStore((s) => s.privateKey)
  const [showSend, setShowSend] = useState(false)
  const [copied, setCopied] = useState(false)
  const setActivePage = useNavigationStore((s) => s.setActivePage)
  const setSettingsTab = useNavigationStore((s) => s.setSettingsTab)
  const selectedChain = useWalletStore((s) => s.selectedChain)
  const transactions = useWalletStore((s) => s.transactions[selectedChain])
  const fetchTransactions = useWalletStore((s) => s.fetchTransactions)
  const selectedToken = useWalletStore((s) => s.selectedToken)
  const setSelectedToken = useWalletStore((s) => s.setSelectedToken)
  const tokenBalances = useWalletStore((s) => s.tokenBalances[selectedChain])
  const fetchAllTokenBalances = useWalletStore((s) => s.fetchAllTokenBalances)
  const bitcoinAddressType = useWalletStore((s) => s.bitcoinAddressType)
  const setBitcoinAddressType = useWalletStore((s) => s.setBitcoinAddressType)
  const addressMode = useWalletStore((s) => s.addressMode)
  const setAddressMode = useWalletStore((s) => s.setAddressMode)
  const standardEvmAddress = useWalletStore((s) => s.standardEvmAddress)
  const nostrEvmAddress = useWalletStore((s) => s.nostrEvmAddress)
  // Only show toggle when addresses actually differ (even-y keys produce identical addresses)
  const hasDistinctModes = !!(standardEvmAddress && nostrEvmAddress && standardEvmAddress !== nostrEvmAddress)
  const [selectedTx, setSelectedTx] = useState<import('@/stores/walletStore').TxItem | null>(null)

  // Re-fetch Bitcoin balance when address type changes (address changes)
  const fetchBalance = useWalletStore((s) => s.fetchBalance)
  useEffect(() => {
    if (selectedChain === 'bitcoin' && address && !balance?.native) {
      fetchBalance('bitcoin')
    }
  }, [address, selectedChain])

  // Fetch tx history when chain or selected token changes
  useEffect(() => {
    if (!address) return
    if (selectedChain === 'bitcoin') {
      fetchTransactions(selectedChain, address)
    } else {
      // Find contract address for selected token
      const tokenInfo = selectedToken
        ? (CHAIN_TOKENS[selectedChain as EvmChain] || []).find((t) => t.symbol === selectedToken)
        : null
      const contractAddr = tokenInfo?.contractAddress || undefined
      fetchTransactions(selectedChain, address, contractAddr)
    }
  }, [selectedChain, address, selectedToken])

  // Fetch token balances when EVM chain changes
  useEffect(() => {
    if (address && selectedChain !== 'bitcoin') {
      fetchAllTokenBalances(selectedChain as EvmChain, address)
    }
  }, [selectedChain, address])

  // Get tokens for current chain
  const chainTokens = selectedChain !== 'bitcoin' ? CHAIN_TOKENS[selectedChain as EvmChain] || [] : []
  const activeTokenInfo = selectedToken
    ? chainTokens.find((t) => t.symbol === selectedToken) || null
    : null

  // Get display balance for selected token
  const displayBalance = activeTokenInfo && activeTokenInfo.contractAddress
    ? tokenBalances?.[activeTokenInfo.contractAddress.toLowerCase()]?.balance || '0'
    : balance?.native || '0'
  // Full precision balance (only set when truncated differs from full)
  const fullBalance = activeTokenInfo && activeTokenInfo.contractAddress
    ? tokenBalances?.[activeTokenInfo.contractAddress.toLowerCase()]?.balanceFull || null
    : balance?.nativeFull || null
  const displaySymbol = activeTokenInfo ? activeTokenInfo.symbol : meta.symbol

  const handleCopy = () => {
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleGoToRpcSettings = () => {
    setSettingsTab('network')
    useNavigationStore.getState().setSettingsNetworkTab('rpc')
    setActivePage('settings')
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header area */}
      <div className="px-8 pt-8 pb-6">
        {/* Chain badge + refresh */}
        <div className="flex items-center gap-3 mb-6">
          <img src={CHAIN_ICONS[meta.id]} alt={meta.name} className="w-12 h-12 rounded-full shadow-lg" />
          <div className="flex-1">
            <h1 className="text-xl font-bold text-foreground">{meta.name} Wallet</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-xs text-muted-foreground">
                {meta.id === 'bitcoin'
                  ? (bitcoinAddressType === 'taproot' ? 'Taproot (P2TR)' : 'SegWit (P2WPKH)')
                  : 'EVM Compatible'
                }
              </p>
              {/* Nostr/Standard toggle — disabled when addresses match */}
              {canSend && standardEvmAddress && (
                hasDistinctModes ? (
                  <button
                    onClick={() => setAddressMode(addressMode === 'nostr' ? 'standard' : 'nostr')}
                    className={cn(
                      'px-2 py-0.5 text-[10px] font-medium rounded-full border transition-all cursor-pointer',
                      addressMode === 'nostr'
                        ? 'bg-primary/10 text-primary border-primary/30'
                        : 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                    )}
                  >
                    {addressMode === 'nostr' ? 'Nostr' : 'Standard'}
                  </button>
                ) : (
                  <span className="px-2 py-0.5 text-[10px] font-medium rounded-full border border-border/40 bg-secondary/30 text-muted-foreground">
                    Nostr &amp; Standard Match
                  </span>
                )
              )}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onRefresh()
              // Also refresh transactions
              if (address) {
                if (selectedChain === 'bitcoin') {
                  fetchTransactions(selectedChain, address)
                } else {
                  const contractAddr = activeTokenInfo?.contractAddress || undefined
                  fetchTransactions(selectedChain, address, contractAddr)
                }
                // Also refresh token balances for EVM chains
                if (selectedChain !== 'bitcoin') {
                  fetchAllTokenBalances(selectedChain as EvmChain, address)
                }
              }
            }}
            disabled={balance?.loading}
            className="gap-1.5 rounded-lg"
          >
            {balance?.loading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RotateCw size={13} />
            )}
            Refresh
          </Button>
        </div>

        {/* ── Bitcoin Address Type Selector ── */}
        {selectedChain === 'bitcoin' && (
          <div className="mb-4">
            <div className="flex items-center gap-1.5">
              {(['taproot', 'segwit'] as const).map((type) => {
                const isSelected = bitcoinAddressType === type
                const label = type === 'taproot' ? 'Taproot' : 'SegWit'
                const detail = type === 'taproot' ? 'bc1p…' : 'bc1q…'
                return (
                  <button
                    key={type}
                    onClick={() => setBitcoinAddressType(type)}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-xl border transition-all cursor-pointer shrink-0',
                      isSelected
                        ? 'border-primary/50 bg-primary/10 shadow-sm'
                        : 'border-border/40 bg-secondary/20 hover:bg-secondary/40 hover:border-border/60'
                    )}
                  >
                    <img src={CHAIN_ICONS.bitcoin} alt="BTC" className="w-5 h-5 rounded-full" />
                    <div className="flex flex-col items-start">
                      <span className={cn('text-[11px] font-semibold leading-tight', isSelected ? 'text-foreground' : 'text-muted-foreground')}>
                        {label}
                      </span>
                      <span className="text-[9px] text-muted-foreground/70 leading-tight">
                        {detail}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Token Selector (EVM chains only) ── */}
        {selectedChain !== 'bitcoin' && chainTokens.length > 0 && (
          <div className="mb-4">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              {chainTokens.map((token) => {
                const isNative = token.contractAddress === null
                const isSelected = isNative ? !selectedToken : selectedToken === token.symbol
                const tokenIcon = isNative ? CHAIN_ICONS[meta.id] : TOKEN_ICONS[token.symbol]
                const tokenBal = isNative
                  ? balance?.native || '0'
                  : tokenBalances?.[token.contractAddress!.toLowerCase()]?.balance || '0'
                const tokenLoading = isNative
                  ? balance?.loading
                  : tokenBalances?.[token.contractAddress!.toLowerCase()]?.loading

                return (
                  <button
                    key={token.symbol + (token.contractAddress || 'native')}
                    onClick={() => setSelectedToken(isNative ? null : token.symbol)}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-xl border transition-all cursor-pointer shrink-0',
                      isSelected
                        ? 'border-primary/50 bg-primary/10 shadow-sm'
                        : 'border-border/40 bg-secondary/20 hover:bg-secondary/40 hover:border-border/60'
                    )}
                  >
                    {tokenIcon ? (
                      <img src={tokenIcon} alt={token.symbol} className="w-5 h-5 rounded-full" />
                    ) : (
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                        style={{ backgroundColor: token.color }}
                      >
                        {token.symbol.slice(0, 2)}
                      </span>
                    )}
                    <div className="flex flex-col items-start">
                      <span className={cn('text-[11px] font-semibold leading-tight', isSelected ? 'text-foreground' : 'text-muted-foreground')}>
                        {token.symbol}
                      </span>
                      <span className="text-[9px] text-muted-foreground/70 leading-tight">
                        {tokenLoading ? '...' : tokenBal === '0' ? '0' : tokenBal.length > 10 ? tokenBal.slice(0, 10) + '…' : tokenBal}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="rounded-2xl bg-gradient-to-br from-secondary/60 to-secondary/30 border border-border/50 p-6 mb-6">
          <p className="text-xs text-muted-foreground mb-1 uppercase tracking-wider font-medium">Balance</p>
          {balance?.loading && !balance.native ? (
            <div className="flex items-center gap-2">
              <Loader2 size={18} className="animate-spin text-muted-foreground" />
              <span className="text-lg text-muted-foreground">Loading...</span>
            </div>
          ) : balance?.error ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle size={18} className="text-amber-500 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-foreground">Failed to fetch balance</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{balance.error}</p>
                </div>
              </div>
              <div className="rounded-lg bg-secondary/50 border border-border/40 p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  {meta.id === 'bitcoin'
                    ? 'The Blockstream API may be temporarily unavailable. Try refreshing.'
                    : 'The default free RPC may require authentication or be rate-limited. Configure your own RPC endpoint for reliable access.'
                  }
                </p>
                {meta.id !== 'bitcoin' && (
                  <button
                    onClick={handleGoToRpcSettings}
                    className="flex items-center gap-1.5 text-xs text-primary hover:underline cursor-pointer"
                  >
                    <Settings size={12} />
                    Configure RPC in Settings → Network → RPC
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <p className="text-3xl font-bold text-foreground tracking-tight">
                {displayBalance}
                <span className="text-lg font-normal text-muted-foreground ml-2">{displaySymbol}</span>
              </p>
              {fullBalance && (
                <p className="text-xs text-muted-foreground font-mono mt-0.5 opacity-60">
                  {fullBalance} {displaySymbol}
                </p>
              )}
              {!selectedToken && balance?.pending && (
                <p className="text-sm text-amber-400 mt-1">
                  +{balance.pending} {meta.symbol} pending (mempool)
                </p>
              )}
            </>
          )}
        </div>

        {/* Address row */}
        <div className="flex items-center gap-2 mb-6">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium mb-1">Address</p>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/40 border border-border/50">
              <code className="text-xs text-foreground font-mono truncate flex-1">{address}</code>
              <button
                onClick={handleCopy}
                className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
              >
                {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
              </button>
              <a
                href={getExplorerUrl(meta.id, address)}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors cursor-pointer"
              >
                <ExternalLink size={14} />
              </a>
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          {canSend ? (
            <Button variant="default" className="gap-2 flex-1 rounded-xl h-11" onClick={() => setShowSend(true)}>
              <Send size={15} />
              Send
            </Button>
          ) : (
            <Button
              variant="outline"
              className="gap-2 flex-1 rounded-xl h-11"
              onClick={onHowToSend}
            >
              <Info size={15} />
              How to Send?
            </Button>
          )}
          <Button
            variant="outline"
            className="gap-2 flex-1 rounded-xl h-11"
            onClick={onReceive}
          >
            <Download size={15} />
            Receive
          </Button>
        </div>
      </div>

      {/* Transaction history */}
      <div className="flex-1 overflow-y-auto px-8 pb-6 border-t border-border">
        <div className="flex items-center justify-between py-4">
          <h3 className="text-sm font-semibold text-foreground">Transaction History</h3>
          {meta.id !== 'bitcoin' && (
            <button
              onClick={handleGoToRpcSettings}
              className="flex items-center gap-1.5 text-[10px] text-primary hover:underline cursor-pointer"
            >
              <Settings size={11} />
              Configure RPC for tx history
            </button>
          )}
        </div>

        {transactions?.loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : transactions?.error ? (
          <div className="text-center py-8">
            <AlertTriangle size={20} className="mx-auto text-destructive mb-2" />
            <p className="text-sm text-muted-foreground">{transactions.error}</p>
          </div>
        ) : transactions?.txs && transactions.txs.length > 0 ? (
          <div className="space-y-1.5">
            {transactions.txs.map((tx) => (
              <button
                key={tx.txid}
                onClick={() => setSelectedTx(tx)}
                className="flex items-center gap-3 px-3.5 py-3 rounded-xl hover:bg-secondary/40 transition-colors group cursor-pointer w-full text-left"
              >
                <div className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center shrink-0',
                  tx.type === 'in' ? 'bg-green-500/10' : 'bg-red-500/10',
                )}>
                  {tx.type === 'in' ? (
                    <ArrowDownLeft size={14} className="text-green-500" />
                  ) : (
                    <ArrowUpRight size={14} className="text-red-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {tx.type === 'in' ? 'Received' : 'Sent'}
                  </p>
                  <p className="text-[10px] text-muted-foreground font-mono truncate">
                    {tx.txid.slice(0, 16)}...{tx.txid.slice(-8)}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className={cn(
                    'text-sm font-semibold',
                    tx.type === 'in' ? 'text-green-500' : 'text-foreground',
                  )}>
                    {tx.type === 'in' ? '+' : '-'}{tx.amount} {displaySymbol}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {new Date(tx.timestamp * 1000).toLocaleDateString()}
                  </p>
                </div>
                <ChevronRight size={14} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-sm text-muted-foreground">No transactions yet</p>
          </div>
        )}
      </div>

      {/* Transaction Detail Modal */}
      <TransactionDetailModal
        tx={selectedTx}
        chain={selectedChain}
        chainSymbol={meta.symbol}
        displaySymbol={displaySymbol}
        userAddress={address}
        onClose={() => setSelectedTx(null)}
      />

      {/* Send Modal */}
      {showSend && privateKey && (
        <SendModal
          chain={selectedChain}
          address={address}
          privateKeyHex={privateKey}
          balance={displayBalance}
          balanceRaw={balance?.nativeRaw}
          selectedToken={selectedToken}
          onClose={() => setShowSend(false)}
        />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// ─── RECEIVE MODAL ──────────────────────────────────────
// ══════════════════════════════════════════════════════════

function ReceiveModal({
  chain, address, meta, onClose,
}: {
  chain: Chain
  address: string
  meta: ChainMeta
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const qrValue = chain === 'bitcoin' ? `bitcoin:${address}` : address

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[200]" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <img src={CHAIN_ICONS[chain]} alt={meta.name} className="w-8 h-8 rounded-full" />
            <div>
              <h3 className="text-base font-semibold text-foreground">Receive {meta.symbol}</h3>
              <p className="text-[10px] text-muted-foreground">{meta.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* QR Code */}
        <div className="flex justify-center mb-5">
          <div className="p-4 rounded-2xl bg-white">
            <QRCodeSVG value={qrValue} size={200} level="M" />
          </div>
        </div>

        {/* Address */}
        <div className="px-3 py-2.5 rounded-xl bg-secondary/40 border border-border/50 mb-4">
          <p className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wider font-medium">
            {chain === 'bitcoin' ? 'Taproot Address' : 'EVM Address'}
          </p>
          <code className="text-xs text-foreground font-mono break-all leading-relaxed">{address}</code>
        </div>

        <Button onClick={handleCopy} variant="outline" className="w-full gap-2 rounded-xl">
          {copied ? (
            <><Check size={14} className="text-green-500" /> Copied!</>
          ) : (
            <><Copy size={14} /> Copy Address</>
          )}
        </Button>

        {chain !== 'bitcoin' && (
          <p className="text-[10px] text-muted-foreground text-center mt-3">
            This address works on {meta.name}. Sending tokens on the wrong chain may result in loss of funds.
          </p>
        )}
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// ─── HOW TO SEND MODAL ──────────────────────────────────
// ══════════════════════════════════════════════════════════

function HowToSendModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[200]" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="shrink-0 w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Info size={20} className="text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-foreground">How to Send</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Your wallet is in read-only mode</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
          <p>
            You're signed in with an <strong className="text-foreground">external signer</strong>, which means DEN Chat
            doesn't have access to your private key. Without the private key, we can't sign blockchain transactions.
          </p>

          <div className="rounded-xl bg-secondary/40 border border-border/50 p-4 space-y-3">
            <p className="text-xs font-semibold text-foreground uppercase tracking-wider">To send funds, you can:</p>
            <div className="space-y-2.5">
              <div className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">1</span>
                <p className="text-xs">
                  <strong className="text-foreground">Log in with your nsec or seed phrase</strong> in DEN Chat to unlock full wallet functionality including sending.
                </p>
              </div>
              <div className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">2</span>
                <p className="text-xs">
                  <strong className="text-foreground">Use DENOS</strong> — our desktop signer app has a built-in wallet that can see and spend from this same address.
                </p>
              </div>
              <div className="flex gap-2.5">
                <span className="shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">3</span>
                <p className="text-xs">
                  <strong className="text-foreground">Import into any wallet</strong> — your Nostr private key (nsec) controls these addresses. Import it into any Bitcoin (Taproot) or EVM-compatible wallet.
                </p>
              </div>
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground/70">
            Your Nostr key pair deterministically derives these blockchain addresses. The same private key that signs Nostr events also controls these wallets.
          </p>
        </div>

        <Button onClick={onClose} variant="outline" className="w-full mt-5 rounded-xl">
          Got it
        </Button>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════
// ─── WALLET INFO MODAL ──────────────────────────────────
// ══════════════════════════════════════════════════════════

function WalletInfoModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[200]" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl p-6 max-w-md w-full mx-4 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-5">
          <div className="shrink-0 w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
            <ShieldAlert size={20} className="text-amber-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold text-foreground">Public Wallet</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Important privacy information</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 text-sm text-muted-foreground leading-relaxed">
          <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-4">
            <p className="text-xs leading-relaxed text-amber-200/90">
              These reusable addresses are linked to your Nostr identity. Anyone can see its balance, transaction history, and send funds to it without your consent.
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex gap-2.5">
              <div className="shrink-0 w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center mt-0.5">
                <span className="text-primary text-[10px] font-bold">1</span>
              </div>
              <p className="text-xs">
                <strong className="text-foreground">Deterministic derivation</strong> — your Nostr private key (nsec) deterministically derives these blockchain addresses. The same key that signs Nostr events also controls these wallets.
              </p>
            </div>
            <div className="flex gap-2.5">
              <div className="shrink-0 w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center mt-0.5">
                <span className="text-primary text-[10px] font-bold">2</span>
              </div>
              <p className="text-xs">
                <strong className="text-foreground">Address reuse</strong> — each chain generates one address that is reused for all transactions. This differs from HD wallets that generate new addresses for each transaction.
              </p>
            </div>
            <div className="flex gap-2.5">
              <div className="shrink-0 w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center mt-0.5">
                <span className="text-primary text-[10px] font-bold">3</span>
              </div>
              <p className="text-xs">
                <strong className="text-foreground">Public linkability</strong> — anyone who knows your npub can derive your wallet addresses and view your on-chain activity.
              </p>
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground/70">
            For better privacy, consider using separate wallets for large holdings and keep only small amounts in this social wallet.
          </p>
        </div>

        <Button onClick={onClose} variant="outline" className="w-full mt-5 rounded-xl">
          Understood
        </Button>
      </div>
    </div>
  )
}
