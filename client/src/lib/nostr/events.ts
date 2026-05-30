/**
 * Event Builder — Create and sign Nostr events for NIP-CHAT
 */

import { finalizeEvent, type UnsignedEvent, type Event } from 'nostr-tools'
import { KINDS, STANDARD_KINDS } from '@/lib/crypto/constants'
import type { ISigner } from '@/stores/userStore'

type Tag = [string, ...string[]]

/**
 * Create an unsigned Nostr event.
 */
export function createUnsignedEvent(
  kind: number,
  content: string,
  tags: Tag[],
  createdAt?: number
): UnsignedEvent {
  return {
    kind,
    content,
    tags,
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    pubkey: '', // Placeholder — real pubkey is set by signEvent or signWithSigner
  }
}

/**
 * Sign an event with a private key.
 * Only used when we hold the private key locally (seed-based auth).
 */
export function signEvent(unsignedEvent: UnsignedEvent, privateKeyHex: string): Event {
  const privKeyBytes = hexToBytes(privateKeyHex)
  return finalizeEvent(unsignedEvent, privKeyBytes)
}

/**
 * Sign an event using any ISigner (PC55, NIP-46, UPV2, NIP-07, etc.).
 * Falls back to local private key signing if a privateKey is provided.
 */
export async function signWithSigner(
  unsignedEvent: UnsignedEvent,
  signer: ISigner | null,
  privateKey: string | null
): Promise<Event> {
  if (signer) {
    // Signer needs pubkey on the event for signing
    const pubkey = await signer.getPublicKey()
    const eventWithPubkey = { ...unsignedEvent, pubkey }
    const signed = await signer.signEvent(eventWithPubkey)
    return signed as unknown as Event
  }
  if (privateKey) {
    return signEvent(unsignedEvent, privateKey)
  }
  throw new Error('No signer or private key available')
}

/**
 * Mine PoW for an event and sign it, with automatic retry if the signer
 * invalidates the PoW (e.g. by changing created_at during signing).
 *
 * If minPow is 0 or pubkey is missing, simply signs without mining.
 * Returns the signed event.  The caller's `unsigned` is NOT mutated.
 */
export async function mineAndSign(
  unsigned: UnsignedEvent,
  minPow: number,
  pubkey: string | null,
  signer: ISigner | null,
  privateKey: string | null
): Promise<Event> {
  if (minPow > 0 && pubkey) {
    const { mineEvent, countLeadingZeroBits } = await import('@/lib/pow/pow')
    const MAX_POW_RETRIES = 5
    let attempts = 0
    let mined = await mineEvent(unsigned, minPow, pubkey)
    let signed = await signWithSigner(mined, signer, privateKey)
    while (countLeadingZeroBits(signed.id) < minPow && attempts < MAX_POW_RETRIES) {
      attempts++
      console.warn(`[mineAndSign] PoW invalidated by signer (attempt ${attempts}), re-mining...`)
      const retryEvent: UnsignedEvent = {
        kind: signed.kind,
        content: signed.content,
        tags: mined.tags.filter((t: string[]) => t[0] !== 'nonce'),
        created_at: signed.created_at,
        pubkey: '',
      }
      mined = await mineEvent(retryEvent, minPow, signed.pubkey)
      signed = await signWithSigner(mined, signer, privateKey)
    }
    if (countLeadingZeroBits(signed.id) < minPow) {
      console.error(`[mineAndSign] PoW still invalid after ${MAX_POW_RETRIES} retries, sending anyway`)
    }
    return signed
  }
  return signWithSigner(unsigned, signer, privateKey)
}

/**
 * Create a hub message event (Kind 36943).
 * Per NIP-CHAT spec: addressable replaceable event with unique d-tag.
 * Uses "h" tag for hub reference, "c" for channel, "epoch" required.
 * Replies use "a" tags (addressable reference) instead of "e" tags.
 *
 * @param content - Encrypted message content
 * @param hubDTag - Hub d tag
 * @param channelId - Channel UUID
 * @param epoch - Current hub epoch number
 * @param replyTo - Optional {pubkey, dTag} of the message being replied to
 * @param dTag - Optional d-tag for edits (re-publish with same d-tag)
 * @param rootRef - Optional root message ref (a-tag value) for thread chains
 */
export function createMessageEvent(
  content: string,
  hubDTag: string,
  channelId: string,
  epoch: number = 1,
  replyTo?: { pubkey: string; dTag?: string; eventId?: string },
  dTag?: string,
  rootRef?: string,
  nsfw?: boolean,
  isThread?: boolean,
  facilitator?: string,
  isForum?: boolean
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', dTag || crypto.randomUUID()],
    ['h', hubDTag],
    ['c', channelId],
    ['epoch', epoch.toString()],
  ]

  if (replyTo) {
    if (replyTo.dTag) {
      // Addressable event — use a-tags
      const replyATag = `${KINDS.MESSAGE}:${replyTo.pubkey}:${replyTo.dTag}`
      tags.push(['a', rootRef || replyATag, '', 'root'])
      tags.push(['a', replyATag, '', 'reply'])
    } else if (replyTo.eventId) {
      // Non-addressable event (e.g. poll) — use e-tags
      const eventId = replyTo.eventId
      tags.push(['e', rootRef || eventId, '', 'root'])
      tags.push(['e', eventId, '', 'reply'])
    }
  }

  // Thread reply marker
  if (isThread) {
    tags.push(['thread'])
  }

  // NSFW / content-warning tags (NIP-36 + NIP-32)
  if (nsfw) {
    tags.push(['content-warning', ''])
    tags.push(['L', 'content-warning'])
  }

  // Facilitator tag — identifies who facilitated this non-member's encryption
  if (facilitator) {
    tags.push(['facilitator', facilitator])
  }

  // Forum post tag
  if (isForum) {
    tags.push(['forum'])
  }


  return createUnsignedEvent(KINDS.MESSAGE, content, tags)
}

/**
 * Create a hub chat reaction event (Kind 7).
 * Encrypted emoji content + hub routing tags so it can be subscribed alongside messages.
 *
 * @param encryptedEmoji - AES-encrypted emoji content (plain emoji or :shortcode:)
 * @param hubDTag - Hub d tag
 * @param channelId - Channel UUID
 * @param epoch - Current hub epoch number
 * @param targetEventId - Event ID of the message being reacted to
 * @param targetARef - Addressable ref: "36943:pubkey:dTag"
 * @param targetPubkey - Author pubkey of the target message
 */
export function createReactionEvent(
  encryptedEmoji: string,
  hubDTag: string,
  channelId: string,
  epoch: number,
  targetEventId: string,
  targetARef: string | undefined,
  targetPubkey: string
): UnsignedEvent {
  const tags: Tag[] = [
    ['h', hubDTag],
    ['c', channelId],
    ['epoch', epoch.toString()],
    ['e', targetEventId],
    ['p', targetPubkey],
  ]
  if (targetARef) {
    tags.push(['a', targetARef])
  }
  return createUnsignedEvent(STANDARD_KINDS.REACTION, encryptedEmoji, tags)
}

/**
 * Re-publish a reaction event with a "deleted" tag.
 * Used when unreacting — other clients skip events with ['deleted', 'true'].
 * Uses originalCreatedAt + 1 so the replacement doesn't jump to the front of the timeline.
 *
 * @param originalCreatedAt - created_at from the original reaction event
 */
export function createDeletedReactionEvent(
  hubDTag: string,
  channelId: string,
  epoch: number,
  targetEventId: string,
  targetARef: string,
  targetPubkey: string,
  originalCreatedAt: number
): UnsignedEvent {
  const tags: Tag[] = [
    ['h', hubDTag],
    ['c', channelId],
    ['epoch', epoch.toString()],
    ['e', targetEventId],
    ['a', targetARef],
    ['p', targetPubkey],
    ['deleted', 'true'],
  ]
  return createUnsignedEvent(STANDARD_KINDS.REACTION, '', tags, originalCreatedAt + 1)
}

/**
 * Create a NIP-09 deletion request event (Kind 5).
 * For regular events: references by event ID via e-tags.
 * For addressable events: references by a-tags (kind:pubkey:d-tag).
 */
export function createDeletionEvent(
  eventIds: string[],
  aRefs?: string[],
  reason?: string
): UnsignedEvent {
  const tags: Tag[] = [
    ...eventIds.map((id): Tag => ['e', id]),
    ...(aRefs || []).map((ref): Tag => ['a', ref]),
  ]
  return createUnsignedEvent(STANDARD_KINDS.DELETION, reason || '', tags)
}

/**
 * Re-publish a message event with a "deleted" tag using the same d-tag.
 * The relay replaces the original with this deleted version.
 * Uses originalCreatedAt + 1 so the replacement doesn't jump to the front of the timeline.
 *
 * @param originalCreatedAt - created_at from the original message event
 */
export function createDeletedMessageEvent(
  dTag: string,
  hubDTag: string,
  channelId: string,
  epoch: number = 1,
  originalCreatedAt?: number
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', dTag],
    ['h', hubDTag],
    ['c', channelId],
    ['epoch', epoch.toString()],
    ['deleted', 'true'],
  ]

  return createUnsignedEvent(KINDS.MESSAGE, '', tags, originalCreatedAt != null ? originalCreatedAt + 1 : undefined)
}

/**
 * Create a join request event (Kind 36944).
 * Per NIP-CHAT §6.3: addressable replaceable event for hub join requests.
 * If the user maintains a mesh list, includes a `list` tag with the index file hash.
 *
 * @param hubDTag - Hub d tag
 * @param creatorPubkey - Hub creator's pubkey
 * @param listHash - Optional SHA-256 hash of the user's own mesh list index file (§5.6)
 */
export function createJoinRequest(
  hubDTag: string,
  creatorPubkey: string,
  listHash?: string
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', hubDTag],
    ['p', creatorPubkey],
  ]

  if (listHash) {
    tags.push(['list', listHash])
  }

  return createUnsignedEvent(KINDS.JOIN_REQUEST, '', tags)
}

/**
 * Re-publish a join request with a "deleted" tag using the same d-tag.
 * The relay replaces the original with this deleted version.
 * Uses originalCreatedAt + 1 so the replacement doesn't jump to the front of the timeline.
 *
 * @param hubDTag - Hub d tag (same as the original join request's d-tag)
 * @param creatorPubkey - Hub creator's pubkey
 * @param originalCreatedAt - created_at from the original join request event
 */
export function createDeletedJoinRequest(
  hubDTag: string,
  creatorPubkey: string,
  originalCreatedAt: number
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', hubDTag],
    ['p', creatorPubkey],
    ['deleted', 'true'],
  ]

  return createUnsignedEvent(KINDS.JOIN_REQUEST, '', tags, originalCreatedAt + 1)
}

/**
 * Create a user hub list event (Kind 16942).
 * Per NIP-CHAT spec: v tag is [v, dTag, relayHint, position] or [v, dTag, relayHint, position:folderId]
 *
 * @param entries - Hub entries with position, relay hint, and optional folder
 * @param folders - Folder definitions
 */
export function createHubListEvent(
  entries: Array<{ dTag: string; relayHint?: string; position: number; folderId?: string }>,
  folders: Array<{ id: string; name: string; color?: string; position: number }>
): UnsignedEvent {
  const tags: Tag[] = []

  // Add folder definitions: [folder, id, name, color, position]
  for (const folder of folders) {
    tags.push(['folder', folder.id, folder.name, folder.color || '', folder.position.toString()])
  }

  // Add hub entries: [v, dTag, relayHint, position] or [v, dTag, relayHint, position:folderId]
  for (const entry of entries) {
    const posValue = entry.folderId
      ? `${entry.position}:${entry.folderId}`
      : entry.position.toString()
    tags.push(['v', entry.dTag, entry.relayHint || '', posValue])
  }

  return createUnsignedEvent(KINDS.USER_HUB_LIST, '', tags)
}

/**
 * Create a poll event (Kind 1067 — DEN Chat private polls).
 * Content is AES-encrypted JSON with question, options, polltype, endsAt.
 * Tags carry hub routing info (h, c, epoch) — no poll data in tags.
 */
export function createPollEvent(
  content: string,
  hubDTag: string,
  channelId: string,
  epoch: number = 1,
  facilitator?: string
): UnsignedEvent {
  const tags: Tag[] = [
    ['h', hubDTag],
    ['c', channelId],
    ['epoch', epoch.toString()],
  ]

  if (facilitator) {
    tags.push(['facilitator', facilitator])
  }

  return createUnsignedEvent(KINDS.POLL, content, tags)
}

/**
 * Create a vote event (Kind 1017 — DEN Chat private polls).
 * Content is AES-encrypted JSON with selected option IDs.
 * The e tag references the poll event ID for relay indexing.
 */
export function createVoteEvent(
  content: string,
  pollEventId: string,
  hubDTag: string,
  channelId: string,
  epoch: number = 1
): UnsignedEvent {
  const tags: Tag[] = [
    ['e', pollEventId],
    ['h', hubDTag],
    ['c', channelId],
    ['epoch', epoch.toString()],
  ]

  return createUnsignedEvent(KINDS.POLL_VOTE, content, tags)
}

/**
 * Create a calendar time-based event (Kind 31923 — NIP-52).
 * Content is AES-encrypted description. Tags carry encrypted metadata + hub routing.
 * Addressable replaceable event — same d-tag re-publishes replace the event.
 *
 * @param content - AES-encrypted event description
 * @param encryptedTags - Pre-encrypted tags (title, summary, image, location, g, start, end, D)
 * @param hubDTag - Hub d tag
 * @param epoch - Current hub epoch number
 * @param dTag - Optional d-tag (for edits — reuse existing d-tag)
 * @param facilitator - Optional facilitator pubkey
 */
export function createCalendarTimeEvent(
  content: string,
  encryptedTags: Tag[],
  hubDTag: string,
  epoch: number = 1,
  dTag?: string,
  facilitator?: string
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', dTag || crypto.randomUUID()],
    ['h', hubDTag],
    ['epoch', epoch.toString()],
    ...encryptedTags,
  ]

  if (facilitator) {
    tags.push(['facilitator', facilitator])
  }

  return createUnsignedEvent(KINDS.CALENDAR_TIME_EVENT, content, tags)
}

/**
 * Create a calendar event RSVP (Kind 31925 — NIP-52).
 * Content is AES-encrypted note. Status tag value is also encrypted.
 * Addressable replaceable — one RSVP per user per calendar event (via d-tag).
 *
 * @param content - AES-encrypted RSVP note (may be empty string)
 * @param eventARef - Addressable reference to the calendar event: "31923:pubkey:dTag"
 * @param hubDTag - Hub d tag
 * @param epoch - Current hub epoch number
 * @param encryptedStatus - AES-encrypted status value (accepted/declined/tentative)
 * @param dTag - Optional d-tag (for re-submitting/updating RSVP)
 */
export function createCalendarRsvpEvent(
  content: string,
  eventARef: string,
  hubDTag: string,
  epoch: number = 1,
  encryptedStatus: string,
  dTag?: string
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', dTag || crypto.randomUUID()],
    ['a', eventARef],
    ['h', hubDTag],
    ['epoch', epoch.toString()],
    ['status', encryptedStatus],
  ]

  return createUnsignedEvent(KINDS.CALENDAR_RSVP, content, tags)
}

/**
 * Re-publish a calendar event or RSVP with a "deleted" tag using the same d-tag.
 * The relay replaces the original with this deleted version.
 * Works for kind 31923 (events) and 31925 (RSVPs).
 * Uses originalCreatedAt + 1 so the replacement doesn't jump to the front of the timeline.
 *
 * @param originalCreatedAt - created_at from the original calendar event
 */
export function createDeletedCalendarEvent(
  kind: typeof KINDS.CALENDAR_TIME_EVENT | typeof KINDS.CALENDAR_RSVP,
  dTag: string,
  hubDTag: string,
  epoch: number = 1,
  originalCreatedAt?: number
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', dTag],
    ['h', hubDTag],
    ['epoch', epoch.toString()],
    ['deleted', 'true'],
  ]

  return createUnsignedEvent(kind, '', tags, originalCreatedAt != null ? originalCreatedAt + 1 : undefined)
}

// ── Hide Message (Kind 36949) ──

/**
 * Create a hide message event (Kind 36949).
 * Published by a moderator (with hide_messages permission) or the hub creator.
 * The d-tag is `hubDTag:targetRef` so each hide event is unique per target per hub per author.
 *
 * @param hubDTag - Hub d tag
 * @param targetRef - Target reference: a-tag value (e.g. "36943:pubkey:dTag") for addressable events, or event ID for regular events
 * @param targetPubkey - Author pubkey of the hidden message
 * @param targetKind - Kind number of the hidden event (e.g. 36943, 1067, 31923)
 * @param isAddressable - True if the target uses an a-tag reference, false for e-tag (event ID)
 */
export function createHideMessageEvent(
  hubDTag: string,
  targetRef: string,
  targetPubkey: string,
  targetKind: number,
  isAddressable: boolean = true
): UnsignedEvent {
  const dTag = `${hubDTag}:${targetRef}`
  const tags: Tag[] = [
    ['d', dTag],
    ['h', hubDTag],
    isAddressable ? ['a', targetRef] : ['e', targetRef],
    ['p', targetPubkey],
    ['k', targetKind.toString()],
  ]

  return createUnsignedEvent(KINDS.HIDE_MESSAGE, '', tags)
}

/**
 * Re-publish a hide event with a "deleted" tag using the same d-tag (unhide).
 * The relay replaces the original hide event with this deleted version.
 * After this, a NIP-09 deletion request should also be published for best-effort cleanup.
 * Uses originalCreatedAt + 1 so the replacement doesn't jump to the front of the timeline.
 *
 * @param hubDTag - Hub d tag
 * @param targetRef - Same target reference used in the original hide event
 * @param originalCreatedAt - created_at from the original hide event
 */
export function createDeletedHideEvent(
  hubDTag: string,
  targetRef: string,
  originalCreatedAt?: number
): UnsignedEvent {
  const dTag = `${hubDTag}:${targetRef}`
  const tags: Tag[] = [
    ['d', dTag],
    ['h', hubDTag],
    ['deleted', 'true'],
  ]

  return createUnsignedEvent(KINDS.HIDE_MESSAGE, '', tags, originalCreatedAt != null ? originalCreatedAt + 1 : undefined)
}

/** Report type values — NIP-56 vocabulary as suggestions, but any string is valid */
export type ReportType = 'spam' | 'nsfw' | 'scam' | 'illegal' | 'malware' | 'harassment' | 'other' | (string & {})

/**
 * Create a hub report event (Kind 36948).
 * Per NIP-CHAT spec: addressable replaceable event for hub-scoped user reports.
 * Encrypted with the hub secret via HKDF "reports" domain.
 *
 * @param content - Encrypted report text (AES-256-GCM)
 * @param hubDTag - Hub d tag
 * @param hubCreatorPubkey - Hub creator's pubkey
 * @param reportedPubkey - Pubkey of the reported user (violator)
 * @param reportType - Report classification (nudity, malware, profanity, etc.)
 * @param epoch - Current hub epoch number
 * @param reportedMessageATag - Optional: addressable ref of the reported message ("36943:pubkey:dTag")
 * @param dTag - Optional d-tag for edits (re-publish with same d-tag)
 */
export function createReportEvent(
  content: string,
  hubDTag: string,
  hubCreatorPubkey: string,
  reportedPubkey: string,
  reportType: ReportType,
  epoch: number,
  reportedMessageATag?: string,
  dTag?: string,
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', dTag || crypto.randomUUID()],
    ['a', `${KINDS.HUB_EVENT}:${hubCreatorPubkey}:${hubDTag}`],
    ['p', reportedPubkey],
    ['y', reportType],
    ['s', 'open'],
    ['epoch', epoch.toString()],
  ]

  if (reportedMessageATag) {
    tags.push(['report', reportedMessageATag])
  }

  return createUnsignedEvent(KINDS.REPORT, content, tags)
}

/**
 * Re-publish a report event with status "retracted" using the same d-tag.
 * The relay replaces the original report with this retracted version.
 *
 * @param dTag - Same d-tag as the original report
 * @param hubDTag - Hub d tag
 * @param hubCreatorPubkey - Hub creator's pubkey
 * @param reportedPubkey - Pubkey of the reported user
 * @param reportType - Original report type
 * @param epoch - Current hub epoch number
 * @param content - Encrypted retraction reason (optional, can be empty)
 * @param reportedMessageATag - Optional: original reported message ref
 */
export function createRetractedReportEvent(
  dTag: string,
  hubDTag: string,
  hubCreatorPubkey: string,
  reportedPubkey: string,
  reportType: ReportType,
  epoch: number,
  content: string,
  reportedMessageATag?: string,
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', dTag],
    ['a', `${KINDS.HUB_EVENT}:${hubCreatorPubkey}:${hubDTag}`],
    ['p', reportedPubkey],
    ['y', reportType],
    ['s', 'retracted'],
    ['epoch', epoch.toString()],
  ]

  if (reportedMessageATag) {
    tags.push(['report', reportedMessageATag])
  }

  return createUnsignedEvent(KINDS.REPORT, content, tags)
}

// ── Public Chat (Kind 1312) ──

/**
 * Create a public chat message event (Kind 1312).
 * Plaintext, topic-based, no encryption.
 * Uses `t` tag for topic routing and `e` tags for NIP-10 reply threading.
 *
 * @param content - Plaintext message content
 * @param topic - Topic string (normalized lowercase)
 * @param replyTo - Optional event ID of the message being replied to
 * @param rootRef - Optional root event ID for thread chains
 */
export function createPublicChatMessage(
  content: string,
  topic: string,
  replyTo?: string,
  rootRef?: string,
): UnsignedEvent {
  const tags: Tag[] = [
    ['t', topic.toLowerCase()],
  ]

  if (replyTo) {
    tags.push(['e', rootRef || replyTo, '', 'root'])
    tags.push(['e', replyTo, '', 'reply'])
  }

  return createUnsignedEvent(KINDS.PUBLIC_CHAT, content, tags)
}

/**
 * Create a public chat topic list event (NIP-78 — Kind 30078).
 * Addressable replaceable: stores the user's subscribed public chat topics.
 *
 * @param topics - Array of topic strings (lowercase)
 */
export function createPublicChatList(
  topics: string[],
): UnsignedEvent {
  const tags: Tag[] = [
    ['d', 'public-chat-list'],
    ...topics.map((t): Tag => ['t', t.toLowerCase()]),
  ]

  return createUnsignedEvent(STANDARD_KINDS.APP_DATA, '', tags)
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}
