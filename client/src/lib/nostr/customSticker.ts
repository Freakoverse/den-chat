/**
 * customSticker — Sticker fetch/publish helpers (mirrors customEmoji.ts)
 *
 * Kind 30030 with ["t", "sticker"]:
 *   - "sticker" tags: [shortcode, image-url, "sfw"|"nsfw" (optional)]
 *
 * Kind 30000, d = "sticker-subscriptions":
 *   - "a" tags: ["a", "30030:pubkey:dtag"]
 */

import { fetchEvents, fetchReplaceable, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import type { ISigner } from '@/stores/userStore'
import type { StickerSet, CustomSticker } from '@/stores/stickerStore'
import type { Event } from 'nostr-tools'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { getPublishRelays } from '@/stores/postingBehaviourStore'

const KIND_STICKER_SET = 30030
const KIND_LIST = 30000

// ─── Parsing ───

function parseStickerSetEvent(event: Event): StickerSet | null {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
  if (!dTag) return null

  const hasStickerType = event.tags.some((t) => t[0] === 't' && t[1] === 'sticker')
  if (!hasStickerType) return null

  const stickers: CustomSticker[] = []
  for (const tag of event.tags) {
    if (tag[0] === 'sticker' && tag[1] && tag[2]) {
      stickers.push({
        shortcode: tag[1],
        url: tag[2],
        nsfw: tag[3] === 'nsfw',
        tagged: tag[3] === 'sfw' || tag[3] === 'nsfw',
      })
    }
  }

  if (stickers.length === 0) return null

  return {
    pubkey: event.pubkey,
    dTag,
    name: dTag.replace(/[-_]/g, ' '),
    stickers,
  }
}

// ─── Fetching ───

export async function fetchMyStickerSets(pubkey: string): Promise<StickerSet[]> {
  const events = await fetchEvents({
    kinds: [KIND_STICKER_SET],
    authors: [pubkey],
    '#t': ['sticker'],
  })

  const sets: StickerSet[] = []
  for (const ev of events) {
    const parsed = parseStickerSetEvent(ev)
    if (parsed) sets.push(parsed)
  }
  return sets
}

export async function fetchStickerSubscriptions(pubkey: string): Promise<string[]> {
  const event = await fetchReplaceable(pubkey, KIND_LIST, 'sticker-subscriptions')
  if (!event) return []

  return event.tags
    .filter((t) => t[0] === 'a' && t[1])
    .map((t) => t[1])
}

export async function fetchStickerSetByAddress(address: string): Promise<StickerSet | null> {
  const parts = address.split(':')
  if (parts.length < 3) return null

  const kind = Number(parts[0])
  const pubkey = parts[1]
  const dTag = parts.slice(2).join(':')

  if (kind !== KIND_STICKER_SET) return null

  const event = await fetchReplaceable(pubkey, KIND_STICKER_SET, dTag)
  if (!event) return null

  return parseStickerSetEvent(event)
}

export async function discoverStickerSets(limit = 50): Promise<StickerSet[]> {
  // Always filter by t tag — no broad option for stickers
  const events = await fetchEvents({
    kinds: [KIND_STICKER_SET],
    '#t': ['sticker'],
    limit,
  })

  const sets: StickerSet[] = []
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
    const parsed = parseStickerSetEvent(ev)
    if (parsed && parsed.stickers.length > 0) sets.push(parsed)
  }

  return sets
}

// ─── Publishing ───

export async function publishStickerSet(
  dTag: string,
  stickers: CustomSticker[],
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', dTag],
    ['t', 'sticker'],
    ...stickers.map((s): [string, ...string[]] => ['sticker', s.shortcode, s.url, s.nsfw ? 'nsfw' : 'sfw']),
  ]

  const unsigned = createUnsignedEvent(KIND_STICKER_SET, '', tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishToSpecificRelays(getPublishRelays(), signed)
}

export async function publishStickerSubscriptions(
  addresses: string[],
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', 'sticker-subscriptions'],
    ['t', 'sticker'],
    ...addresses.map((addr): [string, ...string[]] => ['a', addr]),
  ]

  const unsigned = createUnsignedEvent(KIND_LIST, '', tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishToSpecificRelays(getPublishRelays(), signed)
}

export async function deleteStickerSet(
  dTag: string,
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', dTag],
    ['t', 'sticker'],
    ['deleted', 'true'],
  ]

  const unsigned = createUnsignedEvent(KIND_STICKER_SET, '', tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishToSpecificRelays(getPublishRelays(), signed)
}

// ─── Sticker tag encryption (hub chat) ───

/**
 * Encrypt sticker tag values for hub chat messages.
 */
export async function encryptStickerTags(
  tags: [string, string, string, string][],
  key: Uint8Array
): Promise<[string, ...string[]][]> {
  const result: [string, ...string[]][] = []
  for (const tag of tags) {
    const encShortcode = await aesEncrypt(key, tag[1])
    const encUrl = await aesEncrypt(key, tag[2])
    const encSet = tag[3] ? await aesEncrypt(key, tag[3]) : ''
    result.push(['sticker', encShortcode, encUrl, ...(encSet ? [encSet] : [])])
  }
  return result
}

/**
 * Decrypt sticker tag values from a hub chat event.
 * Backward compatible: if decryption fails, uses value as-is.
 */
export async function decryptStickerTags(
  rawEvent: string | undefined,
  key: Uint8Array | null
): Promise<[string, string, string?][] | undefined> {
  if (!rawEvent) return undefined
  let event: any
  try {
    event = JSON.parse(rawEvent)
  } catch {
    return undefined
  }

  const stickerTags = event.tags?.filter((t: string[]) => t[0] === 'sticker' && t[1] && t[2])
  if (!stickerTags || stickerTags.length === 0) return undefined

  const result: [string, string, string?][] = []
  for (const tag of stickerTags) {
    let shortcode = tag[1]
    let url = tag[2]
    let setRef: string | undefined = tag[3]

    if (key) {
      try { shortcode = await aesDecrypt(key, shortcode) } catch { /* cleartext */ }
      try { url = await aesDecrypt(key, url) } catch { /* cleartext */ }
      if (setRef) {
        try { setRef = await aesDecrypt(key, setRef) } catch { /* cleartext */ }
      }
    }

    result.push([shortcode, url, setRef])
  }

  return result.length > 0 ? result : undefined
}
