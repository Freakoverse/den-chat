/**
 * gifStore — Manages custom GIF collections, subscriptions, and favorites
 *
 * - GIF collections: kind 30030 events with ["t", "gifs"], using "g" tags
 * - Subscriptions: kind 30000, d = "gif-subscriptions"
 * - Favorites: kind 30000, d = "gif-favorites", with individual "g" tags
 */

import { create } from 'zustand'

export interface GifEntry {
  name: string       // display name (can be empty for unnamed GIFs)
  url: string        // image URL (Blossom or external)
  nsfw: boolean      // whether this GIF is NSFW
  tagged: boolean    // true if SFW/NSFW tag exists (false = legacy/untagged)
}

export interface GifCollection {
  pubkey: string
  dTag: string       // collection identifier
  name: string       // human-readable (derived from dTag)
  gifs: GifEntry[]
}

interface GifState {
  /** User's own GIF collections (kind 30030, filtered by ["t", "gifs"]) */
  myGifCollections: GifCollection[]

  /** Subscribed GIF collections from other users */
  subscribedCollections: GifCollection[]

  /** Subscription addresses: ["30030:pubkey:dtag", ...] */
  subscriptionAddresses: string[]

  /** Individual favorited GIFs (kind 30000, d = "gif-favorites") */
  favorites: GifEntry[]

  /** Whether initial fetch has completed */
  loaded: boolean

  /** NSFW filter toggle — persisted to localStorage */
  nsfwEnabled: boolean

  /** Whether untagged content is treated as NSFW (default: true) */
  untaggedAsNsfw: boolean

  // ─── Collection Actions (mirrors emoji/sticker) ───

  setMyGifCollections: (collections: GifCollection[]) => void
  addMyGifCollection: (collection: GifCollection) => void
  updateMyGifCollection: (dTag: string, gifs: GifEntry[]) => void
  removeMyGifCollection: (dTag: string) => void

  setSubscribedCollections: (collections: GifCollection[]) => void
  setSubscriptionAddresses: (addrs: string[]) => void
  addSubscription: (address: string, collection: GifCollection) => void
  removeSubscription: (address: string) => void

  // ─── Favorite Actions ───

  setFavorites: (gifs: GifEntry[]) => void
  addFavorite: (gif: GifEntry) => void
  removeFavorite: (url: string) => void

  // ─── Misc ───

  setNsfwEnabled: (v: boolean) => void
  setUntaggedAsNsfw: (v: boolean) => void
  setLoaded: (v: boolean) => void
}

export const useGifStore = create<GifState>((set) => ({
  myGifCollections: [],
  subscribedCollections: [],
  subscriptionAddresses: [],
  favorites: [],
  loaded: false,
  nsfwEnabled: (() => {
    try { return localStorage.getItem('den-chat-gif-nsfw') === 'true' } catch { return false }
  })(),

  untaggedAsNsfw: (() => {
    try { return localStorage.getItem('den-chat-gif-untagged-nsfw') !== 'false' } catch { return true }
  })(),

  // ─── Collections ───

  setMyGifCollections: (collections) => set({ myGifCollections: collections }),

  addMyGifCollection: (collection) => set((s) => ({
    myGifCollections: [...s.myGifCollections, collection],
  })),

  updateMyGifCollection: (dTag, gifs) => set((s) => ({
    myGifCollections: s.myGifCollections.map((c) =>
      c.dTag === dTag ? { ...c, gifs } : c
    ),
  })),

  removeMyGifCollection: (dTag) => set((s) => ({
    myGifCollections: s.myGifCollections.filter((c) => c.dTag !== dTag),
  })),

  // ─── Subscriptions ───

  setSubscribedCollections: (collections) => set({ subscribedCollections: collections }),
  setSubscriptionAddresses: (addrs) => set({ subscriptionAddresses: addrs }),

  addSubscription: (address, collection) => set((s) => ({
    subscriptionAddresses: [...s.subscriptionAddresses, address],
    subscribedCollections: [...s.subscribedCollections, collection],
  })),

  removeSubscription: (address) => {
    const parts = address.split(':')
    const pubkey = parts[1]
    const dTag = parts.slice(2).join(':')
    set((s) => ({
      subscriptionAddresses: s.subscriptionAddresses.filter((a) => a !== address),
      subscribedCollections: s.subscribedCollections.filter((c) => !(c.pubkey === pubkey && c.dTag === dTag)),
    }))
  },

  // ─── Favorites ───

  setFavorites: (gifs) => set({ favorites: gifs }),

  addFavorite: (gif) => set((s) => ({
    favorites: [...s.favorites, gif],
  })),

  removeFavorite: (url) => set((s) => ({
    favorites: s.favorites.filter((g) => g.url !== url),
  })),

  // ─── Misc ───

  setNsfwEnabled: (v) => {
    try { localStorage.setItem('den-chat-gif-nsfw', v ? 'true' : 'false') } catch { /* ignore */ }
    set({ nsfwEnabled: v })
  },

  setUntaggedAsNsfw: (v) => {
    try { localStorage.setItem('den-chat-gif-untagged-nsfw', v ? 'true' : 'false') } catch { /* ignore */ }
    set({ untaggedAsNsfw: v })
  },

  setLoaded: (v) => set({ loaded: v }),
}))

/**
 * Build a merged lookup map of all available GIFs: name → { url, nsfw, source }
 * Priority: favorites > own collections > subscribed collections
 */
export function getGifMap(): Map<string, { url: string; nsfw: boolean; source: string }> {
  const { myGifCollections, subscribedCollections, favorites } = useGifStore.getState()
  const map = new Map<string, { url: string; nsfw: boolean; source: string }>()

  // Subscribed collections (lowest priority)
  for (let i = subscribedCollections.length - 1; i >= 0; i--) {
    const c = subscribedCollections[i]
    const addr = `30032:${c.pubkey}:${c.dTag}`
    for (const g of c.gifs) {
      if (g.name) map.set(g.name, { url: g.url, nsfw: g.nsfw, source: addr })
    }
  }

  // Own collections
  for (let i = myGifCollections.length - 1; i >= 0; i--) {
    const c = myGifCollections[i]
    const addr = `30032:${c.pubkey}:${c.dTag}`
    for (const g of c.gifs) {
      if (g.name) map.set(g.name, { url: g.url, nsfw: g.nsfw, source: addr })
    }
  }

  // Favorites (highest priority)
  for (const g of favorites) {
    if (g.name) map.set(g.name, { url: g.url, nsfw: g.nsfw, source: 'favorites' })
  }

  return map
}

/** Get GIF upload limit from localStorage (in bytes). Uses default blossom media limit. */
export function getGifUploadLimitBytes(): number {
  try {
    const stored = localStorage.getItem('den-chat-gif-upload-limit-mb')
    if (stored) return Math.max(0, Number(stored)) * 1024 * 1024
  } catch { /* ignore */ }
  return 10 * 1024 * 1024 // 10 MB default (same as general media)
}

/** Whether the user allows rendering GIFs larger than the limit */
export function getAllowLargeGifs(): boolean {
  try {
    return localStorage.getItem('den-chat-allow-large-gifs') === 'true'
  } catch { return false }
}

/* ─── GIF size checking cache ─── */

const GIF_SIZE_LIMIT = 10 * 1024 * 1024 // 10 MB
const gifSizeCache = new Map<string, 'ok' | 'too-large' | 'checking'>()

export function isGifSizeOk(url: string): boolean {
  if (getAllowLargeGifs()) return true
  const cached = gifSizeCache.get(url)
  if (cached === 'ok') return true
  if (cached === 'too-large') return false
  if (cached === 'checking') return true
  gifSizeCache.set(url, 'checking')
  checkGifSize(url)
  return true
}

async function checkGifSize(url: string): Promise<void> {
  try {
    const resp = await fetch(url, { method: 'HEAD' })
    const cl = resp.headers.get('content-length')
    if (cl && Number(cl) > GIF_SIZE_LIMIT) {
      gifSizeCache.set(url, 'too-large')
    } else {
      gifSizeCache.set(url, 'ok')
    }
  } catch {
    gifSizeCache.set(url, 'ok')
  }
}

export async function hasOversizedGif(gifs: { url: string }[]): Promise<boolean> {
  if (getAllowLargeGifs()) return false
  const checks = await Promise.all(gifs.map(async (g) => {
    const cached = gifSizeCache.get(g.url)
    if (cached === 'ok') return false
    if (cached === 'too-large') return true
    try {
      const resp = await fetch(g.url, { method: 'HEAD' })
      const cl = resp.headers.get('content-length')
      if (cl && Number(cl) > GIF_SIZE_LIMIT) {
        gifSizeCache.set(g.url, 'too-large')
        return true
      }
      gifSizeCache.set(g.url, 'ok')
      return false
    } catch {
      gifSizeCache.set(g.url, 'ok')
      return false
    }
  }))
  return checks.some(Boolean)
}
