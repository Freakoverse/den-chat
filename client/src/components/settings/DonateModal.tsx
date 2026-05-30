/**
 * DonateModal — NSP-based donation system
 *
 * Multi-step modal for generating tweaked donation addresses and sending
 * encrypted kind 1604 notifications to the admin. Follows NIP-NSP spec.
 */

import { useState, useCallback, useMemo } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { nip19 } from 'nostr-tools'
import {
  X, Copy, Check, AlertTriangle, Heart, Loader2, ThumbsUp, ThumbsDown, ChevronLeft,
} from 'lucide-react'
import { useUserStore } from '@/stores/userStore'
import { ADMIN_PUBKEY } from '@/lib/constants'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import {
  generateTweak,
  deriveTaprootAddress,
  deriveEvmAddress,
  buildPaymentURI,
  createNspNotification,
  fetchNip65Relays,
  nip44EncryptSelf,
  nip44DecryptSelf,
  KIND_NSP_SENT_LIST,
  NSP_SENT_DTAG,
  type NspChain,
  type NspPayload,
  type NspSentEntry,
} from '@/lib/crypto/nsp'
import { finalizeEvent } from 'nostr-tools'
import { hexToBytes } from '@noble/hashes/utils'

// ── Token contract addresses (from DENOS evm.ts) ──

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

// ── Currency icon imports (from DENOS) ──

import iconPyusd from '../../../../../DNN/signers/DENOS/src/assets/icons/blockchain/token/pyusd128.png'
import iconUsdt from '../../../../../DNN/signers/DENOS/src/assets/icons/blockchain/token/usdt128.png'
import iconUsdc from '../../../../../DNN/signers/DENOS/src/assets/icons/blockchain/token/usdc128.png'
import iconBitcoin from '../../../../../DNN/signers/DENOS/src/assets/icons/blockchain/native/bitcoin128.png'
import iconEthereum from '../../../../../DNN/signers/DENOS/src/assets/icons/blockchain/native/ethereum128.png'

// ── Currency definitions ──

interface CurrencyDef {
  id: string
  label: string
  fallbackIcon: string
  iconImg: string
  color: string
  chains: { id: NspChain; label: string }[]
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

type ModalState = 'idle' | 'generated' | 'notifying' | 'notified'

interface DonateModalProps {
  open: boolean
  onClose: () => void
}

export function DonateModal({ open, onClose }: DonateModalProps) {
  // ── State ──
  const [state, setState] = useState<ModalState>('idle')
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null)
  const [selectedChain, setSelectedChain] = useState<NspChain | null>(null)
  const [generatedAddress, setGeneratedAddress] = useState('')
  const [generatedTweak, setGeneratedTweak] = useState('')
  const [includeIdentity, setIncludeIdentity] = useState(true)
  const [copied, setCopied] = useState(false)
  const [showCloseGuard, setShowCloseGuard] = useState(false)
  const [showRegenGuard, setShowRegenGuard] = useState(false)
  const [notifyError, setNotifyError] = useState<string | null>(null)
  const [relayResults, setRelayResults] = useState<{ total: number; success: number } | null>(null)
  const [ephemeralSkHex, setEphemeralSkHex] = useState('')

  const pubkey = useUserStore((s) => s.pubkey)
  const privateKey = useUserStore((s) => s.privateKey)

  const currency = useMemo(
    () => CURRENCIES.find((c) => c.id === selectedCurrency),
    [selectedCurrency],
  )

  const needsChainSelector = currency && !currency.isBitcoin && !currency.isNativeEth
  const effectiveChain: NspChain | null = currency?.isBitcoin
    ? 'bitcoin'
    : currency?.isNativeEth
      ? 'ethereum'
      : selectedChain || (currency?.chains.length === 1 ? currency.chains[0].id : null)

  const canGenerate = !!currency && !!effectiveChain

  // ── Handlers ──

  const handleSelectCurrency = useCallback((id: string) => {
    const c = CURRENCIES.find((cur) => cur.id === id)
    setSelectedCurrency(id)
    // Auto-select chain if only 1 option
    if (c && c.chains.length === 1) {
      setSelectedChain(c.chains[0].id)
    } else {
      // Default to ethereum for multi-chain tokens
      setSelectedChain('ethereum')
    }
    // Reset generation if previously generated
    if (state !== 'idle') {
      setState('idle')
      setGeneratedAddress('')
      setGeneratedTweak('')
      setNotifyError(null)
      setRelayResults(null)
    }
  }, [state])

  const handleGenerate = useCallback(() => {
    if (!canGenerate || !effectiveChain) return
    try {
      const tweak = generateTweak()
      let address: string
      if (effectiveChain === 'bitcoin') {
        address = deriveTaprootAddress(ADMIN_PUBKEY, tweak)
      } else {
        address = deriveEvmAddress(ADMIN_PUBKEY, tweak)
      }
      setGeneratedAddress(address)
      setGeneratedTweak(tweak)
      setState('generated')
      setNotifyError(null)
      setRelayResults(null)
    } catch (err: any) {
      console.error('[Donate] Address generation failed:', err)
      setNotifyError(err?.message || 'Address generation failed')
    }
  }, [canGenerate, effectiveChain])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(generatedAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [generatedAddress])

  const handleNotify = useCallback(async () => {
    if (!currency || !effectiveChain || !generatedAddress || !generatedTweak) return

    setState('notifying')
    setNotifyError(null)

    try {
      // Determine asset and token contract
      let asset: string
      let token: string | null = null
      if (currency.isBitcoin) {
        asset = 'taproot'
      } else if (currency.isNativeEth) {
        asset = 'native'
      } else {
        asset = currency.id // USDT, USDC, PYUSD
        token = TOKEN_CONTRACTS[currency.id]?.[effectiveChain] || null
      }

      // Build payload
      const payload: NspPayload = {
        address: generatedAddress,
        chain: effectiveChain,
        asset,
        token,
        tweak: generatedTweak,
        txid: '',
        amount: '',
        timestamp: Math.floor(Date.now() / 1000),
      }

      // Include identity if toggled on
      if (includeIdentity && pubkey) {
        payload.senderNpub = nip19.npubEncode(pubkey)
      }

      // Create the kind 1604 notification
      const { event, ephemeralSkHex: skHex } = createNspNotification(ADMIN_PUBKEY, payload)
      setEphemeralSkHex(skHex)

      // Gather relays: admin NIP-65 + user NIP-65 + client relays
      const [adminRelays, userRelays] = await Promise.all([
        fetchNip65Relays(ADMIN_PUBKEY),
        pubkey ? fetchNip65Relays(pubkey) : Promise.resolve([]),
      ])

      const clientRelays = getPublishRelays().slice(0, 3)
      const allRelays = [...new Set([...adminRelays, ...userRelays, ...clientRelays])]

      if (allRelays.length === 0) {
        // Fallback to hardcoded
        allRelays.push('wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band')
      }

      // Publish
      const successRelays = await publishToSpecificRelays(allRelays, event as any)

      setRelayResults({ total: allRelays.length, success: successRelays.length })

      // Save to NIP-78 sent list if user has a private key
      if (privateKey && pubkey) {
        try {
          await saveSentEntry(privateKey, pubkey, {
            txid: '',
            chain: effectiveChain,
            asset,
            token,
            amount: '',
            address: generatedAddress,
            tweak: generatedTweak,
            recipientPubkey: ADMIN_PUBKEY,
            senderNsec: skHex,
            timestamp: Math.floor(Date.now() / 1000),
          })
        } catch (err) {
          console.warn('[Donate] Failed to save sent entry:', err)
        }
      }

      setState('notified')
    } catch (err: any) {
      console.error('[Donate] Notification failed:', err)
      setNotifyError(err?.message || 'Failed to send notification')
      setState('generated')
    }
  }, [currency, effectiveChain, generatedAddress, generatedTweak, includeIdentity, pubkey, privateKey])

  const handleAttemptClose = useCallback(() => {
    if (state === 'generated' || state === 'notifying') {
      setShowCloseGuard(true)
    } else {
      resetAndClose()
    }
  }, [state])

  const resetAndClose = useCallback(() => {
    setState('idle')
    setSelectedCurrency(null)
    setSelectedChain(null)
    setGeneratedAddress('')
    setGeneratedTweak('')
    setNotifyError(null)
    setRelayResults(null)
    setShowCloseGuard(false)
    setShowRegenGuard(false)
    setCopied(false)
    setEphemeralSkHex('')
    onClose()
  }, [onClose])

  // ── QR value ──
  const qrValue = useMemo(() => {
    if (!generatedAddress || !effectiveChain) return ''
    if (effectiveChain === 'bitcoin') return `bitcoin:${generatedAddress}`
    const token = currency && !currency.isBitcoin && !currency.isNativeEth
      ? TOKEN_CONTRACTS[currency.id]?.[effectiveChain] || null
      : null
    return buildPaymentURI(effectiveChain, generatedAddress, token)
  }, [generatedAddress, effectiveChain, currency])

  // ── Step derivation ──
  const step: 1 | 2 | 3 = state === 'notified' ? 3 : state === 'notifying' ? 3 : (state === 'generated') ? 2 : 1
  const STEP_LABELS = ['Select', 'Pay', 'Confirm']

  const handleBack = useCallback(() => {
    if (step === 2) {
      setShowRegenGuard(true)
    }
  }, [step])

  if (!open) return null

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={handleAttemptClose} />

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
                {step > 1 && step < 3 && (
                  <button onClick={handleBack} className="p-1 -ml-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors cursor-pointer">
                    <ChevronLeft size={18} />
                  </button>
                )}
                <Heart size={18} className="text-rose-400" />
                <h2 className="text-lg font-semibold text-foreground">Donate</h2>
              </div>
              <button
                onClick={handleAttemptClose}
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

                {notifyError && <p className="text-xs text-destructive text-center">{notifyError}</p>}

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

            {/* ═══════════ STEP 2 — QR + Address + Notify ═══════════ */}
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

                {/* Warning */}
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-300/90 leading-relaxed">
                    Did you send the payment? Notify us, otherwise the money is lost forever!
                  </p>
                </div>

                {/* Identity toggle */}
                <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-secondary/20 border border-border/30">
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
                    <span className="text-sm text-foreground">Include your identity?</span>
                    <span className="text-[11px] text-muted-foreground leading-tight">
                      {includeIdentity ? 'Your npub will be included in the encrypted notification' : 'The donation will be fully anonymous'}
                    </span>
                  </div>
                  <div className="shrink-0 flex items-center h-8 rounded-lg border border-border/40 bg-secondary/20 overflow-hidden">
                    <button onClick={() => setIncludeIdentity(true)} className={`h-full px-2.5 flex items-center gap-1 text-xs font-medium transition-all cursor-pointer border-r border-border/30 ${includeIdentity ? 'bg-emerald-500/20 text-emerald-400' : 'text-muted-foreground/40 hover:text-muted-foreground/70'}`}>
                      <ThumbsUp size={12} />
                    </button>
                    <button onClick={() => setIncludeIdentity(false)} className={`h-full px-2.5 flex items-center gap-1 text-xs font-medium transition-all cursor-pointer ${!includeIdentity ? 'bg-red-500/20 text-red-400' : 'text-muted-foreground/40 hover:text-muted-foreground/70'}`}>
                      <ThumbsDown size={12} />
                    </button>
                  </div>
                </div>

                {/* Notify button */}
                <button
                  onClick={handleNotify}
                  className="w-full py-3 rounded-xl text-sm font-semibold bg-emerald-600 hover:bg-emerald-500 text-white transition-all cursor-pointer shadow-md flex items-center justify-center gap-2"
                >
                  Send Payment Notification
                </button>
              </>
            )}

            {/* ═══════════ STEP 3 — Progress / Success ═══════════ */}
            {step === 3 && (
              <>
                {state === 'notifying' && (
                  <div className="flex flex-col items-center gap-4 py-8">
                    <Loader2 size={40} className="text-primary animate-spin" />
                    <p className="text-sm font-medium text-foreground">Sending notification...</p>
                    <p className="text-xs text-muted-foreground text-center max-w-xs">
                      Encrypting payment details and publishing to Nostr relays. This may take a few seconds.
                    </p>
                  </div>
                )}

                {state === 'notified' && (
                  <div className="flex flex-col items-center gap-3 py-6">
                    <div className="w-14 h-14 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <Check size={28} className="text-emerald-400" />
                    </div>
                    <p className="text-base font-semibold text-emerald-400">Notification Sent!</p>
                    {relayResults && (
                      <p className="text-xs text-muted-foreground">
                        Published to {relayResults.success}/{relayResults.total} relays
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground text-center max-w-xs mt-1">
                      Thank you for your donation. The payment details have been securely encrypted and delivered.
                    </p>
                    <button
                      onClick={resetAndClose}
                      className="mt-4 px-6 py-2.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                    >
                      Done
                    </button>
                  </div>
                )}

                {notifyError && (
                  <div className="flex flex-col items-center gap-3 py-6">
                    <AlertTriangle size={32} className="text-destructive" />
                    <p className="text-sm font-medium text-destructive">Notification Failed</p>
                    <p className="text-xs text-muted-foreground text-center">{notifyError}</p>
                    <button
                      onClick={handleNotify}
                      className="mt-2 px-6 py-2.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                    >
                      Retry
                    </button>
                  </div>
                )}
              </>
            )}

          </div>
        </div>
      </div>

      {/* ── Close Guard Modal ── */}
      {showCloseGuard && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/50" />
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-5 space-y-4">
              <div className="flex items-start gap-3">
                <AlertTriangle size={22} className="text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Are you sure?</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    If you sent funds but haven't sent a notification, the money is <strong className="text-foreground">lost forever</strong> and hasn't reached us.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={resetAndClose}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground border border-border hover:bg-secondary/40 transition-colors cursor-pointer"
                >
                  I'm sure
                </button>
                <button
                  onClick={() => setShowCloseGuard(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  No, wait!
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Regenerate Guard Modal ── */}
      {showRegenGuard && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/50" />
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-xl border border-border bg-background shadow-2xl p-5 space-y-4">
              <div className="flex items-start gap-3">
                <AlertTriangle size={22} className="text-amber-400 shrink-0 mt-0.5" />
                <div className="space-y-2">
                  <h3 className="text-sm font-semibold text-foreground">Regenerate address?</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    If you already sent funds to the current address but haven't sent a notification, that money is <strong className="text-foreground">lost forever</strong>. Make sure you've sent the notification first.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => {
                    setShowRegenGuard(false)
                    setState('idle')
                    setGeneratedAddress('')
                    setGeneratedTweak('')
                    setNotifyError(null)
                    setRelayResults(null)
                  }}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground border border-border hover:bg-secondary/40 transition-colors cursor-pointer"
                >
                  Regenerate anyway
                </button>
                <button
                  onClick={() => setShowRegenGuard(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors cursor-pointer"
                >
                  No, wait!
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}

// ── NIP-78 Sent List Persistence ──

async function saveSentEntry(
  privateKeyHex: string,
  pubkeyHex: string,
  entry: NspSentEntry,
): Promise<void> {
  // Load existing sent list
  let entries: NspSentEntry[] = []
  try {
    const { fetchReplaceable } = await import('@/lib/nostr/relay-pool')
    const existingEvent = await fetchReplaceable(pubkeyHex, KIND_NSP_SENT_LIST, NSP_SENT_DTAG)
    if (existingEvent?.content) {
      const plaintext = nip44DecryptSelf(privateKeyHex, existingEvent.content)
      const parsed = JSON.parse(plaintext)
      entries = parsed.entries || []
    }
  } catch (err) {
    console.warn('[Donate] Could not load existing sent list:', err)
  }

  // Append new entry
  entries.push(entry)

  // Encrypt and publish
  const encrypted = nip44EncryptSelf(privateKeyHex, JSON.stringify({ entries }))
  const sk = hexToBytes(privateKeyHex)

  const template = {
    kind: KIND_NSP_SENT_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', NSP_SENT_DTAG]],
    content: encrypted,
  }

  const signedEvent = finalizeEvent(template, sk)
  const publishRelays = getPublishRelays()
  await publishToSpecificRelays(publishRelays, signedEvent as any)

  console.log(`[Donate] Saved sent entry to NIP-78 (${entries.length} total entries)`)
}
