/**
 * emojiStore — Manages custom emoji sets (NIP-30) and subscriptions
 *
 * - User's own emoji sets: kind 30030 events with ["t", "emoji"]
 * - Subscriptions to others' sets: kind 30000, d = "emoji-subscriptions"
 * - Provides a merged lookup map for :shortcode: resolution
 */

import { create } from 'zustand'

export interface CustomEmoji {
  shortcode: string    // alphanumeric, hyphens, underscores only
  url: string          // image URL (Blossom)
  nsfw: boolean        // true if explicitly tagged NSFW
  tagged: boolean      // true if SFW/NSFW tag exists (false = legacy/untagged)
}

export interface EmojiSet {
  pubkey: string
  dTag: string         // set identifier
  name: string         // human-readable set name (derived from dTag or first emoji)
  emojis: CustomEmoji[]
}

interface EmojiState {
  /** User's own emoji sets (kind 30030, filtered by ["t", "emoji"]) */
  myEmojiSets: EmojiSet[]

  /** Subscribed emoji sets from other users */
  subscribedSets: EmojiSet[]

  /** Subscription addresses: ["30030:pubkey:dtag", ...] */
  subscriptionAddresses: string[]

  /** Whether initial fetch has completed */
  loaded: boolean

  /** NSFW filter toggle — persisted to localStorage */
  nsfwEnabled: boolean

  /** Whether untagged content is treated as NSFW (default: true) */
  untaggedAsNsfw: boolean

  // ─── Actions ───

  setMyEmojiSets: (sets: EmojiSet[]) => void
  addMyEmojiSet: (set: EmojiSet) => void
  updateMyEmojiSet: (dTag: string, emojis: CustomEmoji[]) => void
  removeMyEmojiSet: (dTag: string) => void

  setSubscribedSets: (sets: EmojiSet[]) => void
  setSubscriptionAddresses: (addrs: string[]) => void
  addSubscription: (address: string, set: EmojiSet) => void
  removeSubscription: (address: string) => void

  setLoaded: (v: boolean) => void

  setNsfwEnabled: (v: boolean) => void
  setUntaggedAsNsfw: (v: boolean) => void
}

export const useEmojiStore = create<EmojiState>((set, get) => ({
  myEmojiSets: [],
  subscribedSets: [],
  subscriptionAddresses: [],
  loaded: false,

  nsfwEnabled: (() => {
    try { return localStorage.getItem('den-chat-emoji-nsfw') === 'true' } catch { return false }
  })(),

  untaggedAsNsfw: (() => {
    try { return localStorage.getItem('den-chat-emoji-untagged-nsfw') !== 'false' } catch { return true }
  })(),

  setMyEmojiSets: (sets) => set({ myEmojiSets: sets }),

  addMyEmojiSet: (newSet) => set((s) => ({
    myEmojiSets: [...s.myEmojiSets, newSet],
  })),

  updateMyEmojiSet: (dTag, emojis) => set((s) => ({
    myEmojiSets: s.myEmojiSets.map((es) =>
      es.dTag === dTag ? { ...es, emojis } : es
    ),
  })),

  removeMyEmojiSet: (dTag) => set((s) => ({
    myEmojiSets: s.myEmojiSets.filter((es) => es.dTag !== dTag),
  })),

  setSubscribedSets: (sets) => set({ subscribedSets: sets }),
  setSubscriptionAddresses: (addrs) => set({ subscriptionAddresses: addrs }),

  addSubscription: (address, emojiSet) => set((s) => ({
    subscriptionAddresses: [...s.subscriptionAddresses, address],
    subscribedSets: [...s.subscribedSets, emojiSet],
  })),

  removeSubscription: (address) => {
    // Parse "30030:pubkey:dtag" to find the matching set
    const parts = address.split(':')
    const pubkey = parts[1]
    const dTag = parts.slice(2).join(':')
    set((s) => ({
      subscriptionAddresses: s.subscriptionAddresses.filter((a) => a !== address),
      subscribedSets: s.subscribedSets.filter((es) => !(es.pubkey === pubkey && es.dTag === dTag)),
    }))
  },

  setLoaded: (v) => set({ loaded: v }),

  setNsfwEnabled: (v) => {
    try { localStorage.setItem('den-chat-emoji-nsfw', v ? 'true' : 'false') } catch { /* ignore */ }
    set({ nsfwEnabled: v })
  },

  setUntaggedAsNsfw: (v) => {
    try { localStorage.setItem('den-chat-emoji-untagged-nsfw', v ? 'true' : 'false') } catch { /* ignore */ }
    set({ untaggedAsNsfw: v })
  },
}))

/**
 * Build a merged lookup map: shortcode → { url, setAddress }
 * Priority (highest → lowest): first own set > later own sets > first subscribed > later subscribed.
 * Iterated in reverse because Map.set() last-write-wins.
 */
export function getEmojiMap(): Map<string, { url: string; setAddress: string }> {
  const { myEmojiSets, subscribedSets } = useEmojiStore.getState()
  const map = new Map<string, { url: string; setAddress: string }>()

  // Subscribed sets in reverse (last set first → lowest priority, first set last → highest among subscribed)
  for (let i = subscribedSets.length - 1; i >= 0; i--) {
    const s = subscribedSets[i]
    const addr = `30030:${s.pubkey}:${s.dTag}`
    for (const e of s.emojis) {
      map.set(e.shortcode, { url: e.url, setAddress: addr })
    }
  }

  // User's own sets in reverse (same logic — first set wins)
  for (let i = myEmojiSets.length - 1; i >= 0; i--) {
    const s = myEmojiSets[i]
    const addr = `30030:${s.pubkey}:${s.dTag}`
    for (const e of s.emojis) {
      map.set(e.shortcode, { url: e.url, setAddress: addr })
    }
  }

  return map
}

/**
 * Get the emoji upload limit from localStorage (in bytes).
 * Defaults to 1 MB if not set.
 */
export function getEmojiUploadLimitBytes(): number {
  try {
    const stored = localStorage.getItem('den-chat-emoji-upload-limit-mb')
    if (stored) return Math.max(0, Number(stored)) * 1024 * 1024
  } catch { /* ignore */ }
  return 1 * 1024 * 1024 // 1 MB default
}

/** Whether the user allows rendering/showing emojis larger than 1 MB */
export function getAllowLargeEmojis(): boolean {
  try {
    return localStorage.getItem('den-chat-allow-large-emojis') === 'true'
  } catch { return false }
}

/* ─── Emoji size checking (delegates to shared imageSizeGuard) ─── */

import {
  checkImageSize, checkSizeSync, getCachedSize,
  getRenderLimit, hasSizeOverride,
} from '@/lib/imageSizeGuard'

/** Render limit in bytes for emojis — reads from the user-configurable 'chat' category. */
function getEmojiRenderLimitBytes(): number {
  return getRenderLimit('chat') * 1024 * 1024
}

/**
 * Synchronous check: is an emoji URL within the render limit?
 * Uses the shared imageSizeGuard cache (HEAD requests with dedup).
 * Returns true if ok/unknown/checking, false if too large.
 * When allowLargeEmojis is enabled, always returns true.
 */
export function isEmojiSizeOk(url: string): boolean {
  if (getAllowLargeEmojis()) return true
  if (hasSizeOverride(url)) return true
  const limitBytes = getEmojiRenderLimitBytes()
  const status = checkSizeSync(url, limitBytes)
  // 'ok' | 'checking' | 'unknown' → allow; 'too-large' → block
  return status !== 'too-large'
}

/**
 * Check all emojis in a set. Returns true if ANY emoji exceeds the render limit.
 */
export async function hasOversizedEmoji(emojis: { url: string }[]): Promise<boolean> {
  if (getAllowLargeEmojis()) return false
  const limitBytes = getEmojiRenderLimitBytes()
  const checks = await Promise.all(emojis.map(async (e) => {
    if (hasSizeOverride(e.url)) return false
    const cached = getCachedSize(e.url)
    if (cached !== undefined) {
      return cached !== 'unknown' && cached > limitBytes
    }
    const size = await checkImageSize(e.url)
    return size !== 'unknown' && size > limitBytes
  }))
  return checks.some(Boolean)
}
