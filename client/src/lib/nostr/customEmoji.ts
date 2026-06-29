/**
 * customEmoji — NIP-30 custom emoji fetch/publish helpers
 *
 * Kind 30030: Emoji set (NIP-30, addressable replaceable)
 *   - "d" tag: UUIDv4 set identifier
 *   - "title" tag: display name
 *   - "emoji" tags: [shortcode, image-url, "sfw"|"nsfw" (optional)]
 *     (the 4th SFW/NSFW element is a DEN extension; NIP-30 readers ignore it)
 *
 * Kind 30000: Lists (parameterized replaceable)
 *   - "d" tag: "emoji-subscriptions"
 *   - "a" tags: ["a", "30030:pubkey:dtag"] for each subscribed set
 */

import { fetchEvents, fetchReplaceable, publishToSpecificRelays, fetchEventsFromRelays, getRelays } from '@/lib/nostr/relay-pool'
import { createUnsignedEvent, signWithSigner, withClientTag } from '@/lib/nostr/events'
import type { ISigner } from '@/stores/userStore'
import type { EmojiSet, CustomEmoji } from '@/stores/emojiStore'
import type { Event } from 'nostr-tools'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { useUserListsStore } from '@/stores/userListsStore'

const KIND_EMOJI_SET = 30030
const KIND_LIST = 30000

/**
 * Display name for a set: prefer the `title` tag (new sets), fall back to
 * de-slugging the d-tag for legacy sets that were keyed by their slugified name.
 */
function setTitle(event: Event, dTag: string): string {
  const title = event.tags.find((t) => t[0] === 'title')?.[1]
  return title?.trim() || dTag.replace(/[-_]/g, ' ')
}

// ─── Parsing ───

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

/** Fetch a specific emoji set by address (30030:pubkey:dtag). Queries user relays as fallback. */
export async function fetchEmojiSetByAddress(address: string): Promise<EmojiSet | null> {
  const parts = address.split(':')
  if (parts.length < 3) return null

  const kind = Number(parts[0])
  const pubkey = parts[1]
  const dTag = parts.slice(2).join(':')

  if (kind !== KIND_EMOJI_SET) return null

  // Try client relays first
  let event = await fetchReplaceable(pubkey, KIND_EMOJI_SET, dTag)

  // If not found, try user NIP-65 relays as fallback
  if (!event) {
    const userRelays = useUserListsStore.getState().userRelays
    const clientRelays = getRelays()
    const extraRelays = userRelays.filter((r) => !clientRelays.includes(r))
    if (extraRelays.length > 0) {
      const filter = { authors: [pubkey], kinds: [KIND_EMOJI_SET], '#d': [dTag], limit: 1 }
      const events = await fetchEventsFromRelays(extraRelays, filter).catch(() => [])
      event = events[0] ?? null
    }
  }

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
    name: setTitle(event, dTag),
    emojis,
  }
}

/** Discover emoji sets (kind 30030) from the network.
 *  Also queries user NIP-65 relays to find recently published sets that may not be on default relays yet.
 */
export async function discoverEmojiSets(limit = 50): Promise<EmojiSet[]> {
  const filter: Record<string, any> = {
    kinds: [KIND_EMOJI_SET],
    limit,
  }

  // Query both client relays and user NIP-65 relays in parallel
  const userRelays = useUserListsStore.getState().userRelays
  const clientRelays = getRelays()
  const extraRelays = userRelays.filter((r) => !clientRelays.includes(r))

  const fetches: Promise<Event[]>[] = [fetchEvents(filter)]
  if (extraRelays.length > 0) {
    fetches.push(fetchEventsFromRelays(extraRelays, filter).catch(() => []))
  }

  const results = await Promise.all(fetches)
  const allEvents = results.flat()

  // Deduplicate by pubkey:dTag (keep latest)
  const seen = new Map<string, Event>()
  for (const ev of allEvents) {
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
    if (!dTag) continue
    const key = `${ev.pubkey}:${dTag}`
    const existing = seen.get(key)
    if (!existing || ev.created_at > existing.created_at) {
      seen.set(key, ev)
    }
  }

  const sets: EmojiSet[] = []
  for (const ev of seen.values()) {
    const parsed = parseEmojiSetEventBroad(ev)
    if (parsed && parsed.emojis.length > 0) sets.push(parsed)
  }

  return sets
}

/** Fetch all emoji sets by a specific author. Queries both client and user relays. */
export async function fetchEmojiSetsByAuthor(pubkey: string): Promise<EmojiSet[]> {
  const filter = {
    kinds: [KIND_EMOJI_SET],
    authors: [pubkey],
  }

  const userRelays = useUserListsStore.getState().userRelays
  const clientRelays = getRelays()
  const extraRelays = userRelays.filter((r) => !clientRelays.includes(r))

  const fetches: Promise<Event[]>[] = [fetchEvents(filter)]
  if (extraRelays.length > 0) {
    fetches.push(fetchEventsFromRelays(extraRelays, filter).catch(() => []))
  }

  const results = await Promise.all(fetches)
  const allEvents = results.flat()

  // Deduplicate by dTag (keep latest)
  const seen = new Map<string, Event>()
  for (const ev of allEvents) {
    const dTag = ev.tags.find((t) => t[0] === 'd')?.[1]
    if (!dTag) continue
    const existing = seen.get(dTag)
    if (!existing || ev.created_at > existing.created_at) {
      seen.set(dTag, ev)
    }
  }

  const sets: EmojiSet[] = []
  for (const ev of seen.values()) {
    const parsed = parseEmojiSetEventBroad(ev)
    if (parsed && parsed.emojis.length > 0) sets.push(parsed)
  }
  return sets
}

// ─── Publishing ───

/** Publish (create or update) an emoji set */
export async function publishEmojiSet(
  dTag: string,
  name: string,
  emojis: CustomEmoji[],
  signer: ISigner | null,
  privateKey: string | null
): Promise<void> {
  const tags: [string, ...string[]][] = [
    ['d', dTag],
    ['title', name],
    ...emojis.map((e): [string, ...string[]] => ['emoji', e.shortcode, e.url, e.nsfw ? 'nsfw' : 'sfw']),
  ]

  const unsigned = createUnsignedEvent(KIND_EMOJI_SET, '', withClientTag(tags))
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
    ['deleted', 'true'],
  ]

  const unsigned = createUnsignedEvent(KIND_EMOJI_SET, '', withClientTag(tags))
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
