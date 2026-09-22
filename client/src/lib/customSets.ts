/**
 * Resolve a human display name for an emoji / sticker / gif set from its
 * "<kind>:<pubkey>:<dtag>" address.
 *
 * Prefers the locally-known set's `title`; falls back to de-slugging a legacy
 * slug d-tag, or a neutral label for the UUIDv4 d-tags used by newer sets that
 * aren't loaded locally (so we never render a raw UUID at the user).
 */

import { useEmojiStore } from '@/stores/emojiStore'
import { useStickerStore } from '@/stores/stickerStore'
import { useGifStore } from '@/stores/gifStore'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function setNameFromAddress(address: string): string {
  const parts = address.split(':')
  const pubkey = parts[1]
  const dTag = parts.slice(2).join(':')

  const match = (s: { pubkey: string; dTag: string }) => s.pubkey === pubkey && s.dTag === dTag
  const emoji = useEmojiStore.getState()
  const sticker = useStickerStore.getState()
  const gif = useGifStore.getState()
  const found =
    emoji.myEmojiSets.find(match) || emoji.subscribedSets.find(match) ||
    sticker.myStickerSets.find(match) || sticker.subscribedSets.find(match) ||
    gif.myGifCollections.find(match) || gif.subscribedCollections.find(match)

  if (found?.name) return found.name
  return UUID_RE.test(dTag) ? 'a custom set' : dTag.replace(/[-_]/g, ' ')
}

/* ─── Refreshing subscribed packs ───
 * Subscribed sets were fetched once at startup and never again, so a pack the author extended
 * during the session stayed stale (the "19 vs 20 stickers" report). Each picker calls this when it
 * opens; it re-fetches every subscribed address (newest across the author's relays too) and swaps in
 * the fresh copies, keeping the old one for any address that fails. Throttled per kind. */
import { fetchEmojiSetByAddress } from '@/lib/nostr/customEmoji'
import { fetchStickerSetByAddress } from '@/lib/nostr/customSticker'
import { fetchGifCollectionByAddress } from '@/lib/nostr/customGif'

export type PackKind = 'emoji' | 'sticker' | 'gif'
const REFRESH_MIN_INTERVAL_MS = 60_000
const lastRefresh: Record<PackKind, number> = { emoji: 0, sticker: 0, gif: 0 }
const inFlight: Partial<Record<PackKind, Promise<void>>> = {}

export function refreshSubscribedPacks(kind: PackKind, force = false): Promise<void> {
  if (inFlight[kind]) return inFlight[kind]!
  if (!force && Date.now() - lastRefresh[kind] < REFRESH_MIN_INTERVAL_MS) return Promise.resolve()
  lastRefresh[kind] = Date.now()
  const run = (async () => {
    try {
      if (kind === 'emoji') {
        const st = useEmojiStore.getState()
        if (st.subscriptionAddresses.length === 0) return
        const fresh = await Promise.all(st.subscriptionAddresses.map((a) => fetchEmojiSetByAddress(a).catch(() => null)))
        const merged = st.subscriptionAddresses.map((a, i) => fresh[i] ?? findByAddress(st.subscribedSets, a)).filter((x): x is NonNullable<typeof x> => !!x)
        useEmojiStore.getState().setSubscribedSets(merged)
      } else if (kind === 'sticker') {
        const st = useStickerStore.getState()
        if (st.subscriptionAddresses.length === 0) return
        const fresh = await Promise.all(st.subscriptionAddresses.map((a) => fetchStickerSetByAddress(a).catch(() => null)))
        const merged = st.subscriptionAddresses.map((a, i) => fresh[i] ?? findByAddress(st.subscribedSets, a)).filter((x): x is NonNullable<typeof x> => !!x)
        useStickerStore.getState().setSubscribedSets(merged)
      } else {
        const st = useGifStore.getState()
        if (st.subscriptionAddresses.length === 0) return
        const fresh = await Promise.all(st.subscriptionAddresses.map((a) => fetchGifCollectionByAddress(a).catch(() => null)))
        const merged = st.subscriptionAddresses.map((a, i) => fresh[i] ?? findByAddress(st.subscribedCollections, a)).filter((x): x is NonNullable<typeof x> => !!x)
        useGifStore.getState().setSubscribedCollections(merged)
      }
    } finally {
      delete inFlight[kind]
    }
  })()
  inFlight[kind] = run
  return run
}

function findByAddress<T extends { pubkey: string; dTag: string }>(list: T[], address: string): T | undefined {
  const parts = address.split(':')
  const pubkey = parts[1]
  const dTag = parts.slice(2).join(':')
  return list.find((s) => s.pubkey === pubkey && s.dTag === dTag)
}
