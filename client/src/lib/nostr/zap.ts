/**
 * Lightning Zap Service — NIP-57 implementation for DEN Chat
 *
 * Handles LNURL resolution, zap request creation, invoice fetching,
 * zap receipt parsing/validation, and WebLN integration.
 */

import { type Event, type UnsignedEvent } from 'nostr-tools'
import { makeZapRequest, getSatoshisAmountFromBolt11 } from 'nostr-tools/nip57'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { ADMIN_PUBKEY } from '@/lib/constants'
import { getRelays } from '@/lib/nostr/relay-pool'
import type { ISigner } from '@/stores/userStore'

/* ─── Types ─── */

export interface LnurlPayEndpoint {
  callback: string
  minSendable: number   // millisats
  maxSendable: number   // millisats
  allowsNostr: boolean
  nostrPubkey: string   // hex pubkey of the LNURL server (for receipt validation)
  lnurl: string         // the resolved LNURL URL
}

export interface ZapInfo {
  receiptId: string        // kind 9735 event ID
  senderPubkey: string     // who sent the zap
  recipientPubkey: string  // who received the zap
  targetEventId?: string   // event that was zapped
  amount: number           // sats
  message: string          // zap comment
  createdAt: number        // timestamp
  invoice: string          // bolt11 invoice string
}

export interface ZapSplitConfig {
  enabled: boolean
  devPercent: number       // 0-100 (default 10)
}

/* ─── LNURL Resolution ─── */

/**
 * Resolve a lightning address (lud16) to its LNURL-pay endpoint metadata.
 * Supports both user@domain format and lnurl-bech32 format.
 */
export async function resolveLnurl(lud16: string): Promise<LnurlPayEndpoint | null> {
  try {
    let lnurl: string

    if (lud16.includes('@')) {
      // lud16 format: user@domain
      const [name, domain] = lud16.split('@')
      lnurl = `https://${domain}/.well-known/lnurlp/${name}`
    } else if (lud16.toLowerCase().startsWith('lnurl')) {
      // lud06 bech32 format
      const decoded = decodeLnurl(lud16)
      if (!decoded) return null
      lnurl = decoded
    } else {
      return null
    }

    const res = await fetch(lnurl)
    if (!res.ok) return null

    const body = await res.json()

    if (!body.callback) return null

    return {
      callback: body.callback,
      minSendable: body.minSendable || 1000,
      maxSendable: body.maxSendable || 100000000000,
      allowsNostr: body.allowsNostr === true,
      nostrPubkey: body.nostrPubkey || '',
      lnurl,
    }
  } catch (err) {
    console.error('[Zap] Failed to resolve LNURL:', err)
    return null
  }
}

/**
 * Decode a bech32 LNURL string to a URL.
 */
function decodeLnurl(lnurl: string): string | null {
  try {
    // Simple bech32 decode for LNURL
    const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
    const str = lnurl.toLowerCase()
    const sepIdx = str.lastIndexOf('1')
    if (sepIdx < 1) return null

    const data: number[] = []
    for (let i = sepIdx + 1; i < str.length - 6; i++) {
      const v = ALPHABET.indexOf(str[i])
      if (v === -1) return null
      data.push(v)
    }

    // Convert 5-bit groups to 8-bit bytes
    let acc = 0
    let bits = 0
    const bytes: number[] = []
    for (const v of data) {
      acc = (acc << 5) | v
      bits += 5
      while (bits >= 8) {
        bits -= 8
        bytes.push((acc >> bits) & 0xff)
      }
    }

    return new TextDecoder().decode(new Uint8Array(bytes))
  } catch {
    return null
  }
}

/* ─── Zap Request Creation ─── */

/**
 * Create and sign a zap request event (kind 9734).
 * This event is NOT published to relays — it's sent to the LNURL callback.
 */
export async function createZapRequest(params: {
  recipientPubkey: string
  eventId?: string
  eventKind?: number
  amount: number           // sats
  comment: string
  signer: ISigner | null
  privateKey: string | null
}): Promise<Event> {
  const { recipientPubkey, eventId, eventKind, amount, comment, signer, privateKey } = params
  const relays = getRelays().slice(0, 5)
  const amountMsat = amount * 1000

  // Always use ProfileZap variant — EventZap crashes on parameterized replaceable
  // event kinds (30000-39999) because it tries to build an `a` tag from a missing `d` tag.
  const zapRequestDraft = makeZapRequest({
    pubkey: recipientPubkey,
    amount: amountMsat,
    relays,
    comment,
  })

  // Manually add event reference tag if zapping a specific message
  if (eventId) {
    zapRequestDraft.tags.push(['e', eventId])
  }

  // Sign the zap request
  const { signWithSigner } = await import('@/lib/nostr/events')
  const signed = await signWithSigner(zapRequestDraft as UnsignedEvent, signer, privateKey)
  return signed
}

/* ─── Invoice Fetching ─── */

/**
 * Send a signed zap request to the LNURL callback and get a bolt11 invoice.
 */
export async function fetchZapInvoice(
  callback: string,
  zapRequest: Event,
  amountMsat: number,
  lnurl: string,
): Promise<{ invoice: string; verify?: string }> {
  const encodedZapRequest = encodeURI(JSON.stringify(zapRequest))
  const url = `${callback}?amount=${amountMsat}&nostr=${encodedZapRequest}&lnurl=${encodeURIComponent(lnurl)}`

  const res = await fetch(url)
  const body = await res.json()

  if (body.status === 'ERROR' || body.error) {
    throw new Error(body.message || body.reason || 'Failed to create invoice')
  }

  if (!body.pr) {
    throw new Error(body.reason || 'No invoice returned')
  }

  return { invoice: body.pr, verify: body.verify }
}

/* ─── Zap Receipt Parsing ─── */

/**
 * Parse a kind 9735 zap receipt event into a ZapInfo object.
 */
export function parseZapReceipt(receiptEvent: Event): ZapInfo | null {
  if (receiptEvent.kind !== STANDARD_KINDS.ZAP_RECEIPT) return null

  let senderPubkey: string | undefined
  let recipientPubkey: string | undefined
  let targetEventId: string | undefined
  let invoice: string | undefined
  let description: string | undefined

  for (const tag of receiptEvent.tags) {
    switch (tag[0]) {
      case 'P':
        senderPubkey = tag[1]
        break
      case 'p':
        recipientPubkey = tag[1]
        break
      case 'e':
        targetEventId = tag[1]
        break
      case 'bolt11':
        invoice = tag[1]
        break
      case 'description':
        description = tag[1]
        break
    }
  }

  if (!recipientPubkey || !invoice) return null

  // Parse amount from bolt11 invoice using nostr-tools built-in parser
  let amount = 0
  try { amount = getSatoshisAmountFromBolt11(invoice) } catch { amount = parseAmountFromBolt11(invoice) }

  // Parse zap request from description to get sender + comment
  let message = ''
  if (description) {
    try {
      const zapRequest = JSON.parse(description)
      message = zapRequest.content || ''
      if (!senderPubkey) {
        senderPubkey = zapRequest.pubkey
      }
    } catch { /* ignore */ }
  }

  if (!senderPubkey) return null

  return {
    receiptId: receiptEvent.id,
    senderPubkey,
    recipientPubkey,
    targetEventId,
    amount,
    message,
    createdAt: receiptEvent.created_at,
    invoice,
  }
}

/* ─── Bolt11 Amount Parser ─── */

/**
 * Parse the amount in satoshis from a bolt11 invoice string.
 * Format: lnbc<amount><multiplier>1...
 *
 * Multipliers: m = milli (0.001), u = micro (0.000001), n = nano (0.000000001), p = pico (0.000000000001)
 */
export function parseAmountFromBolt11(invoice: string): number {
  try {
    const lower = invoice.toLowerCase()
    // Find the amount part — after 'lnbc' and before '1' separator
    const match = lower.match(/^ln(?:bc|tb|bcrt)(\d+)([munp]?)1/)
    if (!match) return 0

    const num = parseInt(match[1], 10)
    const multiplier = match[2]

    // Convert to satoshis (1 BTC = 100,000,000 sats)
    switch (multiplier) {
      case 'm': return num * 100000    // milli-bitcoin
      case 'u': return num * 100       // micro-bitcoin
      case 'n': return Math.round(num * 0.1)  // nano-bitcoin
      case 'p': return Math.round(num * 0.0001) // pico-bitcoin
      default:  return num * 100000000  // whole bitcoin
    }
  } catch {
    return 0
  }
}

/* ─── Format Helpers ─── */

/**
 * Format sats amount for display (e.g. 1000 → "1k", 1500000 → "1.5M")
 */
export function formatSats(amount: number): string {
  if (amount < 1000) return amount.toString()
  if (amount < 1000000) {
    const k = amount / 1000
    return k === Math.floor(k) ? `${k}k` : `${k.toFixed(1)}k`
  }
  const m = amount / 1000000
  return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`
}

/* ─── Zap Split Logic ─── */

/**
 * Get the developer pubkey for zap splits.
 * Uses the ADMIN_PUBKEY constant from the app config.
 */
export function getDevPubkey(): string {
  return ADMIN_PUBKEY
}

/**
 * Calculate split amounts for a zap.
 * Returns amounts in sats for recipient and developer.
 */
export function calculateSplit(
  totalSats: number,
  devPercent: number
): { recipientSats: number; devSats: number } {
  const devSats = Math.floor(totalSats * (devPercent / 100))
  const recipientSats = totalSats - devSats
  return { recipientSats, devSats }
}

/* ─── WebLN Detection ─── */

/**
 * Check if WebLN (browser lightning wallet extension) is available.
 */
export function isWebLNAvailable(): boolean {
  return typeof window !== 'undefined' && 'webln' in window && !!(window as any).webln
}

/**
 * Pay a bolt11 invoice using WebLN.
 * Returns the preimage on success.
 */
export async function payWithWebLN(invoice: string): Promise<string> {
  const webln = (window as any).webln
  if (!webln) throw new Error('WebLN not available')

  await webln.enable()
  const result = await webln.sendPayment(invoice)
  return result.preimage
}
