/**
 * SendModal — Multi-chain send transaction modal
 *
 * Steps: Input → Confirm → Result
 * Supports: EVM native, ERC-20 tokens, Bitcoin (Taproot + SegWit)
 */

import { useState, useEffect, useCallback } from 'react'
import {
  X, Send, ArrowRight, Loader2, CheckCircle, XCircle,
  ExternalLink, AlertTriangle, Fuel, Users, Zap, Clock, Wallet, ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useWalletStore, getTokenDecimals } from '@/stores/walletStore'
import type { Chain } from '@/lib/crypto/derive'
import type { EvmChain } from '@/stores/rpcStore'
import { CHAIN_TOKENS, type TokenInfo } from '@/lib/tokens'
import { ContactPickerModal } from './ContactPickerModal'
import { nip19 } from 'nostr-tools'
import { deriveEvmAddress, deriveTaprootAddress, deriveSegwitAddress, deriveSegwitOddAddress } from '@/lib/crypto/derive'
import { useUserStore } from '@/stores/userStore'
import { rustBackend, vaultBackend, type BtcSignTx, type EvmSignTx } from '@/lib/auth/authBackend'
import { PinInput } from '@/components/auth/PinInput'


// ── Types ──

type SendStep = 'input' | 'confirm' | 'sending' | 'result'

interface SendModalProps {
  chain: Chain
  address: string
  balance: string          // formatted native balance
  selectedToken: string | null
  onClose: () => void
}

// ── Chain metadata ──

const CHAIN_SYMBOLS: Record<Chain, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  bnb: 'BNB',
  polygon: 'POL',
  avalanche: 'AVAX',
  base: 'ETH',
}

const CHAIN_DECIMALS: Record<Chain, number> = {
  bitcoin: 8,
  ethereum: 18,
  bnb: 18,
  polygon: 18,
  avalanche: 18,
  base: 18,
}

const EXPLORER_TX: Record<Chain, string> = {
  bitcoin: 'https://mempool.space/tx/',
  ethereum: 'https://etherscan.io/tx/',
  bnb: 'https://bscscan.com/tx/',
  polygon: 'https://polygonscan.com/tx/',
  avalanche: 'https://snowtrace.io/tx/',
  base: 'https://basescan.org/tx/',
}

// ── Helpers ──

function parseAmount(amount: string, decimals: number): bigint {
  if (!amount || amount === '0') return 0n
  const parts = amount.split('.')
  const whole = parts[0] || '0'
  let frac = parts[1] || ''
  // Pad or truncate fractional part
  if (frac.length > decimals) frac = frac.slice(0, decimals)
  else frac = frac.padEnd(decimals, '0')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac)
}

function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0'
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const frac = raw % divisor
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${whole}.${fracStr}`
}

function isValidEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

function isValidBtcAddress(addr: string): boolean {
  // Basic validation for bech32/bech32m addresses
  return /^(bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(addr)
}

function truncateAddr(addr: string): string {
  if (addr.length <= 16) return addr
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`
}

// ── Component ──

export function SendModal({ chain, address, balance, selectedToken, onClose }: SendModalProps) {
  const pubkey = useUserStore((s) => s.pubkey) || ''
  const authMethod = useUserStore((s) => s.authMethod)
  // Vault confirms + PINs inside its own iframe; desktop (seed/nsec) collects the PIN here.
  const backend = authMethod === 'vault' ? vaultBackend : rustBackend
  const [pin, setPin] = useState('')
  const [step, setStep] = useState<SendStep>('input')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gasEstimate, setGasEstimate] = useState<{ gasPrice: bigint; gasLimit: bigint } | null>(null)
  const [loadingGas, setLoadingGas] = useState(false)
  // Bitcoin fee rate state
  const [btcFeeRates, setBtcFeeRates] = useState<{ fast: number; medium: number; economy: number } | null>(null)
  const [btcFeeSpeed, setBtcFeeSpeed] = useState<'fast' | 'medium' | 'economy'>('medium')
  const [customFee, setCustomFee] = useState('') // custom sat/vB; overrides the speed presets when set
  const [loadingFees, setLoadingFees] = useState(false)
  const [loadingMax, setLoadingMax] = useState(false)
  // True when the amount was set via "Max" — the value is recomputed at send time
  // from the exact fee so the whole balance fits (no "insufficient funds" overshoot).
  const [isMaxSend, setIsMaxSend] = useState(false)
  const bitcoinAddressType = useWalletStore((s) => s.bitcoinAddressType)
  const addressMode = useWalletStore((s) => s.addressMode)
  // npub → address resolution
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null)
  const [isNpub, setIsNpub] = useState(false)
  // Contact picker
  const [showContactPicker, setShowContactPicker] = useState(false)
  // Bitcoin npub address type selector
  const [sendAddressType, setSendAddressType] = useState<'taproot' | 'segwit-even' | 'segwit-odd'>('taproot')
  const [showAddressTypes, setShowAddressTypes] = useState(false)
  const [allBtcAddresses, setAllBtcAddresses] = useState<{ taproot: string; segwitEven: string; segwitOdd: string } | null>(null)

  const isEvm = chain !== 'bitcoin'
  const decimals = CHAIN_DECIMALS[chain]
  const nativeSymbol = CHAIN_SYMBOLS[chain]

  // Get token info if sending a token
  const tokenInfo: TokenInfo | null = selectedToken && isEvm
    ? (CHAIN_TOKENS[chain as EvmChain] || []).find((t) => t.symbol === selectedToken) || null
    : null
  // Use on-chain decimals if cached (from balance fetch), fallback to hardcoded
  const sendDecimals = tokenInfo?.contractAddress
    ? getTokenDecimals(chain as EvmChain, tokenInfo.contractAddress, tokenInfo.decimals)
    : decimals
  const sendSymbol = tokenInfo ? tokenInfo.symbol : nativeSymbol

  // Token balance from store
  const tokenBalances = useWalletStore((s) => s.tokenBalances[chain])
  const tokenBalance = tokenInfo?.contractAddress
    ? tokenBalances?.[tokenInfo.contractAddress.toLowerCase()]?.balance || '0'
    : null
  const tokenBalanceFull = tokenInfo?.contractAddress
    ? tokenBalances?.[tokenInfo.contractAddress.toLowerCase()]?.balanceFull || null
    : null
  const displayBalance = tokenBalance || balance
  // Full precision for Max button (falls back to display if no full available)
  const walletBalance = useWalletStore((s) => s.balances[chain])
  const maxBalance = tokenBalanceFull || tokenBalance || walletBalance?.nativeFull || walletBalance?.native || balance

  // Resolve npub → chain-specific address
  useEffect(() => {
    const trimmed = recipient.trim()
    if (trimmed.startsWith('npub')) {
      try {
        const decoded = nip19.decode(trimmed)
        if (decoded.type === 'npub') {
          const pubkeyHex = decoded.data as string
          setIsNpub(true)
          if (isEvm) {
            setResolvedAddress(deriveEvmAddress(pubkeyHex))
            setAllBtcAddresses(null)
          } else {
            // Derive all 3 Bitcoin address types
            const taproot = deriveTaprootAddress(pubkeyHex)
            const segwitEven = deriveSegwitAddress(pubkeyHex)
            const segwitOdd = deriveSegwitOddAddress(pubkeyHex)
            setAllBtcAddresses({ taproot, segwitEven, segwitOdd })
            // Select based on current sendAddressType
            if (sendAddressType === 'taproot') setResolvedAddress(taproot)
            else if (sendAddressType === 'segwit-even') setResolvedAddress(segwitEven)
            else setResolvedAddress(segwitOdd)
          }
          return
        }
      } catch { /* invalid npub */ }
    }
    setIsNpub(false)
    setAllBtcAddresses(null)
    // For direct addresses, resolve as-is
    if (isEvm && isValidEvmAddress(trimmed)) {
      setResolvedAddress(trimmed)
    } else if (!isEvm && isValidBtcAddress(trimmed)) {
      setResolvedAddress(trimmed)
    } else {
      setResolvedAddress(null)
    }
  }, [recipient, chain, isEvm, bitcoinAddressType, sendAddressType])

  // Validate recipient
  const recipientValid = isNpub ? !!resolvedAddress : (isEvm ? isValidEvmAddress(recipient) : isValidBtcAddress(recipient))
  const recipientSelf = resolvedAddress ? resolvedAddress.toLowerCase() === address.toLowerCase() : recipient.toLowerCase() === address.toLowerCase()
  // The actual address to send to
  const sendToAddress = resolvedAddress || recipient

  // Parse amount
  const parsedAmount = parseAmount(amount, sendDecimals)
  const amountValid = parsedAmount > 0n

  // Estimate gas for EVM
  const estimateGas = useCallback(async () => {
    if (!isEvm || !recipientValid || !amountValid) return
    setLoadingGas(true)
    try {
      const { getGasPrice, estimateGas: estimate } = await import('@/lib/crypto/evm-net')
      const { encodeErc20Transfer } = await import('@/lib/crypto/evm-tx')
      const { bytesToHex } = await import('@noble/hashes/utils')
      const evmChain = chain as EvmChain
      const tx: { from: string; to: string; value?: string; data?: string } = {
        from: address,
        to: tokenInfo?.contractAddress || sendToAddress,
      }
      if (tokenInfo?.contractAddress) {
        // Include ERC-20 transfer calldata for accurate gas estimation
        const calldata = encodeErc20Transfer(sendToAddress, parsedAmount)
        tx.data = '0x' + bytesToHex(calldata)
      } else {
        tx.value = '0x' + parsedAmount.toString(16)
      }
      // Run gasPrice + estimateGas in parallel
      const [gasPrice, estimatedGas] = await Promise.all([
        getGasPrice(evmChain),
        estimate(evmChain, tx).then(g => g * 130n / 100n).catch(() => tokenInfo ? 100000n : 21000n),
      ])
      setGasEstimate({ gasPrice, gasLimit: estimatedGas })
    } catch (err) {
      console.error('Gas estimation failed:', err)
    } finally {
      setLoadingGas(false)
    }
  }, [chain, recipient, amount, isEvm, recipientValid, amountValid])

  useEffect(() => {
    if (isEvm && recipientValid && amountValid) {
      const timer = setTimeout(estimateGas, 500)
      return () => clearTimeout(timer)
    }
  }, [recipient, amount, estimateGas])

  // Fetch BTC fee rates on mount for Bitcoin
  useEffect(() => {
    if (chain !== 'bitcoin') return
    setLoadingFees(true)
    import('@/lib/crypto/btc-net').then(({ fetchFeeEstimates }) =>
      fetchFeeEstimates().then((rates) => {
        setBtcFeeRates({ fast: rates.fastestFee, medium: rates.halfHourFee, economy: rates.economyFee })
      })
    ).catch(() => {
      setBtcFeeRates({ fast: 10, medium: 5, economy: 2 }) // fallback
    }).finally(() => setLoadingFees(false))
  }, [chain])

  // A valid custom rate wins; otherwise use the selected speed preset.
  const customFeeNum = customFee.trim() ? Number(customFee) : NaN
  const btcFeeRate = !Number.isNaN(customFeeNum) && customFeeNum > 0
    ? customFeeNum
    : (btcFeeRates ? btcFeeRates[btcFeeSpeed] : 5)

  // Calculate total cost (amount + gas fee)
  const gasFee = gasEstimate ? gasEstimate.gasPrice * gasEstimate.gasLimit : 0n
  const gasFeeFormatted = gasFee > 0n ? formatAmount(gasFee, 18) : null

  // Can proceed to confirm (wait for gas/fee estimation to finish)
  const canConfirm = recipientValid && amountValid && !loadingGas && !loadingFees

  /**
   * Max = the largest amount that still leaves room for the network fee, so the
   * send actually goes through (the recipient receives balance − fee).
   *   - ERC-20 token: gas is paid in the native coin, so the whole token balance is sendable.
   *   - EVM native:   balance − gasPrice·21000 (+10% buffer for a gas-price bump before confirm).
   *   - Bitcoin:      UTXO total − fee, matching the signer's vbytes model exactly so change lands at 0.
   */
  // Bitcoin fee for a max send — matches the signer's vbytes model exactly (taproot vs segwit),
  // with a single recipient + change output, so change lands at 0.
  const btcFeeFor = (numInputs: number): bigint => {
    const vbytes = bitcoinAddressType === 'segwit'
      ? Math.ceil(numInputs * 68 + 2 * 31 + 10.5)
      : Math.ceil(numInputs * 57.5 + 2 * 43 + 10.5)
    return BigInt(Math.ceil(vbytes * btcFeeRate))
  }

  const handleMax = async () => {
    // ERC-20: gas is paid in the native coin, so the whole token balance is sendable (not fee-adjusted).
    if (tokenInfo) { setIsMaxSend(false); setAmount(maxBalance); return }
    const rawBal = walletBalance?.nativeRaw ?? 0n
    if (rawBal <= 0n) { setIsMaxSend(false); setAmount(maxBalance); return }
    setLoadingMax(true)
    setError(null)
    try {
      if (isEvm) {
        const { getGasPrice } = await import('@/lib/crypto/evm-net')
        const gasPrice = gasEstimate?.gasPrice ?? await getGasPrice(chain as EvmChain)
        const gasLimit = gasEstimate?.gasLimit ?? (21000n * 13n) / 10n // mirror estimateGas's ×1.3 buffer
        const fee = gasPrice * gasLimit
        const max = rawBal > fee ? rawBal - fee : 0n
        setAmount(formatAmount(max, decimals))
      } else {
        const { fetchUTXOs } = await import('@/lib/crypto/btc-net')
        const utxos = await fetchUTXOs(address)
        const total = utxos.reduce((s, u) => s + BigInt(u.value), 0n)
        const fee = btcFeeFor(utxos.length)
        const max = total > fee ? total - fee : 0n
        setAmount(formatAmount(max, 8))
      }
      setIsMaxSend(true) // recompute the exact value at send time (gas/UTXOs can shift)
    } catch {
      setIsMaxSend(false)
      setAmount(maxBalance) // fall back to the full balance on failure
    } finally {
      setLoadingMax(false)
    }
  }

  // ── Send Transaction ──
  const handleSend = async () => {
    if (backend.confirmsInApp && !pin) { setError('Enter your PIN to confirm'); return }
    setStep('sending')
    setError(null)
    try {
      if (isEvm) {
        const { encodeErc20Transfer } = await import('@/lib/crypto/evm-tx')
        const { getTransactionCount, getGasPrice, estimateGas, sendRawTransaction } = await import('@/lib/crypto/evm-net')
        const { bytesToHex } = await import('@noble/hashes/utils')
        const evmChain = chain as EvmChain

        let data: Uint8Array | undefined
        let to = sendToAddress
        let amountWei = parsedAmount
        if (tokenInfo?.contractAddress) {
          data = encodeErc20Transfer(sendToAddress, parsedAmount)
          to = tokenInfo.contractAddress
          amountWei = 0n
        }

        // Gather structured inputs (the vault is offline — it only signs).
        const nonce = await getTransactionCount(evmChain, address)
        const gasPrice = gasEstimate?.gasPrice ?? await getGasPrice(evmChain)
        const gasLimit = gasEstimate?.gasLimit ?? await estimateGas(evmChain, { from: address, to, value: '0x' + amountWei.toString(16), data: data ? '0x' + bytesToHex(data) : undefined })

        // Native max send: spend exactly balance − gas (using the gas this tx will actually
        // reserve), so value + gas can never exceed the balance.
        if (isMaxSend && !tokenInfo) {
          const rawBal = walletBalance?.nativeRaw ?? 0n
          const fee = gasPrice * gasLimit
          amountWei = rawBal > fee ? rawBal - fee : 0n
        }

        const tx: EvmSignTx = { to, value: amountWei.toString(), data, gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), nonce: nonce.toString(), addressMode }
        const { signed } = await backend.signTransaction(pubkey, evmChain, tx, pin || undefined)
        setTxHash(await sendRawTransaction(evmChain, signed))
      } else {
        const { fetchUTXOs, broadcastTransaction } = await import('@/lib/crypto/btc-net')
        const utxos = await fetchUTXOs(address)
        if (utxos.length === 0) throw new Error('No UTXOs available')
        // Max send: recompute against the UTXOs fetched now so the fee matches and change is 0.
        let amountSats = parsedAmount
        if (isMaxSend) {
          const total = utxos.reduce((s, u) => s + BigInt(u.value), 0n)
          const fee = btcFeeFor(utxos.length)
          amountSats = total > fee ? total - fee : 0n
        }
        const tx: BtcSignTx = { utxos, recipientAddress: sendToAddress, amountSats: amountSats.toString(), feeRate: btcFeeRate, addressType: bitcoinAddressType }
        const { signed } = await backend.signTransaction(pubkey, 'bitcoin', tx, pin || undefined)
        setTxHash(await broadcastTransaction(signed))
      }
      setStep('result')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transaction failed')
      setStep('result')
    }
  }

  // ── Render ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Send size={16} />
            Send {sendSymbol}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-secondary/50 transition-colors text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5">
          {/* ── Step 1: Input ── */}
          {step === 'input' && (
            <div className="space-y-4">
              {/* Recipient */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                    Recipient
                  </label>
                  <button
                    onClick={() => setShowContactPicker(true)}
                    className="flex items-center gap-1 text-[11px] text-primary hover:underline cursor-pointer"
                  >
                    <Users size={12} />
                    Follows
                  </button>
                </div>
                <input
                  type="text"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.trim())}
                  placeholder={isEvm ? '0x... or npub...' : 'bc1... or npub...'}
                  className={cn(
                    'w-full px-3 py-2.5 rounded-xl bg-secondary/40 border text-sm font-mono text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors',
                    recipient && !recipientValid && !isNpub
                      ? 'border-red-500/50 focus:border-red-500'
                      : 'border-border/50 focus:border-primary/50'
                  )}
                />
                {/* Resolved address from npub */}
                {isNpub && resolvedAddress && (
                  <div className="mt-1.5">
                    {/* Selected address + toggle button */}
                    <button
                      onClick={() => !isEvm && allBtcAddresses && setShowAddressTypes(!showAddressTypes)}
                      className={cn(
                        'w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/5 border border-primary/20 text-left transition-colors',
                        !isEvm && allBtcAddresses ? 'hover:bg-primary/10 cursor-pointer' : ''
                      )}
                    >
                      <ArrowRight size={10} className="text-primary shrink-0" />
                      <code className="text-[10px] text-primary font-mono truncate flex-1">{resolvedAddress}</code>
                      {!isEvm && allBtcAddresses && (
                        <ChevronDown size={12} className={cn('text-primary/60 shrink-0 transition-transform', showAddressTypes && 'rotate-180')} />
                      )}
                    </button>

                    {/* Address type accordion */}
                    {showAddressTypes && allBtcAddresses && (
                      <div className="mt-1 rounded-lg border border-border/50 bg-secondary/20 overflow-hidden">
                        {([
                          { key: 'taproot' as const, label: 'Taproot', sublabel: 'bc1p…', addr: allBtcAddresses.taproot },
                          { key: 'segwit-even' as const, label: 'SegWit', sublabel: 'Even type · bc1q…', addr: allBtcAddresses.segwitEven },
                          { key: 'segwit-odd' as const, label: 'SegWit', sublabel: 'Odd type · bc1q…', addr: allBtcAddresses.segwitOdd },
                        ]).map((opt, i) => (
                          <button
                            key={opt.key}
                            onClick={() => { setSendAddressType(opt.key); setShowAddressTypes(false) }}
                            className={cn(
                              'w-full flex items-start gap-2 px-3 py-2 text-left transition-colors cursor-pointer',
                              i > 0 && 'border-t border-border/30',
                              sendAddressType === opt.key
                                ? 'bg-primary/10'
                                : 'hover:bg-secondary/40'
                            )}
                          >
                            <div className={cn(
                              'w-3.5 h-3.5 rounded-full border-2 shrink-0 mt-0.5 flex items-center justify-center',
                              sendAddressType === opt.key
                                ? 'border-primary'
                                : 'border-muted-foreground/40'
                            )}>
                              {sendAddressType === opt.key && (
                                <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium text-foreground">{opt.label}</span>
                                <span className="text-[10px] text-muted-foreground">{opt.sublabel}</span>
                              </div>
                              <code className="text-[9px] text-muted-foreground font-mono break-all leading-relaxed">{opt.addr}</code>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {recipient && recipientSelf && (
                  <p className="text-[11px] text-amber-500 mt-1">Warning: you are sending to your own address</p>
                )}
                {recipient && !recipientValid && !recipientSelf && !recipient.startsWith('npub') && (
                  <p className="text-[11px] text-red-500 mt-1">Invalid address format</p>
                )}
                {recipient && recipient.startsWith('npub') && !resolvedAddress && (
                  <p className="text-[11px] text-red-500 mt-1">Invalid npub</p>
                )}
              </div>

              {/* Amount */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
                    Amount
                  </label>
                  <button
                    onClick={handleMax}
                    disabled={loadingMax}
                    className="text-[11px] text-primary hover:underline cursor-pointer disabled:opacity-50"
                  >
                    {loadingMax ? 'Calculating…' : `Max ${displayBalance} ${sendSymbol}`}
                  </button>
                </div>
                <div className="relative">
                  <input
                    type="text"
                    value={amount}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.]/g, '')
                      if (v.split('.').length <= 2) { setAmount(v); setIsMaxSend(false) }
                    }}
                    placeholder="0.0"
                    className="w-full px-3 py-2.5 pr-16 rounded-xl bg-secondary/40 border border-border/50 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/50 transition-colors"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">
                    {sendSymbol}
                  </span>
                </div>
              </div>

              {/* Gas estimate (EVM only) */}
              {isEvm && recipientValid && amountValid && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary/30 border border-border/30">
                  <Fuel size={13} className="text-muted-foreground shrink-0" />
                  {loadingGas ? (
                    <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin" />
                      Estimating gas...
                    </span>
                  ) : gasFeeFormatted ? (
                    <span className="text-xs text-muted-foreground">
                      Est. fee: <span className="text-foreground font-medium">{gasFeeFormatted} {nativeSymbol}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Gas estimation unavailable</span>
                  )}
                </div>
              )}

              {/* Bitcoin fee rate selector */}
              {!isEvm && (
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1.5 block">
                    Fee Rate (sat/vB)
                  </label>
                  {loadingFees ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 size={11} className="animate-spin" />
                      Loading fee rates...
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      {(['fast', 'medium', 'economy'] as const).map((speed) => {
                        const rate = btcFeeRates?.[speed] || 0
                        const Icon = speed === 'fast' ? Zap : speed === 'medium' ? Clock : Wallet
                        const label = speed === 'fast' ? 'Fast' : speed === 'medium' ? 'Medium' : 'Economy'
                        return (
                          <button
                            key={speed}
                            onClick={() => { setBtcFeeSpeed(speed); setCustomFee('') }}
                            className={cn(
                              'flex-1 px-2 py-2 rounded-xl border text-center transition-all cursor-pointer',
                              btcFeeSpeed === speed && !customFee.trim()
                                ? 'border-primary/40 bg-primary/5 text-foreground'
                                : 'border-border/40 bg-secondary/20 text-muted-foreground hover:border-border'
                            )}
                          >
                            <p className="text-[10px] leading-tight flex items-center justify-center gap-1"><Icon size={10} /> {label}</p>
                            <p className="text-xs font-semibold mt-0.5">{rate}</p>
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {/* Custom fee rate — typing here deselects the presets above */}
                  <input
                    type="text"
                    inputMode="decimal"
                    value={customFee}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.]/g, '')
                      if (v.split('.').length <= 2) setCustomFee(v)
                    }}
                    placeholder="Custom (sat/vB)"
                    className={cn(
                      'w-full mt-2 px-3 py-2 rounded-xl bg-secondary/40 border text-sm font-mono text-foreground placeholder:text-muted-foreground/50 outline-none transition-colors',
                      customFee.trim() ? 'border-primary/40' : 'border-border/50 focus:border-primary/50'
                    )}
                  />
                </div>
              )}

              {/* Confirm button */}
              <Button
                variant="default"
                className="w-full h-11 rounded-xl gap-2"
                disabled={!canConfirm}
                onClick={() => setStep('confirm')}
              >
                Review Transaction
                <ArrowRight size={15} />
              </Button>
            </div>
          )}

          {/* ── Step 2: Confirm ── */}
          {step === 'confirm' && (
            <div className="space-y-4">
              <div className="rounded-xl bg-secondary/30 border border-border/40 p-4 space-y-3">
                <div className="flex justify-between items-start">
                  <span className="text-xs text-muted-foreground">To</span>
                  <div className="text-right max-w-[250px]">
                    {isNpub ? (
                      <>
                        <span className="text-xs font-mono text-foreground break-all">
                          {truncateAddr(recipient)}
                        </span>
                        <p className="text-[10px] font-mono text-primary mt-0.5 break-all">
                          → {resolvedAddress}
                        </p>
                      </>
                    ) : (
                      <span className="text-xs font-mono text-foreground break-all">
                        {recipient}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-xs text-muted-foreground">Amount</span>
                  <span className="text-sm font-semibold text-foreground">
                    {amount} {sendSymbol}
                  </span>
                </div>
                {isEvm && gasFeeFormatted && (
                  <div className="flex justify-between items-center border-t border-border/30 pt-3">
                    <span className="text-xs text-muted-foreground">Network Fee</span>
                    <span className="text-xs text-foreground">
                      ~{gasFeeFormatted} {nativeSymbol}
                    </span>
                  </div>
                )}
                {!isEvm && (
                  <div className="flex justify-between items-center border-t border-border/30 pt-3">
                    <span className="text-xs text-muted-foreground">Fee Rate</span>
                    <span className="text-xs text-foreground">
                      {btcFeeRate} sat/vB
                    </span>
                  </div>
                )}
                <div className="flex justify-between items-center border-t border-border/30 pt-3">
                  <span className="text-xs text-muted-foreground font-medium">From</span>
                  <span className="text-xs font-mono text-muted-foreground">
                    {truncateAddr(address)}
                  </span>
                </div>
              </div>

              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/20">
                <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-500/90 leading-relaxed">
                  Please verify all details carefully. Transactions cannot be reversed once confirmed.
                </p>
              </div>

              {backend.confirmsInApp ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Enter your PIN to authorize this transaction.</p>
                  <PinInput value={pin} onChange={(v) => { setPin(v); setError(null) }} placeholder="PIN" onEnter={handleSend} />
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground text-center">You'll confirm and enter your PIN in the secure vault.</p>
              )}
              {error && <p className="text-xs text-destructive text-center">{error}</p>}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1 h-11 rounded-xl"
                  onClick={() => setStep('input')}
                >
                  Back
                </Button>
                <Button
                  variant="default"
                  className="flex-1 h-11 rounded-xl gap-2"
                  onClick={handleSend}
                >
                  <Send size={14} />
                  Confirm & Send
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 3: Sending ── */}
          {step === 'sending' && (
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Loader2 size={28} className="animate-spin text-primary" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">Sending Transaction</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Signing and broadcasting...
                </p>
              </div>
            </div>
          )}

          {/* ── Step 4: Result ── */}
          {step === 'result' && (
            <div className="flex flex-col items-center justify-center py-6 gap-4">
              {txHash ? (
                <>
                  <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
                    <CheckCircle size={28} className="text-green-500" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-foreground">Transaction Sent!</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {amount} {sendSymbol} sent to {truncateAddr(recipient)}
                    </p>
                  </div>
                  <div className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border/30">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Transaction Hash</p>
                    <p className="text-xs font-mono text-foreground break-all">{txHash}</p>
                  </div>
                  <a
                    href={`${EXPLORER_TX[chain]}${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    View on Explorer
                    <ExternalLink size={12} />
                  </a>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center">
                    <XCircle size={28} className="text-red-500" />
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-foreground">Transaction Failed</p>
                    <p className="text-xs text-red-400 mt-1 max-w-xs">{error}</p>
                  </div>
                </>
              )}
              <Button
                variant="outline"
                className="w-full h-10 rounded-xl mt-2"
                onClick={onClose}
              >
                Close
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Contact Picker Modal */}
      {showContactPicker && (
        <ContactPickerModal
          onSelect={(npub) => {
            setRecipient(npub)
            setShowContactPicker(false)
          }}
          onClose={() => setShowContactPicker(false)}
        />
      )}
    </div>
  )
}
