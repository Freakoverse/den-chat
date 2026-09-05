/**
 * DonateModal — Deterministic donation address generator
 *
 * Two-step modal: select currency/chain → view deterministic address + QR code.
 * Derives addresses directly from the admin's Nostr pubkey (no tweak, no notification).
 */

import { useState, useCallback, useMemo } from 'react'
import { useEscToClose } from '@/hooks/useEscToClose'
import { QRCodeSVG } from 'qrcode.react'
import { X, Copy, Check, Heart, ChevronLeft } from 'lucide-react'
import { ADMIN_PUBKEY } from '@/lib/constants'
import {
  deriveTaprootAddress,
  deriveEvmAddress,
  buildPaymentURI,
  type Chain,
} from '@/lib/crypto/derive'

// ── Token contract addresses ──

const TOKEN_CONTRACTS: Record<string, Record<string, string>> = {
  USDT: {
    ethereum: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    bnb: '0x55d398326f99059fF775485246999027B3197955',
    polygon: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    avalanche: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
  },
  USDC: {
    ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    bnb: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  PYUSD: {
    ethereum: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
  },
}

// ── Currency icon imports ──

import iconPyusd from '@/assets/icons/blockchain/token/pyusd128.png'
import iconUsdt from '@/assets/icons/blockchain/token/usdt128.png'
import iconUsdc from '@/assets/icons/blockchain/token/usdc128.png'
import iconBitcoin from '@/assets/icons/blockchain/native/bitcoin128.png'
import iconEthereum from '@/assets/icons/blockchain/native/ethereum128.png'

// ── Currency definitions ──

interface CurrencyDef {
  id: string
  label: string
  fallbackIcon: string
  iconImg: string
  color: string
  chains: { id: Chain; label: string }[]
  isBitcoin?: boolean
  isNativeEth?: boolean
}

const CURRENCIES: CurrencyDef[] = [
  {
    id: 'PYUSD',
    label: 'PayPal (PYUSD)',
    fallbackIcon: 'P',
    iconImg: iconPyusd,
    color: '#0070BA',
    chains: [{ id: 'ethereum', label: 'Ethereum' }],
  },
  {
    id: 'USDT',
    label: 'USDT',
    fallbackIcon: '₮',
    iconImg: iconUsdt,
    color: '#26A17B',
    chains: [
      { id: 'ethereum', label: 'Ethereum' },
      { id: 'bnb', label: 'BNB Chain' },
      { id: 'polygon', label: 'Polygon' },
      { id: 'avalanche', label: 'Avalanche' },
    ],
  },
  {
    id: 'USDC',
    label: 'USDC',
    fallbackIcon: '$',
    iconImg: iconUsdc,
    color: '#2775CA',
    chains: [
      { id: 'ethereum', label: 'Ethereum' },
      { id: 'bnb', label: 'BNB Chain' },
      { id: 'polygon', label: 'Polygon' },
      { id: 'avalanche', label: 'Avalanche' },
      { id: 'base', label: 'Base' },
    ],
  },
  {
    id: 'bitcoin',
    label: 'Bitcoin',
    fallbackIcon: '₿',
    iconImg: iconBitcoin,
    color: '#F7931A',
    chains: [{ id: 'bitcoin', label: 'Bitcoin' }],
    isBitcoin: true,
  },
  {
    id: 'ethereum',
    label: 'Ethereum',
    fallbackIcon: 'Ξ',
    iconImg: iconEthereum,
    color: '#627EEA',
    chains: [{ id: 'ethereum', label: 'Ethereum' }],
    isNativeEth: true,
  },
]

// ── Currency icon with fallback ──

function CurrencyIcon({ src, fallback, color }: { src: string; fallback: string; color: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <span
        className="w-9 h-9 rounded-full flex items-center justify-center text-lg font-bold text-white shrink-0"
        style={{ backgroundColor: color }}
      >
        {fallback}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      className="w-9 h-9 rounded-full shrink-0 object-cover"
      onError={() => setFailed(true)}
    />
  )
}

// ── Chain display names ──
const CHAIN_LABELS: Record<string, string> = {
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum',
  bnb: 'BNB Chain',
  polygon: 'Polygon',
  avalanche: 'Avalanche',
  base: 'Base',
}

interface DonateModalProps {
  open: boolean
  onClose: () => void
}

export function DonateModal({ open, onClose }: DonateModalProps) {
  // ── State ──
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null)
  const [selectedChain, setSelectedChain] = useState<Chain | null>(null)
  const [generatedAddress, setGeneratedAddress] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const currency = useMemo(
    () => CURRENCIES.find((c) => c.id === selectedCurrency),
    [selectedCurrency],
  )

  const needsChainSelector = currency && !currency.isBitcoin && !currency.isNativeEth
  const effectiveChain: Chain | null = currency?.isBitcoin
    ? 'bitcoin'
    : currency?.isNativeEth
      ? 'ethereum'
      : selectedChain || (currency?.chains.length === 1 ? currency.chains[0].id : null)

  const canGenerate = !!currency && !!effectiveChain

  // ── Derived step ──
  const step: 1 | 2 = generatedAddress ? 2 : 1
  const STEP_LABELS = ['Select', 'Pay']

  // ── Handlers ──

  const handleSelectCurrency = useCallback((id: string) => {
    const c = CURRENCIES.find((cur) => cur.id === id)
    setSelectedCurrency(id)
    if (c && c.chains.length === 1) {
      setSelectedChain(c.chains[0].id)
    } else {
      setSelectedChain('ethereum')
    }
    // Reset if previously generated
    if (generatedAddress) {
      setGeneratedAddress('')
      setError(null)
    }
  }, [generatedAddress])

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !effectiveChain) return
    try {
      let address: string
      if (effectiveChain === 'bitcoin') {
        address = deriveTaprootAddress(ADMIN_PUBKEY)
      } else {
        address = deriveEvmAddress(ADMIN_PUBKEY)
      }
      setGeneratedAddress(address)
      setError(null)
    } catch (err: any) {
      console.error('[Donate] Address derivation failed:', err)
      setError(err?.message || 'Address derivation failed')
    }
  }, [canGenerate, effectiveChain])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(generatedAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [generatedAddress])

  const handleBack = useCallback(() => {
    setGeneratedAddress('')
    setError(null)
  }, [])

  const resetAndClose = useCallback(() => {
    setSelectedCurrency(null)
    setSelectedChain(null)
    setGeneratedAddress('')
    setError(null)
    setCopied(false)
    onClose()
  }, [onClose])

  useEscToClose(resetAndClose, open)

  // ── QR value ──
  const qrValue = useMemo(() => {
    if (!generatedAddress || !effectiveChain) return ''
    const token = currency && !currency.isBitcoin && !currency.isNativeEth
      ? TOKEN_CONTRACTS[currency.id]?.[effectiveChain] || null
      : null
    return buildPaymentURI(effectiveChain, generatedAddress, token)
  }, [generatedAddress, effectiveChain, currency])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={resetAndClose} />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="relative w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 z-10 flex flex-col border-b border-border bg-background/95 backdrop-blur-sm rounded-t-2xl">
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-2.5">
                {step === 2 && (
                  <button onClick={handleBack} className="p-1 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
                    <ChevronLeft size={18} />
                  </button>
                )}
                <Heart size={18} className="text-rose-400" />
                <h2 className="text-lg font-semibold text-foreground">Donate</h2>
              </div>
              <button
                onClick={resetAndClose}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            {/* Progress bar */}
            <div className="flex items-center gap-1.5 px-5 pb-3">
              {STEP_LABELS.map((label, i) => {
                const stepNum = i + 1
                const isActive = step === stepNum
                const isDone = step > stepNum
                return (
                  <div key={label} className="flex-1 flex flex-col gap-1">
                    <div className={`h-1 rounded-full transition-all duration-300 ${
                      isDone ? 'bg-primary' : isActive ? 'bg-primary' : 'bg-muted-foreground/20'
                    }`} />
                    <span className={`text-[10px] text-center font-medium transition-colors ${
                      isDone || isActive ? 'text-primary' : 'text-muted-foreground/50'
                    }`}>{label}</span>
                  </div>
                )
              })}
            </div>
          </div>

          <div className="p-5 space-y-5">

            {/* ═══════════ STEP 1 — Select Currency & Chain ═══════════ */}
            {step === 1 && (
              <>
                {/* Currency Grid */}
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2.5 font-medium">Select Currency</p>
                  <div className="grid grid-cols-3 max-[480px]:grid-cols-2 gap-2">
                    {CURRENCIES.map((c) => {
                      const isSelected = selectedCurrency === c.id
                      return (
                        <button
                          key={c.id}
                          onClick={() => handleSelectCurrency(c.id)}
                          className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all cursor-pointer ${isSelected
                            ? 'border-primary bg-primary/10 shadow-sm'
                            : 'border-border/50 bg-secondary/20 hover:bg-secondary/40 hover:border-border'}`}
                        >
                          <CurrencyIcon src={c.iconImg} fallback={c.fallbackIcon} color={c.color} />
                          <span className={`text-xs font-medium ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {c.label}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {/* Chain Selector */}
                {needsChainSelector && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-medium">Select Network</p>
                    <div className="flex flex-wrap gap-1.5">
                      {currency.chains.map((ch) => {
                        const isSelected = selectedChain === ch.id
                        return (
                          <button
                            key={ch.id}
                            onClick={() => setSelectedChain(ch.id)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${isSelected
                              ? 'bg-primary/20 text-primary border border-primary/30'
                              : 'bg-secondary/30 text-muted-foreground border border-border/50 hover:bg-secondary/50 hover:text-foreground'}`}
                          >
                            {ch.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {error && <p className="text-xs text-destructive text-center">{error}</p>}

                {/* Generate button */}
                <button
                  onClick={handleGenerate}
                  disabled={!canGenerate}
                  className={`w-full py-3 rounded-xl text-sm font-semibold transition-all cursor-pointer ${canGenerate
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-md'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'}`}
                >
                  Generate Donation Address
                </button>
              </>
            )}

            {/* ═══════════ STEP 2 — QR + Address ═══════════ */}
            {step === 2 && generatedAddress && (
              <>
                {/* Selected currency pill */}
                <div className="flex items-center justify-center gap-2 py-1">
                  <CurrencyIcon src={currency!.iconImg} fallback={currency!.fallbackIcon} color={currency!.color} />
                  <span className="text-sm font-medium text-foreground">{currency!.label}</span>
                  {effectiveChain && effectiveChain !== 'bitcoin' && (
                    <span className="text-xs text-muted-foreground">on {CHAIN_LABELS[effectiveChain]}</span>
                  )}
                </div>

                {/* QR Code */}
                <div className="flex justify-center">
                  <div className="p-4 bg-white rounded-xl shadow-inner">
                    <QRCodeSVG value={qrValue} size={220} level="M" />
                  </div>
                </div>

                {/* Address */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground font-medium">
                      {effectiveChain === 'bitcoin' ? 'Taproot Address' : `${CHAIN_LABELS[effectiveChain || ''] || ''} Address`}
                    </span>
                    <button onClick={handleCopy} className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors cursor-pointer">
                      {copied ? <Check size={12} /> : <Copy size={12} />}
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                  <div className="w-full px-3 py-2.5 rounded-lg bg-secondary/40 border border-border text-xs font-mono text-foreground break-all select-all cursor-text" onClick={handleCopy}>
                    {generatedAddress}
                  </div>
                </div>

                {/* Thank you message */}
                <div className="flex flex-col items-center gap-2 pt-2">
                  <p className="text-sm text-muted-foreground text-center leading-relaxed">
                    Send any amount to the address above. Thank you for your support! 💜
                  </p>
                </div>

                {/* Done button */}
                <button
                  onClick={resetAndClose}
                  className="w-full py-3 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all cursor-pointer shadow-md"
                >
                  Done
                </button>
              </>
            )}

          </div>
        </div>
      </div>
    </>
  )
}
