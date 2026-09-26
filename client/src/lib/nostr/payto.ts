/**
 * NIP-A3 payment targets (kind 10133).
 *
 * A replaceable event listing where someone can be paid, one `payto` tag each:
 *
 *   ["payto", "<type>", "<authority>", ...extra]
 *
 * The type is a payment system ("bitcoin", "pix", "revolut"); the authority is the address within it.
 * Together they form a `payto://<type>/<authority>` URI. The list of types is open; an unrecognised one
 * is still perfectly valid and must be shown rather than dropped.
 *
 * Ported from DEG Mods' implementation.
 */
import type { Event as NostrEvent, UnsignedEvent } from 'nostr-tools'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { nowSeconds } from '@/lib/time/clockOffset'

export interface PaymentTarget {
  type: string
  authority: string
  /** Anything after the authority, preserved so a foreign client's data survives an edit. */
  extra: string[]
}

/** Per the spec: lowercase letters, digits and hyphens. */
export function normalizePaytoType(type: string): string {
  return type.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
}

export function isValidPaytoType(type: string): boolean {
  return /^[a-z0-9-]+$/.test(normalizePaytoType(type))
}

export function extractPaymentTargets(event: NostrEvent | null | undefined): PaymentTarget[] {
  if (!event || event.kind !== STANDARD_KINDS.PAYTO) return []
  return event.tags
    .filter((t) => t[0] === 'payto' && t[1] && t[2])
    .map((t) => ({ type: normalizePaytoType(t[1]), authority: t[2], extra: t.slice(3) }))
    .filter((t) => !!t.type)
}

export function buildPaytoEvent(targets: PaymentTarget[]): UnsignedEvent {
  return {
    kind: STANDARD_KINDS.PAYTO,
    content: '',
    tags: [
      ...targets
        .filter((t) => normalizePaytoType(t.type) && t.authority.trim())
        .map((t) => ['payto', normalizePaytoType(t.type), t.authority.trim(), ...t.extra]),
      ['client', 'DEN Chat'],
    ],
    created_at: nowSeconds(STANDARD_KINDS.PAYTO),
    pubkey: '',
  }
}

/** The full `payto://` URI, for clients that want to hand off to a wallet. */
export function paytoUri(target: PaymentTarget): string {
  return `payto://${target.type}/${encodeURIComponent(target.authority)}`
}

/**
 * Known payment systems, for type-ahead only; anything may be typed, and an unlisted type is as valid
 * as a listed one. Deliberately wide: what counts as an obvious way to get paid is entirely regional,
 * and a list that only covers the US and crypto would quietly tell most of the world they're an edge case.
 */
export const PAYMENT_TYPES: { type: string; label: string; region?: string }[] = [
  // Crypto
  { type: 'bitcoin', label: 'Bitcoin' },
  { type: 'lightning', label: 'Lightning' },
  { type: 'ethereum', label: 'Ethereum' },
  { type: 'monero', label: 'Monero' },
  { type: 'litecoin', label: 'Litecoin' },
  { type: 'dogecoin', label: 'Dogecoin' },
  { type: 'solana', label: 'Solana' },
  { type: 'nano', label: 'Nano' },
  { type: 'tron', label: 'Tron' },
  { type: 'usdt', label: 'USDT' },
  { type: 'usdc', label: 'USDC' },
  { type: 'zcash', label: 'Zcash' },
  { type: 'ton', label: 'TON' },

  // Global / cross-border
  { type: 'paypal', label: 'PayPal' },
  { type: 'wise', label: 'Wise' },
  { type: 'revolut', label: 'Revolut' },
  { type: 'skrill', label: 'Skrill' },
  { type: 'payoneer', label: 'Payoneer' },
  { type: 'iban', label: 'IBAN / SEPA' },

  // North America
  { type: 'cashapp', label: 'Cash App', region: 'US' },
  { type: 'venmo', label: 'Venmo', region: 'US' },
  { type: 'zelle', label: 'Zelle', region: 'US' },
  { type: 'interac', label: 'Interac e-Transfer', region: 'Canada' },

  // Europe
  { type: 'bizum', label: 'Bizum', region: 'Spain' },
  { type: 'swish', label: 'Swish', region: 'Sweden' },
  { type: 'mobilepay', label: 'MobilePay', region: 'Denmark / Finland' },
  { type: 'vipps', label: 'Vipps', region: 'Norway' },
  { type: 'blik', label: 'BLIK', region: 'Poland' },
  { type: 'satispay', label: 'Satispay', region: 'Italy' },
  { type: 'twint', label: 'TWINT', region: 'Switzerland' },
  { type: 'ideal', label: 'iDEAL', region: 'Netherlands' },
  { type: 'bancontact', label: 'Bancontact', region: 'Belgium' },
  { type: 'monzo', label: 'Monzo', region: 'UK' },

  // Russia / CIS
  { type: 'sbp', label: 'SBP (Fast Payments)', region: 'Russia' },
  { type: 'yoomoney', label: 'YooMoney', region: 'Russia' },
  { type: 'sberpay', label: 'SberPay', region: 'Russia' },
  { type: 'qiwi', label: 'QIWI', region: 'Russia' },

  // Asia
  { type: 'upi', label: 'UPI', region: 'India' },
  { type: 'paytm', label: 'Paytm', region: 'India' },
  { type: 'phonepe', label: 'PhonePe', region: 'India' },
  { type: 'alipay', label: 'Alipay', region: 'China' },
  { type: 'wechatpay', label: 'WeChat Pay', region: 'China' },
  { type: 'paypay', label: 'PayPay', region: 'Japan' },
  { type: 'linepay', label: 'LINE Pay', region: 'Japan / Taiwan' },
  { type: 'kakaopay', label: 'KakaoPay', region: 'South Korea' },
  { type: 'tosspay', label: 'Toss', region: 'South Korea' },
  { type: 'promptpay', label: 'PromptPay', region: 'Thailand' },
  { type: 'truemoney', label: 'TrueMoney', region: 'Thailand' },
  { type: 'gcash', label: 'GCash', region: 'Philippines' },
  { type: 'maya', label: 'Maya', region: 'Philippines' },
  { type: 'momo', label: 'MoMo', region: 'Vietnam' },
  { type: 'zalopay', label: 'ZaloPay', region: 'Vietnam' },
  { type: 'gopay', label: 'GoPay', region: 'Indonesia' },
  { type: 'ovo', label: 'OVO', region: 'Indonesia' },
  { type: 'dana', label: 'DANA', region: 'Indonesia' },
  { type: 'grabpay', label: 'GrabPay', region: 'Southeast Asia' },
  { type: 'touchngo', label: "Touch 'n Go", region: 'Malaysia' },
  { type: 'duitnow', label: 'DuitNow', region: 'Malaysia' },
  { type: 'paynow', label: 'PayNow', region: 'Singapore' },
  { type: 'jazzcash', label: 'JazzCash', region: 'Pakistan' },
  { type: 'easypaisa', label: 'Easypaisa', region: 'Pakistan' },
  { type: 'bkash', label: 'bKash', region: 'Bangladesh' },

  // Gulf / Middle East
  { type: 'stcpay', label: 'STC Pay', region: 'Saudi Arabia' },
  { type: 'mada', label: 'mada', region: 'Saudi Arabia' },
  { type: 'benefitpay', label: 'BenefitPay', region: 'Bahrain' },
  { type: 'knet', label: 'KNET', region: 'Kuwait' },
  { type: 'sadad', label: 'SADAD', region: 'Qatar / Saudi Arabia' },
  { type: 'fawry', label: 'Fawry', region: 'Egypt' },
  { type: 'instapay', label: 'InstaPay', region: 'Egypt' },
  { type: 'vodafonecash', label: 'Vodafone Cash', region: 'Egypt' },
  { type: 'papara', label: 'Papara', region: 'Türkiye' },

  // South America
  { type: 'pix', label: 'Pix', region: 'Brazil' },
  { type: 'mercadopago', label: 'Mercado Pago', region: 'Latin America' },
  { type: 'picpay', label: 'PicPay', region: 'Brazil' },
  { type: 'nequi', label: 'Nequi', region: 'Colombia' },
  { type: 'daviplata', label: 'Daviplata', region: 'Colombia' },
  { type: 'yape', label: 'Yape', region: 'Peru' },
  { type: 'plin', label: 'Plin', region: 'Peru' },
  { type: 'uala', label: 'Ualá', region: 'Argentina' },

  // Africa
  { type: 'mpesa', label: 'M-Pesa', region: 'Kenya / Tanzania' },
  { type: 'mtnmomo', label: 'MTN MoMo', region: 'Africa' },
  { type: 'airtelmoney', label: 'Airtel Money', region: 'Africa' },
  { type: 'orangemoney', label: 'Orange Money', region: 'Africa' },
  { type: 'opay', label: 'OPay', region: 'Nigeria' },
]

const BY_TYPE = new Map(PAYMENT_TYPES.map((p) => [p.type, p]))

/** Display name for a type, falling back to the raw value for unknown ones. */
export function paymentTypeLabel(type: string): string {
  return BY_TYPE.get(type)?.label ?? type
}

/** Type-ahead matches, best-prefix first. Empty query returns the common ones. */
export function suggestPaymentTypes(query: string, limit = 8): typeof PAYMENT_TYPES {
  const q = normalizePaytoType(query)
  if (!q) return PAYMENT_TYPES.slice(0, limit)
  const starts: typeof PAYMENT_TYPES = []
  const contains: typeof PAYMENT_TYPES = []
  for (const p of PAYMENT_TYPES) {
    const hay = `${p.type} ${p.label.toLowerCase()}`
    if (p.type.startsWith(q) || p.label.toLowerCase().startsWith(q)) starts.push(p)
    else if (hay.includes(q)) contains.push(p)
  }
  return [...starts, ...contains].slice(0, limit)
}
