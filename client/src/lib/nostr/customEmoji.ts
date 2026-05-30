/**
 * customEmoji — NIP-30 custom emoji fetch/publish helpers
 *
 * Kind 30030: Emoji set (parameterized replaceable)
 *   - "d" tag: set identifier
 *   - "t" tag: "emoji" (type discriminator)
 *   - "emoji" tags: [shortcode, image-url, "sfw"|"nsfw" (optional)]
 *
 * Kind 30000: Lists (parameterized replaceable)
 *   - "d" tag: "emoji-subscriptions"
 *   - "a" tags: ["a", "30030:pubkey:dtag"] for each subscribed set
 */

import { fetchEvents, fetchReplaceable, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import type { ISigner } from '@/stores/userStore'
import type { EmojiSet, CustomEmoji } from '@/stores/emojiStore'
import type { Event } from 'nostr-tools'
import { getPublishRelays } from '@/stores/postingBehaviourStore'

const KIND_EMOJI_SET = 30030
const KIND_LIST = 30000

// ─── Parsing ───

/** Parse a kind 30030 event into an EmojiSet */
function parseEmojiSetEvent(event: Event): EmojiSet | null {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
  if (!dTag) return null

  // Must have ["t", "emoji"] tag
  const hasEmojiType = event.tags.some((t) => t[0] === 't' && t[1] === 'emoji')
  if (!hasEmojiType) return null

  const emojis: CustomEmoji[] = []
  for (const tag of event.tags) {
    if (tag[0] === 'emoji' && tag[1] && tag[2]) {
      emojis.push({
        shortcode: tag[1],
        url: tag[2],
        nsfw: tag[3] === 'nsfw',
        tagged: tag[3] === 'sfw' || tag[3] === 'nsfw',
      })
    }
  }

  return {
    pubkey: event.pubkey,
    dTag,
    name: dTag.replace(/[-_]/g, ' '),
    emojis,
  }
}

// ─── Fetching ───

/** Fetch all of the user's own emoji sets */
export async function fetchMyEmojiSets(pubkey: string): Promise<EmojiSet[]> {
  const events = await fetchEvents({
    kinds: [KIND_EMOJI_SET],
    authors: [pubkey],
  })

  const sets: EmojiSet[] = []
  for (const ev of events) {
    // Use broad parser — client-side filter for sets with emoji tags
    const parsed = parseEmojiSetEventBroad(ev)
    if (parsed) sets.push(parsed)
  }
  return sets
}

/** Fetch the user's emoji subscription list (kind 30000, d = "emoji-subscriptions") */
export async function fetchEmojiSubscriptions(pubkey: string): Promise<string[]> {
  const event = await fetchReplaceable(pubkey, KIND_LIST, 'emoji-subscriptions')
  if (!event) return []

  return event.tags
    .filter((t) => t[0] === 'a' && t[1])
    .map((t) => t[1])
}

/** Fetch a specific emoji set by address (30030:pubkey:dtag) */
export async function fetchEmojiSetByAddress(address: string): Promise<EmojiSet | null> {
  const parts = address.split(':')
  if (parts.length < 3) return null

  const kind = Number(parts[0])
  const pubkey = parts[1]
  const dTag = parts.slice(2).join(':')

  if (kind !== KIND_EMOJI_SET) return null

  const event = await fetchReplaceable(pubkey, KIND_EMOJI_SET, dTag)
  if (!event) return null

  // Use broad parser — other users' sets may not have ["t", "emoji"]
  return parseEmojiSetEventBroad(event)
}

/** Parse a kind 30030 event leniently — only requires d tag + at least one emoji tag (no t-tag check) */
function parseEmojiSetEventBroad(event: Event): EmojiSet | null {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
  if (!dTag) return null

  const emojis: CustomEmoji[] = []
  for (const tag of event.tags) {
    if (tag[0] === 'emoji' && tag[1] && tag[2]) {
      emojis.push({
        shortcode: tag[1],
        url: tag[2],
        nsfw: tag[3] === 'nsfw',
        tagged: tag[3] === 'sfw' || tag[3] === 'nsfw',
      })
    }
  }

  // Must have at least one emoji tag to qualify
  if (emojis.length === 0) return null

  return {
    pubkey: event.pubkey,
    dTag,
    name: dTag.replace(/[-_]/g, ' '),
    emojis,
  }
}

/** Discover emoji sets from the network. When broad=true, skips relay #t filter but still client-side filters for emoji content. */
export async function discoverEmojiSets(limit = 50, broad = false): Promise<EmojiSet[]> {
  const filter: Record<string, any> = {
    kinds: [KIND_EMOJI_SET],
    limit,
  }
  if (!broad) {
    filter['#t'] = ['emoji']
  }

  const events = await fetchEvents(filter)

  const sets: EmojiSet[] = []
  // Deduplicate by pubkey:dTag (keep latest)
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

  const parser = broad ? parseEmojiSetEventBroad : parseEmojiSetEvent
  for (const ev of seen.values()) {
    const parsed = parser(ev)
    if (parsed && parsed.emojis.length > 0) sets.push(parsed)
  }

  return sets
}

// ─── Publishing ───

/** Publish (create or update) an emoji set */
export async function publishEmojiSet(
  dTag: string,
  emojis: CustomEmoji[],
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', dTag],
    ['t', 'emoji'],
    ...emojis.map((e): [string, ...string[]] => ['emoji', e.shortcode, e.url, e.nsfw ? 'nsfw' : 'sfw']),
  ]

  const unsigned = createUnsignedEvent(KIND_EMOJI_SET, '', tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishToSpecificRelays(getPublishRelays(), signed)
}

/** Publish the emoji subscription list */
export async function publishEmojiSubscriptions(
  addresses: string[],
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', 'emoji-subscriptions'],
    ['t', 'emoji'],
    ...addresses.map((addr): [string, ...string[]] => ['a', addr]),
  ]

  const unsigned = createUnsignedEvent(KIND_LIST, '', tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishToSpecificRelays(getPublishRelays(), signed)
}

/** Delete an emoji set by publishing an empty replacement */
export async function deleteEmojiSet(
  dTag: string,
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', dTag],
    ['t', 'emoji'],
    ['deleted', 'true'],
  ]

  const unsigned = createUnsignedEvent(KIND_EMOJI_SET, '', tags)
  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishToSpecificRelays(getPublishRelays(), signed)
}

/**
 * Extract :shortcode: patterns from content and return matching emoji tags.
 * Used when sending messages to include NIP-30 emoji tags on the event.
 */
export function extractEmojiTags(
  content: string,
  emojiMap: Map<string, { url: string; setAddress: string }>
): [string, string, string, string][] {
  const shortcodeRegex = /:([a-zA-Z0-9_-]+):/g
  const tags: [string, string, string, string][] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  while ((match = shortcodeRegex.exec(content)) !== null) {
    const shortcode = match[1]
    if (seen.has(shortcode)) continue
    seen.add(shortcode)

    const emoji = emojiMap.get(shortcode)
    if (emoji) {
      tags.push(['emoji', shortcode, emoji.url, emoji.setAddress])
    }
  }

  return tags
}

// ─── Emoji tag encryption (hub chat) ───

import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'

/**
 * Encrypt emoji tag values in-place for hub chat messages.
 * Keeps the "emoji" tag name cleartext but encrypts shortcode, url, and set-ref.
 *
 * @param tags - Cleartext emoji tags from extractEmojiTags
 * @param key - AES-256 channel key (same key used for message content)
 * @returns Tags with encrypted values: ["emoji", enc(shortcode), enc(url), enc(set-ref)]
 */
export async function encryptEmojiTags(
  tags: [string, string, string, string][],
  key: Uint8Array
): Promise<[string, ...string[]][]> {
  const result: [string, ...string[]][] = []
  for (const tag of tags) {
    const encShortcode = await aesEncrypt(key, tag[1])
    const encUrl = await aesEncrypt(key, tag[2])
    const encSet = tag[3] ? await aesEncrypt(key, tag[3]) : ''
    result.push(['emoji', encShortcode, encUrl, ...(encSet ? [encSet] : [])])
  }
  return result
}

/**
 * Decrypt emoji tag values from a hub chat event.
 * Handles backward compatibility: if decryption fails (cleartext tag), uses the value as-is.
 *
 * @param rawEvent - Raw event JSON string
 * @param key - AES-256 channel key
 * @returns Decrypted emoji tags as [shortcode, url, set-ref?][], or undefined if none
 */
export async function decryptEmojiTags(
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

  const emojiTags = event.tags?.filter((t: string[]) => t[0] === 'emoji' && t[1] && t[2])
  if (!emojiTags || emojiTags.length === 0) return undefined

  const result: [string, string, string?][] = []
  for (const tag of emojiTags) {
    let shortcode = tag[1]
    let url = tag[2]
    let setRef: string | undefined = tag[3]

    if (key) {
      // Try decrypting — if it fails, assume cleartext (backward compat)
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
