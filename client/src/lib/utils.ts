import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { nip19 } from 'nostr-tools'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isTauri(): boolean {
  return '__TAURI__' in window
}

/** Resolve a user-typed npub or 64-char hex pubkey to a hex pubkey, or null if it isn't valid. */
export function resolvePubkeyInput(input: string): string | null {
  const q = input.trim()
  if (!q) return null
  try {
    if (q.startsWith('npub1')) {
      const decoded = nip19.decode(q)
      if (decoded.type === 'npub') return decoded.data as string
    }
  } catch { /* fall through */ }
  if (/^[0-9a-fA-F]{64}$/.test(q)) return q.toLowerCase()
  return null
}

/** Split an array into chunks of at most `size` (used to keep relay filters from getting too large). */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr]
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Open an external URL in the system browser. In Tauri, `window.open`/`target=_blank`
 * don't reach the OS browser from the webview, so use the opener plugin (the same
 * path the global anchor-click handler in main.tsx uses); fall back to window.open.
 */
export function openExternalUrl(url: string): void {
  if (isTauri()) {
    import('@tauri-apps/plugin-opener')
      .then(({ openUrl }) => openUrl(url).catch(() => window.open(url, '_blank', 'noopener,noreferrer')))
      .catch(() => window.open(url, '_blank', 'noopener,noreferrer'))
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/**
 * Detect mobile OS (Android / iOS) via userAgent.
 * NOT viewport-based — desktop users on narrow windows still return false.
 */
export function isMobileOS(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /android/i.test(ua) || /iphone|ipad|ipod/i.test(ua)
}

export function truncateNpub(npub: string, chars = 8): string {
  if (npub.length <= chars * 2 + 3) return npub
  return `${npub.slice(0, chars)}...${npub.slice(-chars)}`
}

/**
 * Hex pubkey → a short, display-safe npub (e.g. "npub1abc…wxyz"). Use anywhere a
 * user identifier is shown as a fallback for a missing profile name — never show
 * the raw hex pubkey to users. Falls back to a hex snippet only on invalid input.
 */
export function npubShort(pubkey: string, chars = 8): string {
  if (!pubkey) return 'Unknown'
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return pubkey.length > chars ? `${pubkey.slice(0, chars)}…` : pubkey
  try {
    return truncateNpub(nip19.npubEncode(pubkey), chars)
  } catch {
    return `${pubkey.slice(0, chars)}…`
  }
}

import { getHour12 } from '@/stores/preferencesStore'

export function formatTimestamp(timestamp: number): string {
  const hour12 = getHour12()
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()
  const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12 }

  if (isToday) {
    return date.toLocaleTimeString([], timeOpts)
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${date.toLocaleTimeString([], timeOpts)}`
  }

  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) +
    ' ' + date.toLocaleTimeString([], timeOpts)
}
