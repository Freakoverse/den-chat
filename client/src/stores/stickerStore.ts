/**
 * stickerStore — Manages custom sticker sets and subscriptions
 *
 * Mirrors emojiStore but for stickers:
 * - Kind 30030 events with ["t", "sticker"]
 * - Subscription list: kind 30000, d = "sticker-subscriptions"
 */

import { create } from 'zustand'

export interface CustomSticker {
  shortcode: string
  url: string
  nsfw: boolean        // true if explicitly tagged NSFW
  tagged: boolean      // true if SFW/NSFW tag exists (false = legacy/untagged)
}

export interface StickerSet {
  pubkey: string
  dTag: string
  name: string
  stickers: CustomSticker[]
}

interface StickerState {
  myStickerSets: StickerSet[]
  subscribedSets: StickerSet[]
  subscriptionAddresses: string[]
  loaded: boolean

  /** NSFW filter toggle — persisted to localStorage */
  nsfwEnabled: boolean

  /** Whether untagged content is treated as NSFW (default: true) */
  untaggedAsNsfw: boolean

  setMyStickerSets: (sets: StickerSet[]) => void
  addMyStickerSet: (set: StickerSet) => void
  updateMyStickerSet: (dTag: string, stickers: CustomSticker[]) => void
  removeMyStickerSet: (dTag: string) => void

  setSubscribedSets: (sets: StickerSet[]) => void
  setSubscriptionAddresses: (addrs: string[]) => void
  addSubscription: (address: string, set: StickerSet) => void
  removeSubscription: (address: string) => void

  setLoaded: (v: boolean) => void

  setNsfwEnabled: (v: boolean) => void
  setUntaggedAsNsfw: (v: boolean) => void
}

export const useStickerStore = create<StickerState>((set) => ({
  myStickerSets: [],
  subscribedSets: [],
  subscriptionAddresses: [],
  loaded: false,

  nsfwEnabled: (() => {
    try { return localStorage.getItem('den-chat-sticker-nsfw') === 'true' } catch { return false }
  })(),

  untaggedAsNsfw: (() => {
    try { return localStorage.getItem('den-chat-sticker-untagged-nsfw') !== 'false' } catch { return true }
  })(),

  setMyStickerSets: (sets) => set({ myStickerSets: sets }),

  addMyStickerSet: (newSet) => set((s) => ({
    myStickerSets: [...s.myStickerSets, newSet],
  })),

  updateMyStickerSet: (dTag, stickers) => set((s) => ({
    myStickerSets: s.myStickerSets.map((ss) =>
      ss.dTag === dTag ? { ...ss, stickers } : ss
    ),
  })),

  removeMyStickerSet: (dTag) => set((s) => ({
    myStickerSets: s.myStickerSets.filter((ss) => ss.dTag !== dTag),
  })),

  setSubscribedSets: (sets) => set({ subscribedSets: sets }),
  setSubscriptionAddresses: (addrs) => set({ subscriptionAddresses: addrs }),

  addSubscription: (address, stickerSet) => set((s) => ({
    subscriptionAddresses: [...s.subscriptionAddresses, address],
    subscribedSets: [...s.subscribedSets, stickerSet],
  })),

  removeSubscription: (address) => {
    const parts = address.split(':')
    const pubkey = parts[1]
    const dTag = parts.slice(2).join(':')
    set((s) => ({
      subscriptionAddresses: s.subscriptionAddresses.filter((a) => a !== address),
      subscribedSets: s.subscribedSets.filter((ss) => !(ss.pubkey === pubkey && ss.dTag === dTag)),
    }))
  },

  setLoaded: (v) => set({ loaded: v }),

  setNsfwEnabled: (v) => {
    try { localStorage.setItem('den-chat-sticker-nsfw', v ? 'true' : 'false') } catch { /* ignore */ }
    set({ nsfwEnabled: v })
  },

  setUntaggedAsNsfw: (v) => {
    try { localStorage.setItem('den-chat-sticker-untagged-nsfw', v ? 'true' : 'false') } catch { /* ignore */ }
    set({ untaggedAsNsfw: v })
  },
}))

/**
 * Build a merged lookup map: shortcode → { url, setAddress }
 */
export function getStickerMap(): Map<string, { url: string; setAddress: string }> {
  const { myStickerSets, subscribedSets } = useStickerStore.getState()
  const map = new Map<string, { url: string; setAddress: string }>()

  for (let i = subscribedSets.length - 1; i >= 0; i--) {
    const s = subscribedSets[i]
    const addr = `30031:${s.pubkey}:${s.dTag}`
    for (const st of s.stickers) {
      map.set(st.shortcode, { url: st.url, setAddress: addr })
    }
  }

  for (let i = myStickerSets.length - 1; i >= 0; i--) {
    const s = myStickerSets[i]
    const addr = `30031:${s.pubkey}:${s.dTag}`
    for (const st of s.stickers) {
      map.set(st.shortcode, { url: st.url, setAddress: addr })
    }
  }

  return map
}

/** Get sticker upload limit from localStorage (in bytes). Default 5 MB. */
export function getStickerUploadLimitBytes(): number {
  try {
    const stored = localStorage.getItem('den-chat-sticker-upload-limit-mb')
    if (stored) return Math.max(0, Number(stored)) * 1024 * 1024
  } catch { /* ignore */ }
  return 5 * 1024 * 1024
}

/** Whether the user allows rendering stickers larger than 5 MB */
export function getAllowLargeStickers(): boolean {
  try {
    return localStorage.getItem('den-chat-allow-large-stickers') === 'true'
  } catch { return false }
}

/* ─── Sticker size checking (delegates to shared imageSizeGuard) ─── */

import {
  checkImageSize, checkSizeSync, getCachedSize,
  getRenderLimit, hasSizeOverride,
} from '@/lib/imageSizeGuard'

/** Render limit in bytes for stickers — reads from the user-configurable 'chat' category. */
function getStickerRenderLimitBytes(): number {
  return getRenderLimit('chat') * 1024 * 1024
}

/**
 * Synchronous check: is a sticker URL within the render limit?
 * Uses the shared imageSizeGuard cache (HEAD requests with dedup).
 * Returns true if ok/unknown/checking, false if too large.
 * When allowLargeStickers is enabled, always returns true.
 */
export function isStickerSizeOk(url: string): boolean {
  if (getAllowLargeStickers()) return true
  if (hasSizeOverride(url)) return true
  const limitBytes = getStickerRenderLimitBytes()
  const status = checkSizeSync(url, limitBytes)
  return status !== 'too-large'
}

/**
 * Check all stickers in a set. Returns true if ANY sticker exceeds the render limit.
 */
export async function hasOversizedSticker(stickers: { url: string }[]): Promise<boolean> {
  if (getAllowLargeStickers()) return false
  const limitBytes = getStickerRenderLimitBytes()
  const checks = await Promise.all(stickers.map(async (s) => {
    if (hasSizeOverride(s.url)) return false
    const cached = getCachedSize(s.url)
    if (cached !== undefined) {
      return cached !== 'unknown' && cached > limitBytes
    }
    const size = await checkImageSize(s.url)
    return size !== 'unknown' && size > limitBytes
  }))
  return checks.some(Boolean)
}
