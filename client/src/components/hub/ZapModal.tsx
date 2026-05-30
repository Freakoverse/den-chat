/**
 * ZapModal — Send a Lightning Zap to a message author
 *
 * Features:
 * - Quick-select sats amounts + custom input
 * - Optional zap comment
 * - Zap split with DEN Chat developers (configurable slider)
 * - QR code display for bolt11 invoice
 * - Copy invoice button
 * - WebLN support (browser wallet extension)
 * - Payment verification via relay subscription + verify URL polling
 * - Privacy warning about public zap metadata
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Zap, Copy, Check, X, Loader2, AlertTriangle, Wallet } from 'lucide-react'
import { useUserStore } from '@/stores/userStore'
import { useProfileCache, getCachedProfile } from '@/hooks/useProfileCache'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { truncateNpub } from '@/lib/utils'
import { nip19 } from 'nostr-tools'
import {
  resolveLnurl,
  createZapRequest,
  fetchZapInvoice,
  calculateSplit,
  getDevPubkey,
  formatSats,
  isWebLNAvailable,
  payWithWebLN,
  parseZapReceipt,
  type LnurlPayEndpoint,
} from '@/lib/nostr/zap'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { subscribeEvents } from '@/lib/nostr/relay-pool'
import { useZapStore } from '@/stores/zapStore'

type ZapState = 'idle' | 'resolving' | 'invoice' | 'paying' | 'dev-invoice' | 'success' | 'error'

interface ZapModalProps {
  open: boolean
  onClose: () => void
  recipientPubkey: string
  messageEventId?: string
  messageDTag?: string
  messageKind?: number
  hubDTag?: string
  /** Hide the dev split UI entirely (for non-hub contexts like social posts) */
  disableSplit?: boolean
  /** Store namespace for optimistic zap updates (defaults to hubDTag) */
  storeNamespace?: string
}

const PRESET_AMOUNTS = [
  { display: '21', val: 21 },
  { display: '100', val: 100 },
  { display: '500', val: 500 },
  { display: '1k', val: 1000 },
  { display: '5k', val: 5000 },
  { display: '10k', val: 10000 },
  { display: '21k', val: 21000 },
  { display: '50k', val: 50000 },
]

export function ZapModal({ open, onClose, recipientPubkey, messageEventId, messageDTag, messageKind, hubDTag, disableSplit, storeNamespace }: ZapModalProps) {
  const { getProfile } = useProfileCache()
  const signer = useUserStore((s) => s.signer)
  const privateKey = useUserStore((s) => s.privateKey)
  const myPubkey = useUserStore((s) => s.pubkey)

  // Compute the addressable reference key for this message
  // Messages are addressable replaceable events: kind:pubkey:dTag
  const messageStoreKey = messageDTag ? `${messageKind || 36943}:${recipientPubkey}:${messageDTag}` : messageEventId || ''

  const [sats, setSats] = useState(21)
  const [comment, setComment] = useState('')
  const [state, setState] = useState<ZapState>('idle')
  const [error, setError] = useState('')
  const [invoice, setInvoice] = useState('')
  const [copied, setCopied] = useState(false)
  const [showSplit, setShowSplit] = useState(true)
  const [splitEnabled, setSplitEnabled] = useState(() => {
    const saved = localStorage.getItem('den_zap_split_enabled')
    return saved !== null ? saved === 'true' : true
  })
  const [devPercent, setDevPercent] = useState(10)
  const [hasWebLN, setHasWebLN] = useState(false)
  const [devZapSent, setDevZapSent] = useState(false)
  const [devInvoice, setDevInvoice] = useState('')

  const subRef = useRef<{ close: () => void } | null>(null)
  const verifyIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const invoiceRef = useRef('')

  const profile = getProfile(recipientPubkey)
  const displayName = profile?.display_name || profile?.name || truncateNpub(nip19.npubEncode(recipientPubkey))

  // Dev profile for split display
  const devPubkey = getDevPubkey()
  const devProfile = getProfile(devPubkey)
  const devName = devProfile?.display_name || devProfile?.name || 'DEN Chat'
  const hasLud16 = !!(profile?.lud16)
  const devHasLud16 = !!(devProfile?.lud16)

  // WebLN detection
  useEffect(() => {
    setHasWebLN(isWebLNAvailable())
  }, [open])

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setState('idle')
      setError('')
      setInvoice('')
      setCopied(false)
      setSats(21)
      setComment('')
      setDevZapSent(false)
      setDevInvoice('')
      // Restore split preference (constrained by dev having lud16 and not disabled)
      if (disableSplit || !devHasLud16) {
        setSplitEnabled(false)
      } else {
        const saved = localStorage.getItem('den_zap_split_enabled')
        setSplitEnabled(saved !== null ? saved === 'true' : true)
      }
    }
    return () => {
      subRef.current?.close()
      subRef.current = null
      if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current)
    }
  }, [open])

  const { recipientSats, devSats } = useMemo(
    () => splitEnabled ? calculateSplit(sats, devPercent) : { recipientSats: sats, devSats: 0 },
    [sats, splitEnabled, devPercent]
  )
  /** Called on successful payment — update state + optimistically add to store */
  const handleSuccess = useCallback(() => {
    setState('success')
    // Optimistically add zap to the store so the badge shows immediately
    const ns = storeNamespace || hubDTag
    if (ns && messageStoreKey && myPubkey) {
      useZapStore.getState().addZap(ns, messageStoreKey, {
        receiptId: `optimistic-${Date.now()}`,
        senderPubkey: myPubkey,
        recipientPubkey,
        targetEventId: messageEventId,
        amount: splitEnabled ? recipientSats : sats,
        message: comment,
        createdAt: Math.floor(Date.now() / 1000),
        invoice: invoiceRef.current,
      })
    }
  }, [hubDTag, messageStoreKey, myPubkey, recipientPubkey, messageEventId, splitEnabled, recipientSats, sats, comment])

  const handleZap = useCallback(async (useWebLN = false) => {
    if (!myPubkey || !hasLud16) return
    setError('')

    try {
      setState('resolving')

      // Resolve recipient's LNURL
      const endpoint = await resolveLnurl(profile!.lud16!)
      if (!endpoint) {
        throw new Error('Could not resolve lightning address')
      }
      if (!endpoint.allowsNostr) {
        throw new Error('Recipient\'s lightning service does not support Nostr zaps')
      }

      // Create zap request for recipient
      const zapReq = await createZapRequest({
        recipientPubkey,
        eventId: messageEventId,
        eventKind: messageKind,
        amount: splitEnabled ? recipientSats : sats,
        comment,
        signer,
        privateKey,
      })

      // Fetch invoice
      const amountMsat = (splitEnabled ? recipientSats : sats) * 1000
      const result = await fetchZapInvoice(endpoint.callback, zapReq, amountMsat, endpoint.lnurl)

      invoiceRef.current = result.invoice
      setInvoice(result.invoice)

      if (useWebLN) {
        // Pay directly with WebLN
        setState('paying')
        try {
          await payWithWebLN(result.invoice)

          // Dev split
          if (splitEnabled && devSats > 0 && devHasLud16 && devProfile?.lud16) {
            await attemptDevSplit()
          } else {
            handleSuccess()
          }
          return
        } catch (err) {
          // WebLN failed — fall back to QR code
          console.warn('[Zap] WebLN payment failed, showing QR:', err)
        }
      }

      // Show QR code
      setState('invoice')

      // Start payment verification
      startPaymentVerification(result.verify, recipientPubkey, messageEventId)

    } catch (err: any) {
      setError(err.message || 'Zap failed')
      setState('error')
    }
  }, [myPubkey, hasLud16, profile, recipientPubkey, messageEventId, messageKind, sats, comment, signer, privateKey, splitEnabled, recipientSats, devSats, devHasLud16, devProfile])

  /** Zap the developer — returns true if payment succeeded, false otherwise */
  const zapDev = async (devAmount: number): Promise<boolean> => {
    if (!devProfile?.lud16) return false
    const devEndpoint = await resolveLnurl(devProfile.lud16)
    if (!devEndpoint || !devEndpoint.allowsNostr) return false

    const devZapReq = await createZapRequest({
      recipientPubkey: devPubkey,
      amount: devAmount,
      comment: `DEN Chat zap split (${devPercent}%)`,
      signer,
      privateKey,
    })

    const devResult = await fetchZapInvoice(devEndpoint.callback, devZapReq, devAmount * 1000, devEndpoint.lnurl)

    // Dev split only works via WebLN (can't show a second QR)
    if (isWebLNAvailable()) {
      try { await payWithWebLN(devResult.invoice); return true } catch { return false }
    }
    return false
  }

  /**
   * Attempt the dev split after the main payment is confirmed.
   * - If WebLN available → pay automatically → handleSuccess
   * - If no WebLN → generate dev invoice QR → show 'dev-invoice' state
   */
  const attemptDevSplit = async () => {
    if (!devProfile?.lud16) { handleSuccess(); return }

    try {
      // Try WebLN first
      if (isWebLNAvailable()) {
        const paid = await zapDev(devSats)
        setDevZapSent(paid)
        handleSuccess()
        return
      }

      // No WebLN — generate dev invoice and show QR
      const devEndpoint = await resolveLnurl(devProfile.lud16)
      if (!devEndpoint || !devEndpoint.allowsNostr) { handleSuccess(); return }

      const devZapReq = await createZapRequest({
        recipientPubkey: devPubkey,
        amount: devSats,
        comment: `DEN Chat zap split (${devPercent}%)`,
        signer,
        privateKey,
      })

      const devResult = await fetchZapInvoice(devEndpoint.callback, devZapReq, devSats * 1000, devEndpoint.lnurl)
      setDevInvoice(devResult.invoice)
      setCopied(false)
      setState('dev-invoice')

      // Start polling the dev verify URL if available
      if (devResult.verify) {
        verifyIntervalRef.current = setInterval(async () => {
          try {
            const res = await fetch(devResult.verify!)
            const data = await res.json()
            if (data.settled === true || (data.preimage && data.preimage.length > 0)) {
              if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current)
              setDevZapSent(true)
              handleSuccess()
            }
          } catch { /* ignore */ }
        }, 2000)
      }
    } catch {
      // Dev split failed to set up — just show success for main zap
      handleSuccess()
    }
  }

  /** Start polling/subscribing for payment confirmation */
  const startPaymentVerification = (verifyUrl: string | undefined, recipientPk: string, eventId?: string) => {
    // Method 1: Verify URL polling (if available)
    if (verifyUrl) {
      verifyIntervalRef.current = setInterval(async () => {
        try {
          const res = await fetch(verifyUrl)
          const data = await res.json()
          if (data.settled === true || (data.preimage && data.preimage.length > 0)) {
            if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current)
            subRef.current?.close()

            // Dev split
            if (splitEnabled && devSats > 0 && devHasLud16 && devProfile?.lud16) {
              await attemptDevSplit()
            } else {
              handleSuccess()
            }
          }
        } catch { /* ignore polling errors */ }
      }, 2000)
    }

    // Method 2: Subscribe for zap receipt on relays
    const filter: any = {
      kinds: [STANDARD_KINDS.ZAP_RECEIPT],
      '#p': [recipientPk],
      since: Math.floor(Date.now() / 1000) - 60,
    }
    if (eventId) {
      filter['#e'] = [eventId]
    }

    subRef.current = subscribeEvents(
      filter,
      async (evt) => {
        const zapInfo = parseZapReceipt(evt)
        if (!zapInfo) return
        // Match by invoice
        if (zapInfo.invoice === invoiceRef.current) {
          if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current)
          subRef.current?.close()

          // Dev split
          if (splitEnabled && devSats > 0 && devHasLud16 && devProfile?.lud16) {
            await attemptDevSplit()
          } else {
            handleSuccess()
          }
        }
      }
    )
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(invoice)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-2" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-md rounded-xl border border-border bg-background shadow-2xl animate-in fade-in-0 zoom-in-95 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <Zap size={18} className="text-yellow-400" />
            <h3 className="text-sm font-semibold text-foreground">Zap</h3>
            <Avatar className="w-5 h-5">
              {profile?.picture && <AvatarImage src={profile.picture} />}
              <AvatarFallback className="text-[8px] bg-primary/20">{displayName.slice(0, 2)}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium text-foreground truncate max-w-[200px]">{displayName}</span>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground cursor-pointer">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Privacy warning */}
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-200/80 leading-relaxed">
              Zaps are public — anyone can see who you zapped, the amount, and your zap message. The zap message is not encrypted.
            </p>
          </div>

          {state === 'idle' || state === 'resolving' || state === 'error' ? (
            <>
              {/* Amount input */}
              <div className="flex flex-col items-center gap-1">
                <input
                  value={sats}
                  onChange={(e) => {
                    const val = e.target.value.replace(/[^0-9]/g, '')
                    setSats(val ? parseInt(val, 10) : 0)
                  }}
                  className="bg-transparent text-center w-full p-0 focus-visible:outline-none text-5xl font-bold text-foreground"
                  disabled={state === 'resolving'}
                />
                <span className="text-xs text-muted-foreground font-medium">sats</span>
              </div>

              {/* Preset amounts */}
              <div className="grid grid-cols-4 gap-2">
                {PRESET_AMOUNTS.map(({ display, val }) => (
                  <button
                    key={val}
                    onClick={() => setSats(val)}
                    disabled={state === 'resolving'}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-all cursor-pointer
                      ${sats === val
                        ? 'border-yellow-400/50 bg-yellow-400/10 text-yellow-400'
                        : 'border-border bg-secondary/30 text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    {display}
                  </button>
                ))}
              </div>

              {/* Comment */}
              <div>
                <label className="text-xs font-medium text-muted-foreground">Message (public, not encrypted)</label>
                <input
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Optional zap comment..."
                  disabled={state === 'resolving'}
                  className="w-full mt-1 px-3 py-2 rounded-lg border border-border bg-secondary/30 text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:border-primary/40 transition-colors disabled:opacity-40"
                />
              </div>

              {/* Zap Split — only for hub context */}
              {!disableSplit && (
              <div className="px-3 py-3 rounded-lg border border-border bg-secondary/20 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs font-medium text-foreground">Zap Split with {devName}</span>
                    <p className="text-[10px] text-muted-foreground">
                      {devHasLud16 ? 'Support DEN Chat development' : 'Developer has no lightning address'}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      if (!devHasLud16) return
                      const newVal = !splitEnabled
                      setSplitEnabled(newVal)
                      localStorage.setItem('den_zap_split_enabled', String(newVal))
                    }}
                    disabled={!devHasLud16}
                    className={`relative w-9 h-[20px] rounded-full transition-colors shrink-0
                      ${!devHasLud16 ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
                      ${splitEnabled ? 'bg-yellow-400' : 'bg-muted-foreground/30'}`}
                  >
                    <div className={`absolute top-[2px] w-4 h-4 rounded-full bg-white shadow transition-transform
                      ${splitEnabled ? 'translate-x-[18px]' : 'translate-x-[2px]'}`} />
                  </button>
                </div>

                {splitEnabled && devHasLud16 && (
                  <div className="space-y-1.5">
                    <input
                      type="range"
                      min={1}
                      max={50}
                      value={devPercent}
                      onChange={(e) => setDevPercent(parseInt(e.target.value))}
                      className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-yellow-400"
                      style={{
                        background: `linear-gradient(to right, hsl(48 96% 53%) 0%, hsl(48 96% 53%) ${devPercent * 2}%, hsl(var(--muted)) ${devPercent * 2}%, hsl(var(--muted)) 100%)`,
                      }}
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>{displayName}: {formatSats(recipientSats)} sats ({100 - devPercent}%)</span>
                      <span>{devName}: {formatSats(devSats)} sats ({devPercent}%)</span>
                    </div>
                  </div>
                )}
              </div>
              )}

              {/* Error */}
              {state === 'error' && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/30">
                  <AlertTriangle size={14} className="text-destructive shrink-0" />
                  <span className="text-xs text-destructive">{error}</span>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2">
                {hasWebLN && (
                  <button
                    onClick={() => handleZap(true)}
                    disabled={state === 'resolving' || sats <= 0}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-yellow-400 hover:bg-yellow-500 text-black font-medium text-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {state === 'resolving' ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Wallet size={16} />
                    )}
                    Pay with Wallet
                  </button>
                )}
                <button
                  onClick={() => handleZap(false)}
                  disabled={state === 'resolving' || sats <= 0}
                  className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed
                    ${hasWebLN
                      ? 'bg-secondary border border-border text-foreground hover:bg-secondary/80'
                      : 'bg-yellow-400 hover:bg-yellow-500 text-black'
                    }`}
                >
                  {state === 'resolving' ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Zap size={16} />
                  )}
                  {hasWebLN ? 'Show QR' : `Zap ${formatSats(sats)} sats`}
                </button>
              </div>
            </>
          ) : state === 'invoice' || state === 'paying' ? (
            /* Invoice / QR code view */
            <div className="flex flex-col items-center gap-4">
              {/* Step indicator — only when split is active */}
              {splitEnabled && devSats > 0 && devHasLud16 && (
                <div className="flex items-start w-full">
                  {/* Step 1 */}
                  <div className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-6 h-6 rounded-full bg-yellow-400 flex items-center justify-center">
                      <span className="text-[11px] font-bold text-black">1</span>
                    </div>
                    <p className="text-[11px] font-medium text-foreground text-center">{displayName}</p>
                    <p className="text-[10px] text-muted-foreground">{formatSats(recipientSats)} sats</p>
                  </div>
                  {/* Connector */}
                  <div className="flex-shrink-0 w-10 mt-3 border-t border-dashed border-muted-foreground/30" />
                  {/* Step 2 */}
                  <div className="flex-1 flex flex-col items-center gap-1 opacity-40">
                    <div className="w-6 h-6 rounded-full border border-muted-foreground/40 flex items-center justify-center">
                      <span className="text-[11px] font-medium text-muted-foreground">2</span>
                    </div>
                    <p className="text-[11px] font-medium text-muted-foreground text-center">{devName}</p>
                    <p className="text-[10px] text-muted-foreground">{formatSats(devSats)} sats</p>
                  </div>
                </div>
              )}
              <div className="bg-white p-4 rounded-xl">
                <QRCodeSVG value={invoice} size={220} level="M" />
              </div>

              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {state === 'paying' ? 'Paying...' : `${formatSats(splitEnabled ? recipientSats : sats)} sats`}
                </p>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="text-xs">Waiting for payment...</span>
                </div>
              </div>

              {/* Copy invoice */}
              <button
                onClick={handleCopy}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/60 text-sm text-foreground transition-colors cursor-pointer"
              >
                {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                {copied ? 'Copied!' : 'Copy Invoice'}
              </button>

              {/* WebLN fallback if QR was shown but user has extension */}
              {hasWebLN && state === 'invoice' && (
                <button
                  onClick={async () => {
                    setState('paying')
                    try {
                      await payWithWebLN(invoice)
                      // Dev split
                      if (splitEnabled && devSats > 0 && devHasLud16 && devProfile?.lud16) {
                        await attemptDevSplit()
                      } else {
                        handleSuccess()
                      }
                    } catch {
                      setState('invoice')
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 text-sm font-medium hover:bg-yellow-400/20 transition-colors cursor-pointer"
                >
                  <Wallet size={14} />
                  Pay with Wallet Extension
                </button>
              )}
            </div>
          ) : state === 'dev-invoice' ? (
            /* Dev split QR code */
            <div className="flex flex-col items-center gap-4">
              {/* Step indicator */}
              <div className="flex items-start w-full">
                {/* Step 1 — completed */}
                <div className="flex-1 flex flex-col items-center gap-1">
                  <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">
                    <Check size={12} className="text-white" />
                  </div>
                  <p className="text-[11px] font-medium text-green-400/70 text-center line-through">{displayName}</p>
                  <p className="text-[10px] text-muted-foreground/50">{formatSats(recipientSats)} sats</p>
                </div>
                {/* Connector */}
                <div className="flex-shrink-0 w-10 mt-3 border-t border-dashed border-yellow-400/40" />
                {/* Step 2 — active */}
                <div className="flex-1 flex flex-col items-center gap-1">
                  <div className="w-6 h-6 rounded-full bg-yellow-400 flex items-center justify-center">
                    <span className="text-[11px] font-bold text-black">2</span>
                  </div>
                  <p className="text-[11px] font-medium text-yellow-400 text-center">{devName}</p>
                  <p className="text-[10px] text-muted-foreground">{formatSats(devSats)} sats</p>
                </div>
              </div>

              <div className="bg-white p-3 rounded-xl">
                <QRCodeSVG value={devInvoice} size={180} level="M" />
              </div>

              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {formatSats(devSats)} sats
                </p>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" />
                  <span className="text-xs">Waiting for payment...</span>
                </div>
              </div>

              {/* Copy dev invoice */}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(devInvoice)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-secondary/30 hover:bg-secondary/60 text-sm text-foreground transition-colors cursor-pointer"
              >
                {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                {copied ? 'Copied!' : 'Copy Invoice'}
              </button>

              {/* Skip button */}
              <button
                onClick={() => {
                  if (verifyIntervalRef.current) clearInterval(verifyIntervalRef.current)
                  handleSuccess()
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              >
                Skip dev split →
              </button>
            </div>
          ) : state === 'success' ? (
            /* Success */
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="w-16 h-16 rounded-full bg-green-500/15 border-2 border-green-500/30 flex items-center justify-center">
                <Zap size={28} className="text-yellow-400" fill="currentColor" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-lg font-semibold text-foreground">Zap Sent!</p>
                <p className="text-sm text-muted-foreground">
                  {formatSats(splitEnabled ? recipientSats : sats)} sats to {displayName}
                </p>
                {devZapSent && devSats > 0 && (
                  <p className="text-xs text-muted-foreground/70">
                    + {formatSats(devSats)} sats to {devName}
                  </p>
                )}
              </div>
              <button
                onClick={onClose}
                className="px-6 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
