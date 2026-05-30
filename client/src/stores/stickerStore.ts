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
    const addr = `30030:${s.pubkey}:${s.dTag}`
    for (const st of s.stickers) {
      map.set(st.shortcode, { url: st.url, setAddress: addr })
    }
  }

  for (let i = myStickerSets.length - 1; i >= 0; i--) {
    const s = myStickerSets[i]
    const addr = `30030:${s.pubkey}:${s.dTag}`
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

/* ─── Sticker size checking cache ─── */

const STICKER_SIZE_LIMIT = 5 * 1024 * 1024 // 5 MB
const stickerSizeCache = new Map<string, 'ok' | 'too-large' | 'checking'>()

export function isStickerSizeOk(url: string): boolean {
  if (getAllowLargeStickers()) return true
  const cached = stickerSizeCache.get(url)
  if (cached === 'ok') return true
  if (cached === 'too-large') return false
  if (cached === 'checking') return true
  stickerSizeCache.set(url, 'checking')
  checkStickerSize(url)
  return true
}

async function checkStickerSize(url: string): Promise<void> {
  try {
    const resp = await fetch(url, { method: 'HEAD' })
    const cl = resp.headers.get('content-length')
    if (cl && Number(cl) > STICKER_SIZE_LIMIT) {
      stickerSizeCache.set(url, 'too-large')
    } else {
      stickerSizeCache.set(url, 'ok')
    }
  } catch {
    stickerSizeCache.set(url, 'ok')
  }
}

export async function hasOversizedSticker(stickers: { url: string }[]): Promise<boolean> {
  if (getAllowLargeStickers()) return false
  const checks = await Promise.all(stickers.map(async (s) => {
    const cached = stickerSizeCache.get(s.url)
    if (cached === 'ok') return false
    if (cached === 'too-large') return true
    try {
      const resp = await fetch(s.url, { method: 'HEAD' })
      const cl = resp.headers.get('content-length')
      if (cl && Number(cl) > STICKER_SIZE_LIMIT) {
        stickerSizeCache.set(s.url, 'too-large')
        return true
      }
      stickerSizeCache.set(s.url, 'ok')
      return false
    } catch {
      stickerSizeCache.set(s.url, 'ok')
      return false
    }
  }))
  return checks.some(Boolean)
}
