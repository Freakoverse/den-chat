/**
 * customGif — GIF fetch/publish helpers (mirrors customEmoji.ts / customSticker.ts)
 *
 * Kind 30032 (GIF collection, addressable replaceable):
 *   - "d" tag: UUIDv4 collection identifier
 *   - "title" tag: display name
 *   - "j" tags: [name, image-url, "sfw"|"nsfw"]
 *   ("j" is used instead of "g" because "g" is the standard Nostr geohash tag per NIP-52)
 *
 * Kind 30000, d = "gif-subscriptions":
 *   - "a" tags: ["a", "30032:pubkey:dtag"] for each subscribed collection
 *
 * Kind 30000, d = "gif-favorites":
 *   - "j" tags: [name, url, "sfw"|"nsfw"] for individually favorited GIFs
 */

import { fetchEvents, fetchReplaceable, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { createUnsignedEvent, signWithSigner, withClientTag } from '@/lib/nostr/events'
import type { ISigner } from '@/stores/userStore'
import type { GifCollection, GifEntry } from '@/stores/gifStore'
import type { Event } from 'nostr-tools'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { publishPersonal, getPublishRelays } from '@/stores/postingBehaviourStore'

const KIND_GIF_SET = 30032
const KIND_LIST = 30000

/**
 * Display name for a collection: prefer the `title` tag (new sets), fall back to
 * de-slugging the d-tag for legacy collections keyed by their slugified name.
 */
function setTitle(event: Event, dTag: string): string {
  const title = event.tags.find((t) => t[0] === 'title')?.[1]
  return title?.trim() || dTag.replace(/[-_]/g, ' ')
}

// ─── Parsing ───

/** Parse a kind 30030 event with t=gifs into a GifCollection */
function parseGifCollectionEvent(event: Event): GifCollection | null {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
  if (!dTag) return null

  const gifs: GifEntry[] = []
  for (const tag of event.tags) {
    if (tag[0] === 'j' && tag[2]) {
      gifs.push({
        name: tag[1] || '',
        url: tag[2],
        nsfw: tag[3] === 'nsfw',
        tagged: tag[3] === 'sfw' || tag[3] === 'nsfw',
      })
    }
  }

  if (gifs.length === 0) return null

  return {
    pubkey: event.pubkey,
    dTag,
    name: setTitle(event, dTag),
    gifs,
  }
}

// ─── Fetching ───

/** Fetch the current user's own GIF collections */
export async function fetchMyGifCollections(pubkey: string): Promise<GifCollection[]> {
  const events = await fetchEvents({
    kinds: [KIND_GIF_SET],
    authors: [pubkey],
  })

  const collections: GifCollection[] = []
  for (const ev of events) {
    const parsed = parseGifCollectionEvent(ev)
    if (parsed) collections.push(parsed)
  }
  return collections
}

/** Fetch the user's GIF subscription list (addresses) */
export async function fetchGifSubscriptions(pubkey: string): Promise<string[]> {
  const event = await fetchReplaceable(pubkey, KIND_LIST, 'gif-subscriptions')
  if (!event) return []

  return event.tags
    .filter((t) => t[0] === 'a' && t[1])
    .map((t) => t[1])
}

/** Fetch the user's GIF favorites */
export async function fetchGifFavorites(pubkey: string): Promise<GifEntry[]> {
  const event = await fetchReplaceable(pubkey, KIND_LIST, 'gif-favorites')
  if (!event) return []

  const favorites: GifEntry[] = []
  for (const tag of event.tags) {
    if (tag[0] === 'j' && tag[2]) {
      favorites.push({
        name: tag[1] || '',
        url: tag[2],
        nsfw: tag[3] === 'nsfw',
        tagged: tag[3] === 'sfw' || tag[3] === 'nsfw',
      })
    }
  }
  return favorites
}

/** Fetch a GIF collection by its addressable reference (30030:pubkey:dtag) */
export async function fetchGifCollectionByAddress(address: string): Promise<GifCollection | null> {
  const parts = address.split(':')
  if (parts.length < 3) return null

  const kind = Number(parts[0])
  const pubkey = parts[1]
  const dTag = parts.slice(2).join(':')

  if (kind !== KIND_GIF_SET) return null

  const event = await fetchReplaceable(pubkey, KIND_GIF_SET, dTag)
  if (!event) return null

  return parseGifCollectionEvent(event)
}

/** Discover GIF collections from the network */
export async function discoverGifCollections(limit = 50): Promise<GifCollection[]> {
  const events = await fetchEvents({
    kinds: [KIND_GIF_SET],
    limit,
  })

  const collections: GifCollection[] = []
  const seen = new Map<string, Event>()
  for (const ev of events) {
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
    if (!dTag) continue
    const key = `${ev.pubkey}:${dTag}`
    const existing = seen.get(key)
    if (!existing || ev.created_at > existing.created_at) {
      seen.set(key, ev)
    }
  }

  for (const ev of seen.values()) {
    const parsed = parseGifCollectionEvent(ev)
    if (parsed && parsed.gifs.length > 0) collections.push(parsed)
  }

  return collections
}

/** Search GIF collections on relays by querying #g tag values (exact match per term) */
export async function searchGifCollections(query: string, limit = 50): Promise<GifCollection[]> {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []

  // Full phrase + individual words (3+ chars) — relay ORs them
  const searchValues = [trimmed]
  const words = trimmed.split(/\s+/).filter((w) => w.length >= 3)
  if (words.length > 1) {
    for (const w of words) {
      if (!searchValues.includes(w)) searchValues.push(w)
    }
  }

  const events = await fetchEvents({
    kinds: [KIND_GIF_SET],
    '#j': searchValues,
    limit,
  })

  const seen = new Map<string, Event>()
  for (const ev of events) {
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
    if (!dTag) continue
    const key = `${ev.pubkey}:${dTag}`
    const existing = seen.get(key)
    if (!existing || ev.created_at > existing.created_at) {
      seen.set(key, ev)
    }
  }

  const collections: GifCollection[] = []
  for (const ev of seen.values()) {
    const parsed = parseGifCollectionEvent(ev)
    if (parsed && parsed.gifs.length > 0) collections.push(parsed)
  }

  return collections
}

/** Search GIF collections on relays by querying #d tag values (set name/identifier) */
export async function searchGifCollectionsByDTag(query: string, limit = 50): Promise<GifCollection[]> {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return []

  const searchValues = new Set<string>()
  searchValues.add(trimmed)
  // Also try hyphenated/underscored variants
  searchValues.add(trimmed.replace(/\s+/g, '-'))
  searchValues.add(trimmed.replace(/\s+/g, '_'))
  // Split by spaces, hyphens, underscores for individual terms
  const words = trimmed.split(/[\s_-]+/).filter((w) => w.length >= 3)
  for (const w of words) searchValues.add(w)

  const events = await fetchEvents({
    kinds: [KIND_GIF_SET],
    '#d': [...searchValues],
    limit,
  })

  const seen = new Map<string, Event>()
  for (const ev of events) {
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
    if (!dTag) continue
    const key = `${ev.pubkey}:${dTag}`
    const existing = seen.get(key)
    if (!existing || ev.created_at > existing.created_at) {
      seen.set(key, ev)
    }
  }

  const collections: GifCollection[] = []
  for (const ev of seen.values()) {
    const parsed = parseGifCollectionEvent(ev)
    if (parsed && parsed.gifs.length > 0) collections.push(parsed)
  }

  return collections
}

// ─── Publishing ───

/** Publish (create or update) a GIF collection */
export async function publishGifCollection(
  dTag: string,
  name: string,
  gifs: GifEntry[],
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', dTag],
    ['title', name],
    ...gifs.map((g): [string, ...string[]] => ['j', g.name, g.url, g.nsfw ? 'nsfw' : 'sfw']),
  ]

  const unsigned = createUnsignedEvent(KIND_GIF_SET, '', withClientTag(tags))
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishPersonal(signed)
}

/** Publish the GIF subscription list */
export async function publishGifSubscriptions(
  addresses: string[],
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', 'gif-subscriptions'],
    ...addresses.map((addr): [string, ...string[]] => ['a', addr]),
  ]

  const unsigned = createUnsignedEvent(KIND_LIST, '', tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishPersonal(signed)
}

/** Publish the GIF favorites list */
export async function publishGifFavorites(
  favorites: GifEntry[],
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', 'gif-favorites'],
    ...favorites.map((g): [string, ...string[]] => ['j', g.name, g.url, g.nsfw ? 'nsfw' : 'sfw']),
  ]

  const unsigned = createUnsignedEvent(KIND_LIST, '', tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishPersonal(signed)
}

/** Delete a GIF collection by publishing an empty replacement */
export async function deleteGifCollection(
  dTag: string,
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', dTag],
    ['deleted', 'true'],
  ]

  const unsigned = createUnsignedEvent(KIND_GIF_SET, '', withClientTag(tags))
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishPersonal(signed)
}

// ─── GIF tag encryption (hub chat) ───

/**
 * Encrypt GIF tag values for hub chat messages.
 * Keeps the "j" tag name cleartext but encrypts name, url, and nsfw flag.
 */
export async function encryptGifTags(
  tags: [string, string, string, string][],
  key: Uint8Array
): Promise<[string, ...string[]][]> {
  const result: [string, ...string[]][] = []
  for (const tag of tags) {
    const encName = await aesEncrypt(key, tag[1])
    const encUrl = await aesEncrypt(key, tag[2])
    const encNsfw = await aesEncrypt(key, tag[3])
    result.push(['j', encName, encUrl, encNsfw])
  }
  return result
}

/**
 * Decrypt GIF tag values from a hub chat event.
 * Backward compatible: if decryption fails, uses value as-is.
 */
export async function decryptGifTags(
  rawEvent: string | undefined,
  key: Uint8Array | null
): Promise<[string, string, string][] | undefined> {
  if (!rawEvent) return undefined
  let event: any
  try {
    event = JSON.parse(rawEvent)
  } catch {
    return undefined
  }

  const gifTags = event.tags?.filter((t: string[]) => t[0] === 'j' && t[2])
  if (!gifTags || gifTags.length === 0) return undefined

  const result: [string, string, string][] = []
  for (const tag of gifTags) {
    let name = tag[1] || ''
    let url = tag[2]
    let nsfw = tag[3] || 'sfw'

    if (key) {
      try { name = await aesDecrypt(key, name) } catch { /* cleartext */ }
      try { url = await aesDecrypt(key, url) } catch { /* cleartext */ }
      try { nsfw = await aesDecrypt(key, nsfw) } catch { /* cleartext */ }
    }

    result.push([name, url, nsfw])
  }

  return result.length > 0 ? result : undefined
}
