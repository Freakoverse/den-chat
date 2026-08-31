/**
 * useHubSubscriptions — Manages real-time message subscriptions for all hubs
 *
 * Architecture:
 * 1. On startup: load cached messages from IndexedDB → populate messageStore
 * 2. Create TWO subscription types per relay batch:
 *    a. Initial fetch — limit: INITIAL_LIMIT (latest N messages)
 *    b. Real-time — since: now (catches new messages as they arrive)
 * 3. Incoming events → add to messageStore + write-through to IndexedDB
 * 4. Export fetchOlderMessages() for scroll-triggered history pagination
 */

import { useEffect, useRef, useState } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useMessageStore, type ChatMessage } from '@/stores/messageStore'
import { subscribeToRelays } from '@/lib/nostr/relay-pool'
import { buildRelayIndex } from '@/lib/nostr/buildRelayIndex'
import { KINDS, STANDARD_KINDS } from '@/lib/crypto/constants'
import {
  loadCachedMessagesForHub,
  loadRemainingCachedMessagesProgressive,
  pruneAll,
} from '@/lib/cache/messageCache'
// cacheMessageIfVerified / filterCacheable gate the durable cache write on stage-2 identity verification
// (v2), so an outsider's junk (garbage identity tag that passes the cheap presence check) never hits IndexedDB.
import { cacheMessageIfVerified, filterCacheable, channelKeyFromStore } from '@/lib/hub/verifyMessageForCache'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import { usePollStore, parsePollEvent, parseVoteEvent } from '@/stores/pollStore'
import { useCalendarStore, parseCalendarEvent, parseCalendarRsvp } from '@/stores/calendarStore'
import { processHideEvent } from '@/hooks/useHideMessages'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUserStore } from '@/stores/userStore'
import { canReceiveChannelNotification } from '@/lib/hub/permissions'
import { aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { isV2 } from '@/lib/hub/version'
import { resolveMemberPubkey } from '@/lib/hub/resolveMemberPubkey'
import { nip19 } from 'nostr-tools'
import { playSoundEffect } from '@/lib/voice/soundEffects'


import type { Event } from 'nostr-tools'

/** Unix timestamp (seconds) of when this session started — sounds only play for messages after this */
const sessionStartTime = Math.floor(Date.now() / 1000)

/**
 * Play the 'message' sound effect if allowed by the hub's mute settings.
 * Checks the per-hub HubMuteSettings to determine whether this message type
 * should trigger a sound.
 * Only plays for messages created after the current session started.
 */
function playMessageSoundIfAllowed(
  hubDTag: string,
  mentionType: 'personal' | 'everyone' | 'here' | 'role' | undefined,
  createdAt: number
) {
  // Only play sounds for messages that arrived after this session started
  if (createdAt < sessionStartTime) return

  const muteSettings = useNotificationStore.getState().hubMuteSettings[hubDTag]
  if (!muteSettings) {
    // No mute settings — play sound
    playSoundEffect('message')
    return
  }

  // Master mute — suppress all
  if (muteSettings.all) return

  // Check specific mute flags based on mention type
  if (!mentionType) {
    // Normal message — check 'normal' mute flag
    if (muteSettings.normal) return
  } else if (mentionType === 'personal') {
    if (muteSettings.mentions) return
  } else if (mentionType === 'everyone') {
    if (muteSettings.everyone) return
  } else if (mentionType === 'here') {
    if (muteSettings.here) return
  } else if (mentionType === 'role') {
    if (muteSettings.roles) return
  }

  playSoundEffect('message')
}

/** Number of messages to fetch on initial load */
const INITIAL_LIMIT = 50

/** Number of messages to fetch per history page */
export const PAGE_SIZE = 50

/** Parse a raw Nostr event into a ChatMessage */
function parseMessage(event: Event): ChatMessage | null {
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
  const hubDTag = event.tags.find((t) => t[0] === 'h')?.[1]
  const channelId = event.tags.find((t) => t[0] === 'c')?.[1]
  const epochStr = event.tags.find((t) => t[0] === 'epoch')?.[1]
  const replyTag = event.tags.find((t) => t[0] === 'a' && t[3] === 'reply')
    || event.tags.find((t) => t[0] === 'e' && t[3] === 'reply')
  const rootTag = event.tags.find((t) => t[0] === 'a' && t[3] === 'root')
    || event.tags.find((t) => t[0] === 'e' && t[3] === 'root')
  const deletedTag = event.tags.find((t) => t[0] === 'deleted')
  const threadTag = event.tags.find((t) => t[0] === 'thread')
  const clientTagVal = event.tags.find((t) => t[0] === 'client')?.[1]
  const facilitatorTag = event.tags.find((t) => t[0] === 'facilitator')?.[1]
  const forumTag = event.tags.find((t) => t[0] === 'forum')
  const expirationTag = event.tags.find((t) => t[0] === 'expiration')?.[1]
  const expiration = expirationTag ? (parseInt(expirationTag, 10) || undefined) : undefined

  if (!dTag || !hubDTag || !channelId) return null

  // Disappearing messages: an already-expired event must never enter the store or
  // cache. Returning null here is the single ingest guard — every parseMessage
  // caller (live, history, edit-hint, context) already skips a null result.
  if (expiration && expiration <= Math.floor(Date.now() / 1000)) return null

  // v2 identity drop rule — stage 1 (cheap plaintext presence, NIP-CHAT §0.1).
  // In a v2 hub an event without an `identity` tag is not a valid member event
  // (anonymous spam, or a legacy v1 message from an old client) — drop it before
  // store/cache. Stage 2 (verifying sig_R over the event) runs in the async
  // display path, which holds the channel key. Guarded on the hub being loaded so
  // pre-hub-load ingest isn't blocked (such events are re-filtered on display).
  const hubForDrop = useHubStore.getState().hubs[hubDTag]
  if (hubForDrop && isV2(hubForDrop) && !event.tags.some((t) => t[0] === 'identity')) return null

  return {
    id: event.id,
    dTag,
    hubDTag,
    channelId,
    pubkey: event.pubkey,
    content: event.content,
    // Use published_at for ordering if present (edited messages preserve original time),
    // otherwise fall back to created_at (unedited messages)
    createdAt: parseInt(event.tags.find((t) => t[0] === 'published_at')?.[1] || '', 10) || event.created_at,
    eventCreatedAt: event.created_at, // actual event timestamp for replacement comparison
    epoch: epochStr ? parseInt(epochStr, 10) : 0,
    replyTo: replyTag?.[1],
    rootRef: rootTag?.[1],
    deleted: !!deletedTag,
    isThread: !!threadTag,
    isForum: !!forumTag,
    rawEvent: JSON.stringify(event),
    clientTag: clientTagVal,
    facilitator: facilitatorTag,
    expiration,
  }
}

/**
 * Fetch older messages for a specific hub+channel for history pagination.
 * Queries relays for messages created before `untilTimestamp` with limit: PAGE_SIZE.
 * Returns a promise that resolves with the count of messages received.
 */
export function fetchOlderMessages(
  hubDTag: string,
  channelId: string,
  untilTimestamp: number
): Promise<number> {
  const hubs = useHubStore.getState().hubs
  const hub = hubs[hubDTag]
  if (!hub) return Promise.resolve(0)

  const addMessage = useMessageStore.getState().addMessage
  const minPow = hub.minPow || 0

  // Collect relays for this hub
  const relays = [...new Set(hub.generalRelays)].filter(Boolean)
  if (relays.length === 0) return Promise.resolve(0)

  return new Promise((resolve) => {
    let count = 0
    const sub = subscribeToRelays(
      relays,
      {
        kinds: [KINDS.MESSAGE],
        '#h': [hubDTag],
        '#c': [channelId],
        until: untilTimestamp,
        limit: PAGE_SIZE,
      },
      (event: Event) => {
        const msg = parseMessage(event)
        if (!msg) return

        // Validate PoW
        if (minPow > 0 && countLeadingZeroBits(event.id) < minPow) return

        addMessage(msg)
        cacheMessageIfVerified(msg).catch(() => {})
        count++
      },
      () => {
        // EOSE — all stored events received, close the subscription
        sub.close()
        console.log(`[HubSubs] History fetch complete: ${count} messages (until: ${new Date(untilTimestamp * 1000).toISOString()})`)
        resolve(count)
      }
    )

    // Safety timeout — resolve after 15s even if EOSE never fires
    setTimeout(() => {
      sub.close()
      resolve(count)
    }, 15000)
  })
}

/**
 * Fetch the latest messages for a specific hub+channel on channel open.
 * Called when the user opens a channel that has no (or few) messages in the store,
 * because the hub-wide initial fetch (limit: 50 across ALL channels) may have
 * returned zero messages for this particular channel.
 *
 * Uses '#c' to narrow the fetch to a single channel.
 * Returns a promise that resolves with the count of messages received.
 */
export function fetchChannelLatest(
  hubDTag: string,
  channelId: string
): Promise<number> {
  const hubs = useHubStore.getState().hubs
  const hub = hubs[hubDTag]
  if (!hub) return Promise.resolve(0)

  const addMessage = useMessageStore.getState().addMessage
  const minPow = hub.minPow || 0

  const relays = [...new Set(hub.generalRelays)].filter(Boolean)
  if (relays.length === 0) return Promise.resolve(0)

  return new Promise((resolve) => {
    let count = 0
    const sub = subscribeToRelays(
      relays,
      {
        kinds: [KINDS.MESSAGE],
        '#h': [hubDTag],
        '#c': [channelId],
        limit: INITIAL_LIMIT,
      },
      (event: Event) => {
        const msg = parseMessage(event)
        if (!msg) return

        if (minPow > 0 && countLeadingZeroBits(event.id) < minPow) return

        addMessage(msg)
        cacheMessageIfVerified(msg).catch(() => {})
        count++
      },
      () => {
        sub.close()
        console.log(`[HubSubs] Channel fetch complete: ${count} messages for channel ${channelId}`)
        resolve(count)
      }
    )

    // Safety timeout
    setTimeout(() => {
      sub.close()
      resolve(count)
    }, 15000)
  })
}

/**
 * Fetch messages that mention the current user, across all channels of a hub.
 * Runs once per hub on subscription setup — catches @mentions the user missed
 * while offline. Uses relay-queryable p tags (individual) and M tags (group).
 *
 * @param hubDTag - Hub d-tag
 * @param myPubkey - Current user's hex pubkey
 * @param myRoleIds - Role IDs the current user holds (for role mention matching)
 * @param sinceTimestamp - Only fetch mentions newer than this (typically lastRead)
 */
export function fetchMentionsCatchUp(
  hubDTag: string,
  myPubkey: string,
  myRoleIds: string[],
  sinceTimestamp: number
): Promise<number> {
  const hubs = useHubStore.getState().hubs
  const hub = hubs[hubDTag]
  if (!hub) return Promise.resolve(0)

  const addMessage = useMessageStore.getState().addMessage
  const minPow = hub.minPow || 0

  const relays = [...new Set(hub.generalRelays)].filter(Boolean)
  if (relays.length === 0) return Promise.resolve(0)

  let count = 0
  const handleEvent = (event: Event) => {
    // Skip own messages (resolve wire P → R on v2; see isOwnHubEvent)
    if (isOwnHubEvent(event.pubkey, hubDTag, myPubkey)) return
    const msg = parseMessage(event)
    if (!msg) return
    if (minPow > 0 && countLeadingZeroBits(event.id) < minPow) return
    addMessage(msg)
    cacheMessageIfVerified(msg).catch(() => {})
    count++
  }

  // Build two one-shot subscriptions:
  // 1. Direct mentions: messages with a p tag matching our pubkey.
  //    v2: SKIP — a `{#h, #p:[R]}` filter would tell the relay our real key `R` is tied to this
  //    private hub (a leak), and v2 messages carry no plaintext `p:R` mention tags anyway (personal
  //    mentions are detected from decrypted content). The hub-wide subscription still delivers them.
  const hubIsV2 = isV2(useHubStore.getState().hubs[hubDTag])
  const directPromise = hubIsV2 ? Promise.resolve() : new Promise<void>((resolve) => {
    const sub = subscribeToRelays(
      relays,
      {
        kinds: [KINDS.MESSAGE],
        '#h': [hubDTag],
        '#p': [myPubkey],
        since: sinceTimestamp,
        limit: 100,
      },
      handleEvent,
      () => { sub.close(); resolve() }
    )
    setTimeout(() => { sub.close(); resolve() }, 15000)
  })

  // 2. Group mentions: messages with M tag matching @all, @here, or user's roles
  const mTagValues = ['all', 'here', ...myRoleIds.map(id => `role:${id}`)]
  const groupPromise = new Promise<void>((resolve) => {
    const sub = subscribeToRelays(
      relays,
      {
        kinds: [KINDS.MESSAGE],
        '#h': [hubDTag],
        '#M': mTagValues,
        since: sinceTimestamp,
        limit: 100,
      },
      handleEvent,
      () => { sub.close(); resolve() }
    )
    setTimeout(() => { sub.close(); resolve() }, 15000)
  })

  return Promise.all([directPromise, groupPromise]).then(() => {
    if (count > 0) {
      console.log(`[HubSubs] Mention catch-up: ${count} mention(s) for hub ${hubDTag} since ${new Date(sinceTimestamp * 1000).toISOString()}`)
    }
    return count
  })
}

/**
 * Fetch newer messages for a specific hub+channel (scroll-down in time-travel).
 * Queries relays for messages created after `sinceTimestamp` with limit: PAGE_SIZE.
 * Adds to message store. Returns count of messages received.
 */
export function fetchNewerMessages(
  hubDTag: string,
  channelId: string,
  sinceTimestamp: number
): Promise<number> {
  const hubs = useHubStore.getState().hubs
  const hub = hubs[hubDTag]
  if (!hub) return Promise.resolve(0)

  const addMessage = useMessageStore.getState().addMessage
  const minPow = hub.minPow || 0

  const relays = [...new Set(hub.generalRelays)].filter(Boolean)
  if (relays.length === 0) return Promise.resolve(0)

  return new Promise((resolve) => {
    let count = 0
    const sub = subscribeToRelays(
      relays,
      {
        kinds: [KINDS.MESSAGE],
        '#h': [hubDTag],
        '#c': [channelId],
        since: sinceTimestamp,
        limit: PAGE_SIZE,
      },
      (event: Event) => {
        const msg = parseMessage(event)
        if (!msg) return
        if (minPow > 0 && countLeadingZeroBits(event.id) < minPow) return

        addMessage(msg)
        cacheMessageIfVerified(msg).catch(() => {})
        count++
      },
      () => {
        sub.close()
        console.log(`[HubSubs] Newer fetch complete: ${count} messages (since: ${new Date(sinceTimestamp * 1000).toISOString()})`)
        resolve(count)
      }
    )

    setTimeout(() => {
      sub.close()
      resolve(count)
    }, 15000)
  })
}

/** Context window size — quarter of PAGE_SIZE on each side */
export const CONTEXT_SIZE = Math.ceil(PAGE_SIZE / 4)

/**
 * Fetch a single message by its a-tag reference (e.g. "36943:pubkey:dTag").
 * Used to populate reply preview cache for old referenced messages.
 * Returns the raw ChatMessage (unencrypted store format) or null.
 */
export function fetchSingleMessage(
  hubDTag: string,
  aTagRef: string
): Promise<ChatMessage | null> {
  const hubs = useHubStore.getState().hubs
  const hub = hubs[hubDTag]
  if (!hub) return Promise.resolve(null)

  // Parse a-tag: "36943:pubkey:dTag"
  const parts = aTagRef.split(':')
  if (parts.length < 3) return Promise.resolve(null)
  const refPubkey = parts[1]
  const refDTag = parts.slice(2).join(':')

  const relays = [...new Set(hub.generalRelays)].filter(Boolean)
  if (relays.length === 0) return Promise.resolve(null)

  return new Promise((resolve) => {
    let found: ChatMessage | null = null
    const sub = subscribeToRelays(
      relays,
      {
        kinds: [KINDS.MESSAGE],
        authors: [refPubkey],
        '#d': [refDTag],
        limit: 1,
      },
      (event: Event) => {
        const msg = parseMessage(event)
        if (msg) {
          found = msg
          // Also add to store so it's available for context
          useMessageStore.getState().addMessage(msg)
          cacheMessageIfVerified(msg).catch(() => {})
        }
      },
      () => {
        sub.close()
        resolve(found)
      }
    )

    setTimeout(() => {
      sub.close()
      resolve(found)
    }, 10000)
  })
}

/**
 * Fetch a context window of messages around a target timestamp.
 * Loads CONTEXT_SIZE messages before + CONTEXT_SIZE messages after.
 * All messages are added to the message store.
 * Returns the count of total messages fetched.
 */
export function fetchMessageContext(
  hubDTag: string,
  channelId: string,
  targetTimestamp: number
): Promise<number> {
  const hubs = useHubStore.getState().hubs
  const hub = hubs[hubDTag]
  if (!hub) return Promise.resolve(0)

  const addMessage = useMessageStore.getState().addMessage
  const minPow = hub.minPow || 0
  const relays = [...new Set(hub.generalRelays)].filter(Boolean)
  if (relays.length === 0) return Promise.resolve(0)

  const fetchDirection = (filter: any): Promise<number> => {
    return new Promise((resolve) => {
      let count = 0
      const sub = subscribeToRelays(
        relays,
        filter,
        (event: Event) => {
          const msg = parseMessage(event)
          if (!msg) return
          if (minPow > 0 && countLeadingZeroBits(event.id) < minPow) return
          addMessage(msg)
          cacheMessageIfVerified(msg).catch(() => {})
          count++
        },
        () => {
          sub.close()
          resolve(count)
        }
      )
      setTimeout(() => { sub.close(); resolve(count) }, 10000)
    })
  }

  // Fetch before + after in parallel
  return Promise.all([
    fetchDirection({
      kinds: [KINDS.MESSAGE],
      '#h': [hubDTag],
      '#c': [channelId],
      until: targetTimestamp + 1,
      limit: CONTEXT_SIZE,
    }),
    fetchDirection({
      kinds: [KINDS.MESSAGE],
      '#h': [hubDTag],
      '#c': [channelId],
      since: targetTimestamp - 1,
      limit: CONTEXT_SIZE,
    }),
  ]).then(([before, after]) => {
    console.log(`[HubSubs] Context fetch: ${before} before + ${after} after target ${new Date(targetTimestamp * 1000).toISOString()}`)
    return before + after
  })
}

/**
 * Process a kind 7 reaction event — store raw data in messageStore.
 * Decryption happens lazily at render time (like messages) so reactions
 * work regardless of when hub secrets become available.
 */
function processReactionEvent(event: Event) {
  const store = useMessageStore.getState()

  // Dedup — skip if already processed
  if (!store.markReactionProcessed(event.id)) return

  const hubDTag = event.tags.find((t) => t[0] === 'h')?.[1]
  const channelId = event.tags.find((t) => t[0] === 'c')?.[1]
  const targetEventId = event.tags.find((t) => t[0] === 'e')?.[1]
  const deletedTag = event.tags.find((t) => t[0] === 'deleted')

  if (!hubDTag || !channelId || !targetEventId) return

  // If deleted, remove all reactions from this pubkey on this message
  if (deletedTag) {
    const existing = store.reactions[hubDTag]?.[targetEventId] || []
    for (const r of existing) {
      if (r.pubkey === event.pubkey) {
        store.removeReaction(hubDTag, targetEventId, r.emoji, event.pubkey)
      }
    }
    return
  }

  if (!event.content) return

  // Store raw encrypted content — decryption happens at render time
  const emojiTag = event.tags.find((t) => t[0] === 'emoji' && t[1] && t[2])
  const identityTag = event.tags.find((t) => t[0] === 'identity')?.[1] // v2: reactor's real key, decoded lazily
  const reactionEpoch = parseInt(event.tags.find((t) => t[0] === 'epoch')?.[1] || '1', 10)
  store.addReaction(hubDTag, targetEventId, {
    emoji: event.content, // encrypted — will be decrypted at render
    pubkey: event.pubkey,
    eventId: event.id,
    createdAt: event.created_at,
    epoch: reactionEpoch, // the epoch this reaction was encrypted under (may predate the current one)
    rawContent: event.content,
    rawEmojiTag: emojiTag ? [emojiTag[1], emojiTag[2]] : undefined,
    identityTag,
    rawEvent: JSON.stringify(event),
    decrypted: false,
  })
}

/**
 * Handle an ephemeral edit hint event (kind 26943).
 * Verifies the sender is a hub member, then re-fetches the edited message
 * from relays and updates the local store.
 */
function handleEditHint(event: Event) {
  const hubDTag = event.tags.find((t) => t[0] === 'h')?.[1]
  const messageDTag = event.tags.find((t) => t[0] === 'd')?.[1]
  // Prefer explicit p tag; fall back to event.pubkey (hint sender = message author,
  // since you can only edit your own messages). Some signers (nostr-sdk) drop the p tag.
  const authorPubkey = event.tags.find((t) => t[0] === 'p')?.[1] || event.pubkey

  if (!hubDTag || !messageDTag || !authorPubkey) return

  // Ignore own edit hints — we already have the optimistic update
  const myPubkey = useUserStore.getState().pubkey
  if (event.pubkey === myPubkey) return

  // Verify sender is a hub member (prevents amplification from non-members). The event author is the
  // on-wire key — real key R in v1 (= m.pubkey), pseudonym P in v2 (= m.p) — so match EITHER field,
  // else every v2 member's edit/delete hint is dropped and other clients never refresh on edit.
  const members = useHubStore.getState().hubMembers[hubDTag]
  if (members && members.length > 0 && !members.some((m) => m.pubkey === event.pubkey || m.p === event.pubkey)) return

  // Check if we already have a newer version locally
  const channelId = event.tags.find((t) => t[0] === 'c')?.[1]
  let existingEventTs = 0
  const existingMsgs = useMessageStore.getState().messages[hubDTag]
  if (existingMsgs) {
    if (channelId && existingMsgs[channelId]) {
      // Fast path: channel tag narrows the search
      const match = existingMsgs[channelId].find((m) => m.dTag === messageDTag && m.pubkey === authorPubkey)
      if (match) existingEventTs = match.eventCreatedAt || match.createdAt
    } else {
      // Slow path: scan all channels
      for (const channelMsgs of Object.values(existingMsgs)) {
        const match = channelMsgs.find((m) => m.dTag === messageDTag && m.pubkey === authorPubkey)
        if (match) {
          existingEventTs = match.eventCreatedAt || match.createdAt
          break
        }
      }
    }
  }

  // Fetch the latest version from relays
  const hub = useHubStore.getState().hubs[hubDTag]
  if (!hub) return
  const relays = [...new Set(hub.generalRelays)].filter(Boolean)
  if (relays.length === 0) return

  console.log(`[EditHint] Received for dTag=${messageDTag.slice(0, 12)}… from ${event.pubkey.slice(0, 12)}…, fetching latest version`)

  const sub = subscribeToRelays(
    relays,
    {
      kinds: [KINDS.MESSAGE],
      authors: [authorPubkey],
      '#d': [messageDTag],
      limit: 1,
    },
    (fetchedEvent: Event) => {
      // Only update if fetched version is newer than what we have
      if (fetchedEvent.created_at > existingEventTs) {
        const msg = parseMessage(fetchedEvent)
        if (msg) {
          useMessageStore.getState().addMessage(msg)
          cacheMessageIfVerified(msg).catch(() => {})
          console.log(`[EditHint] Updated message dTag=${messageDTag.slice(0, 12)}… (new created_at=${fetchedEvent.created_at})`)
        }
      }
    },
    () => {
      sub.close()
    }
  )

  // Safety timeout
  setTimeout(() => sub.close(), 10000)
}

/**
 * Attempt to decrypt message content and detect mention type.
 * Returns the highest-priority mention type found, or undefined for normal messages.
 *
 * Priority: personal > everyone > here > role > (none)
 *
 * This is async because AES-GCM decryption uses SubtleCrypto.
 * Callers should catch errors gracefully — if the key isn't available yet
 * (secret not loaded, wrong epoch) the message is treated as a normal message.
 */
type MentionKind = 'personal' | 'everyone' | 'here' | 'role'

/**
 * Whether a hub event's WIRE author is the current user. On v2 the wire key is our per-hub pseudonym
 * `P` (never our real key `R`), so a naive `event.pubkey === myPubkey` never matches and our own v2
 * messages wrongly drive self-notifications (phantom unread badges + sound, and — on offline catch-up —
 * our own @everyone/@here/@role counted as a mention). Resolve the wire key to `R` via the roster
 * (`m.p === P → m.pubkey`) and compare. `resolveMemberPubkey` is a no-op on v1 (wire key already IS R),
 * so this is correct for both. Best-effort: if the roster isn't loaded yet the resolve falls back to the
 * wire key and suppression re-tightens once it loads.
 */
function isOwnHubEvent(wirePubkey: string, hubDTag: string, myPubkey: string | null): boolean {
  if (!myPubkey) return false
  if (wirePubkey === myPubkey) return true
  return resolveMemberPubkey(wirePubkey, useHubStore.getState().hubMembers[hubDTag]) === myPubkey
}

/**
 * Try to decrypt a message and classify its mention type. Returns whether we could
 * actually read it — `decrypted: false` means we lack the key (restricted channel,
 * epoch not synced yet, secret still loading), so it isn't shown in chat and must NOT
 * drive a notification. Never throws.
 */
async function detectMentionType(
  hubDTag: string,
  channelId: string,
  epoch: number,
  encryptedContent: string,
  senderPubkey: string
): Promise<{ decrypted: boolean; mentionType?: MentionKind }> {
  // Don't scan our own messages (resolve wire P → R on v2; see isOwnHubEvent)
  const myPubkey = useUserStore.getState().pubkey
  if (!myPubkey || isOwnHubEvent(senderPubkey, hubDTag, myPubkey)) return { decrypted: false }

  // Resolve the channel key the SAME way the display path does — via channelKeyFromStore, which handles
  // GROUP-encrypted channels (group secret, not the hub-wide secret) AND epoch-history (a message from a
  // pre-rotation epoch). Deriving from `hubSecrets` alone (as this used to) produced the WRONG key for any
  // group channel or historical epoch → aesDecrypt threw → the message was silently treated as unreadable,
  // suppressing its unread badge / sound / @mention (on v2, personal mentions live only in the decrypted
  // content, so they were lost entirely).
  const channelKey = channelKeyFromStore(hubDTag, channelId, epoch)
  if (!channelKey) return { decrypted: false } // key not loaded / no access — can't decrypt
  let plaintext: string
  try {
    plaintext = await aesDecrypt(channelKey, encryptedContent)
  } catch {
    return { decrypted: false } // wrong/absent key, restricted channel, epoch mismatch
  }

  // Check for personal mention (nostr:npub1..., @npub1...)
  const myNpub = nip19.npubEncode(myPubkey)
  if (plaintext.includes(myNpub) || plaintext.includes(`nostr:${myNpub}`)) {
    return { decrypted: true, mentionType: 'personal' }
  }

  // Check for @everyone
  if (plaintext.includes('@everyone')) return { decrypted: true, mentionType: 'everyone' }

  // Check for @here
  if (plaintext.includes('@here')) return { decrypted: true, mentionType: 'here' }

  // Check for @role mentions — scan hub role names
  const hub = useHubStore.getState().hubs[hubDTag]
  if (hub?.roles?.length) {
    for (const role of hub.roles) {
      if (role.name && plaintext.includes(`@${role.name}`)) return { decrypted: true, mentionType: 'role' }
    }
  }

  return { decrypted: true } // decrypted, no special mention → normal message
}

export function useHubSubscriptions() {
  const hubs = useHubStore((s) => s.hubs)
  const hubListLoaded = useHubStore((s) => s.hubListLoaded)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const activeChannelId = useHubStore((s) => s.activeChannelId)
  // Bumps when any hub/group/epoch secret loads — drives the cold-start unread backfill below.
  const secretsVersion = useHubStore((s) => s._secretsVersion ?? 0)
  const addMessage = useMessageStore((s) => s.addMessage)
  const incrementUnread = useMessageStore((s) => s.incrementUnread)

  // Refs for frequently-changing values — avoids re-creating subscriptions
  const activeHubIdRef = useRef(activeHubId)
  activeHubIdRef.current = activeHubId

  const activeChannelIdRef = useRef(activeChannelId)
  activeChannelIdRef.current = activeChannelId

  const addMessageRef = useRef(addMessage)
  addMessageRef.current = addMessage

  const incrementUnreadRef = useRef(incrementUnread)
  incrementUnreadRef.current = incrementUnread

  // Ref for hubs to access minPow without triggering re-subscriptions
  const hubsRef = useRef(hubs)
  hubsRef.current = hubs

  // Track active subscriptions for cleanup
  const subsRef = useRef<{ close: () => void }[]>([])

  // Stable fingerprint of hub relay config to detect changes
  const hubFingerprintRef = useRef('')

  // Dedup set — persists across reconnections to prevent double-counting
  // when visibility-change triggers a re-subscription and the initial fetch
  // re-delivers events we've already counted as unread
  const processedMsgIdsRef = useRef(new Set<string>())

  // Whether cache has been loaded
  const cacheLoadedRef = useRef(false)

  // ── Cold-start unread backfill ──
  // The live handler only increments unread for a DECRYPTABLE message (canReceiveChannelNotification +
  // detectMentionType both need the hub secret). On startup the secret loads asynchronously, so a backlog
  // received while offline is processed BEFORE the secret lands → skipped, and (already in processedMsgIds)
  // never re-counted → no badge / no channel dot. When a secret becomes available (secretsVersion bumps),
  // recompute each accessible channel's unread from the already-loaded store messages and RAISE the count
  // (a member can read everything in an accessible channel, so anything newer than lastRead and not our own
  // is unread). RAISE (max) is race-free vs the live handler; mentions stay owned by the reclassifier.
  useEffect(() => {
    const myPubkey = useUserStore.getState().pubkey
    if (!myPubkey) return
    const { hubs: allHubs, hubSecrets } = useHubStore.getState()
    const messagesByHub = useMessageStore.getState().messages
    const notif = useNotificationStore.getState()
    const activeHub = activeHubIdRef.current
    const activeChannel = activeChannelIdRef.current
    for (const hubDTag of Object.keys(allHubs)) {
      if (!hubSecrets[hubDTag]) continue // secret not loaded yet → nothing to backfill (re-runs on next bump)
      const channels = messagesByHub[hubDTag]
      if (!channels) continue
      const hub = allHubs[hubDTag]
      const perChannel: Record<string, number> = {}
      for (const [channelId, msgs] of Object.entries(channels)) {
        if (hubDTag === activeHub && channelId === activeChannel) continue // currently viewing → don't badge
        if (!canReceiveChannelNotification(hubDTag, channelId, myPubkey)) continue
        const lastRead = notif.hubUnreads[hubDTag]?.[channelId]?.lastRead ?? 0
        const targetChannel = hub?.channels?.find((c) => c.channelId === channelId)
        const isForum = targetChannel?.type === 'forum'
        let count = 0
        for (const m of msgs) {
          if (m.deleted) continue
          if (m.createdAt <= lastRead) continue
          if (isForum && !m.isForum) continue // forum: only top-level posts count as unread
          if (isOwnHubEvent(m.pubkey, hubDTag, myPubkey)) continue
          count++
        }
        if (count > 0) perChannel[channelId] = count
      }
      if (Object.keys(perChannel).length > 0) notif.raiseHubUnreadCounts(hubDTag, perChannel)
    }
  }, [secretsVersion])

  // Load cached messages from IndexedDB on startup (progressive: active hub first)
  useEffect(() => {
    if (cacheLoadedRef.current) return
    cacheLoadedRef.current = true

    const ingestCached = (cached: import('@/stores/messageStore').ChatMessage[]) => {
      const nowSec = Math.floor(Date.now() / 1000)
      for (const msg of cached) {
        const hub = hubsRef.current[msg.hubDTag]
        const minPow = hub?.minPow || 0
        if (minPow > 0 && countLeadingZeroBits(msg.id) < minPow) continue
        // Disappearing messages: don't load an already-expired cached message into
        // the store (pruneAll physically removes it from IndexedDB separately).
        if (msg.expiration && msg.expiration <= nowSec) continue
        addMessageRef.current(msg)
      }
    }

    // Phase 1: Load active hub first (fast, indexed read)
    const activeHub = localStorage.getItem('den_last_active_hub')
    const loadedHubs = new Set<string>()

    const loadActiveFirst = async () => {
      if (activeHub) {
        const activeCached = await loadCachedMessagesForHub(activeHub)
        if (activeCached.length > 0) {
          console.log(`[HubSubs] Cache phase 1: ${activeCached.length} messages for active hub ${activeHub.slice(0, 8)}…`)
          ingestCached(activeCached)
          loadedHubs.add(activeHub)
        }
      }

      // Phase 2: Load remaining hubs progressively in the background
      // Reads 5 hubs at a time via by_hub index, yields between chunks
      setTimeout(async () => {
        try {
          const allHubDTags = Object.keys(hubsRef.current)
          const totalLoaded = await loadRemainingCachedMessagesProgressive(
            loadedHubs,
            allHubDTags,
            (chunkMsgs) => ingestCached(chunkMsgs),
          )
          if (totalLoaded > 0) {
            console.log(`[HubSubs] Cache phase 2: ${totalLoaded} messages across remaining hubs (progressive)`)
          }
        } catch (err) {
          console.warn('[HubSubs] Failed to load remaining cached messages:', err)
        }
      }, 50)
    }

    loadActiveFirst().catch((err) => {
      console.warn('[HubSubs] Failed to load active hub cache:', err)
    })
  }, [])

  // Re-subscribe when tab becomes visible (browsers drop WebSockets in background)
  // Also periodically force-reconnect every 5 minutes to catch silently dead
  // WebSocket connections — especially on Tauri desktop where the tab is always
  // "visible" and the visibilitychange handler never fires.
  const RECONNECT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
  const [reconnectCount, setReconnectCount] = useState(0)
  useEffect(() => {
    const forceReconnect = () => {
      hubFingerprintRef.current = ''
      setReconnectCount((c) => c + 1)
    }

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        forceReconnect()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    // Periodic keepalive — catches dead subscriptions even when tab stays visible
    const intervalId = setInterval(forceReconnect, RECONNECT_INTERVAL_MS)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    const hubKeys = Object.keys(hubs)

    // No hubs to watch — the hub list hasn't loaded yet, or the account was cleared
    // (logout / account switch empties the hub store). If we had live subscriptions,
    // close them so the previous account stops receiving messages — otherwise those
    // sockets keep firing and produce ghost notifications after switching accounts —
    // and clear the fingerprint so a fresh login re-subscribes from scratch.
    if (!hubListLoaded || hubKeys.length === 0) {
      if (subsRef.current.length > 0) {
        for (const sub of subsRef.current) sub.close()
        subsRef.current = []
        hubFingerprintRef.current = ''
      }
      return
    }

    // Build a fingerprint to detect relay config changes
    const fingerprint = hubKeys
      .sort()
      .map((k) => {
        const h = hubs[k]
        return `${k}:${h.generalRelays.join(',')}`
      })
      .join('|')

    // Skip if nothing changed
    if (fingerprint === hubFingerprintRef.current) return
    hubFingerprintRef.current = fingerprint

    // Tear down old subscriptions
    for (const sub of subsRef.current) {
      sub.close()
    }
    subsRef.current = []

    // Build relay → hubDTags index (chunked at 50)
    const batches = buildRelayIndex(hubs)

    if (batches.length === 0) return

    const now = Math.floor(Date.now() / 1000)

    console.log(
      `[HubSubs] Creating ${batches.length * 2} subscription(s) across ${new Set(batches.map((b) => b.relay)).size} relay(s) for ${hubKeys.length} hub(s) (initial: limit ${INITIAL_LIMIT}, real-time: since now)`
    )

    // Prune old cache entries (size-based only now)
    pruneAll(hubKeys).catch(() => {})

    // Use the persistent dedup set (survives reconnections from tab visibility changes)
    const processedMsgIds = processedMsgIdsRef.current

    // Event handler factory — creates a handler that optionally buffers cache writes
    // instead of writing each event individually to IndexedDB.
    // Initial fetch: buffer=true → collect messages, flush in bulk at EOSE (1 transaction)
    // Real-time:     buffer=false → write-through per event (infrequent, no queue stall)
    const createEventHandler = (buffer: ChatMessage[] | null) => (event: Event) => {
      // Route poll events to pollStore
      if (event.kind === KINDS.POLL) {
        const poll = parsePollEvent(event)
        if (poll) {
          // On v2, every legit poll carries an identity attestation (signHubMemberEvent). Drop a tagless
          // one at ingest — it's unattributable and could be a forged poll from an unauthorized member
          // under a throwaway key (the create_polls timeline gate resolves the wire key P, which for a
          // throwaway falls open to the `everyone` role). Mirrors the message/reaction drop-rule.
          const pollHub = useHubStore.getState().hubs[poll.hubDTag]
          if (pollHub && isV2(pollHub) && !event.tags.some((t) => t[0] === 'identity')) return
          usePollStore.getState().addPoll(poll)
        }
        return
      }

      // Route vote events to pollStore (real-time only)
      if (event.kind === KINDS.POLL_VOTE) {
        const vote = parseVoteEvent(event)
        if (vote) usePollStore.getState().addVote(vote)
        return
      }

      // Route kind 7 reaction events
      if (event.kind === STANDARD_KINDS.REACTION) {
        processReactionEvent(event)
        return
      }

      // Route calendar events to calendarStore
      if (event.kind === KINDS.CALENDAR_TIME_EVENT) {
        const calEvent = parseCalendarEvent(event)
        if (calEvent) useCalendarStore.getState().addEvent(calEvent)
        return
      }

      // Route calendar RSVPs to calendarStore
      if (event.kind === KINDS.CALENDAR_RSVP) {
        const rsvp = parseCalendarRsvp(event)
        if (rsvp) useCalendarStore.getState().addRsvp(rsvp)
        return
      }

      // Route hide message events to hide handler
      if (event.kind === KINDS.HIDE_MESSAGE) {
        const hTag = event.tags.find((t: string[]) => t[0] === 'h')?.[1]
        if (hTag) processHideEvent(event, hTag)
        return
      }

      // Route edit hint events — re-fetch the edited message from relays
      if (event.kind === KINDS.MESSAGE_EDIT_HINT) {
        handleEditHint(event)
        return
      }

      const msg = parseMessage(event)
      if (!msg) return

      // Validate PoW — reject messages that don't meet hub difficulty
      const hub = hubsRef.current[msg.hubDTag]
      const minPow = hub?.minPow || 0
      if (minPow > 0 && countLeadingZeroBits(event.id) < minPow) return

      // Is this a genuinely new message, or a replacement (edit / deletion) of one we
      // already hold? Edits and deletions are re-published as KINDS.MESSAGE events with
      // the same d-tag, so they must NOT ring the "new message" sound or bump unread —
      // even when they slip past the session-start timestamp guard (e.g. a deletion that
      // gets a "now" timestamp because the original wasn't cached locally). Checked here,
      // BEFORE the store add/replace below, so the existence lookup reflects prior state.
      const isReplacement = msg.deleted || !!useMessageStore.getState()
        .messages[msg.hubDTag]?.[msg.channelId]?.some((m) => m.dTag === msg.dTag && m.pubkey === msg.pubkey)

      // Add to in-memory store (messageStore handles its own dedup)
      addMessageRef.current(msg)

      // Cache write: buffer for bulk flush (initial fetch) or write-through (real-time)
      if (buffer) {
        buffer.push(msg)
      } else {
        cacheMessageIfVerified(msg).catch(() => {})
      }

      // Skip unread increment if we already processed this event
      // (prevents double-counting from overlapping initial + real-time subs)
      if (processedMsgIds.has(event.id)) return
      processedMsgIds.add(event.id)

      // For forum-type channels, only count actual forum posts (with [forum] tag)
      // as unread — thread replies and regular messages don't appear as top-level
      // posts in ForumView so counting them inflates the badge
      const targetChannel = hub?.channels?.find((c: any) => c.channelId === msg.channelId)
      if (targetChannel?.type === 'forum' && !msg.isForum) return

      // Increment unread for inactive hubs/channels
      // Fire-and-forget async mention detection — the unread increment
      // still happens immediately; the mention type enriches the badge
      // Skip own messages — they should never count as "unread" (resolve wire P → R on v2)
      const myPubkey = useUserStore.getState().pubkey
      if (isOwnHubEvent(event.pubkey, msg.hubDTag, myPubkey)) return
      if (isReplacement) {
        // Edit/deletion — not a new message: no sound, no unread bump. If it landed in
        // the channel currently being viewed, still advance the read watermark (as the
        // new-message path below does) so it isn't re-counted later.
        if (msg.hubDTag === activeHubIdRef.current && msg.channelId === activeChannelIdRef.current) {
          useNotificationStore.getState().advanceChannelRead(msg.hubDTag, msg.channelId, msg.createdAt)
        }
        return
      }
      if (msg.hubDTag !== activeHubIdRef.current || msg.channelId !== activeChannelIdRef.current) {
        // Permission/membership gate — no unread badge or sound for hubs the user
        // isn't a member of (e.g. a pending join request) or channels they lack
        // access to (view_channel denied / missing group secret). Runs before the
        // decrypt so a view-hidden but hub-encrypted channel never pings.
        if (!myPubkey || !canReceiveChannelNotification(msg.hubDTag, msg.channelId, myPubkey)) return
        // Decrypt + classify. Only notify for a message we could actually read: one we
        // can't decrypt (restricted channel, unsynced epoch, key still loading) isn't
        // shown in chat, so it must not bump unread or ring the sound.
        detectMentionType(msg.hubDTag, msg.channelId, msg.epoch, event.content, event.pubkey)
          .then(({ decrypted, mentionType }) => {
            if (!decrypted) return
            useNotificationStore.getState().incrementChannelUnread(
              msg.hubDTag, msg.channelId, msg.createdAt, mentionType
            )
            // Play message sound if not muted for this hub/mention type
            playMessageSoundIfAllowed(msg.hubDTag, mentionType, msg.createdAt)
            // Also bump the legacy per-hub counter for the old sidebar badge
            if (msg.hubDTag !== activeHubIdRef.current) {
              incrementUnreadRef.current(msg.hubDTag)
            }
          })
          .catch(() => { /* detectMentionType never throws; nothing to do */ })
      } else {
        // Message landed in the channel the user is actively viewing. Advance the
        // read watermark so it isn't re-counted as unread by a later refresh scan
        // (fixes "0 unread while in the hub, then N after leaving").
        useNotificationStore.getState().advanceChannelRead(msg.hubDTag, msg.channelId, msg.createdAt)
      }
    }

    // Create TWO subscriptions per batch:
    for (const batch of batches) {
      // Buffer for initial fetch — flushed to IDB as one bulk transaction at EOSE
      const initialBuffer: ChatMessage[] = []

      // 1. Initial fetch — latest N messages (closes on EOSE)
      const initialSub = subscribeToRelays(
        [batch.relay],
        {
          kinds: [KINDS.MESSAGE, KINDS.POLL, STANDARD_KINDS.REACTION,
                  KINDS.CALENDAR_TIME_EVENT, KINDS.CALENDAR_RSVP, KINDS.HIDE_MESSAGE],
          '#h': batch.hubDTags,
          limit: INITIAL_LIMIT,
        },
        createEventHandler(initialBuffer),
        () => {
          // EOSE: initial history is loaded, close this subscription
          initialSub.close()
          // Flush buffered messages to IndexedDB in a single bulk transaction — but first drop any that
          // aren't cacheable (unverified v2 junk), so an outsider's events don't reach the durable cache.
          if (initialBuffer.length > 0) {
            import('@/lib/cache/messageCache').then(async ({ cacheMessagesWithDedup }) => {
              const verified = await filterCacheable(initialBuffer)
              if (verified.length > 0) cacheMessagesWithDedup(verified).catch(() => {})
            })
          }

          // After initial fetch, run mention catch-up for each hub in this batch.
          // Fetches messages that @-mention the current user (via p/M tags) since
          // their oldest last-read timestamp, so missed mentions surface as unreads.
          //
          // ── Throttled: process 10 hubs at a time with 200ms gaps ──
          // Without throttling, 200 hubs would fire 400 simultaneous subscriptions
          // (2 per hub: direct #p + group #M) which can overwhelm relays.
          const myPubkey = useUserStore.getState().pubkey
          if (myPubkey) {
            const notifState = useNotificationStore.getState()
            const hubMembers = useHubStore.getState().hubMembers

            const MENTION_BATCH_SIZE = 10
            const MENTION_BATCH_DELAY_MS = 200

            // Sort: active hub first so its mentions resolve instantly
            const activeHub = activeHubIdRef.current
            const sortedHubDTags = [...batch.hubDTags].sort((a, b) => {
              if (a === activeHub) return -1
              if (b === activeHub) return 1
              return 0
            })

            const processMentionBatch = async (hubDTags: string[]) => {
              const promises = hubDTags.map((hubDTag) => {
                const member = hubMembers[hubDTag]?.find(m => m.pubkey === myPubkey)
                const roleIds = member?.roles
                  ? member.roles.split('|').filter(Boolean)
                  : []

                const hubUnreads = notifState.hubUnreads[hubDTag]
                let sinceTs = now - 7 * 24 * 60 * 60
                if (hubUnreads) {
                  const readTimes = Object.values(hubUnreads)
                    .map(u => u.lastRead)
                    .filter(t => t > 0)
                  if (readTimes.length > 0) {
                    sinceTs = Math.min(...readTimes)
                  }
                }

                return fetchMentionsCatchUp(hubDTag, myPubkey, roleIds, sinceTs)
                  .then((mentionCount) => {
                    // v2: fetchMentionsCatchUp can only count GROUP (#M) mentions — personal mentions
                    // carry no `#p:[R]` tag to query, so mentionCount misses them. Always run the local
                    // reclassifier scan on v2 (it reads already-fetched store messages and detects
                    // personal mentions by decrypted content below), so pure-personal offline mentions
                    // still surface as unreads.
                    const isV2Hub = isV2(useHubStore.getState().hubs[hubDTag])
                    if (mentionCount > 0 || isV2Hub) {
                      import('@/lib/cache/messageCache').then(async () => {
                        const messages = useMessageStore.getState().messages[hubDTag]
                        if (!messages) return
                        // v2 personal mentions carry NO plaintext `p` tag (it's suppressed for privacy);
                        // the mention lives in the DECRYPTED content as `@npub(myR)`. The store holds
                        // ciphertext (decryption happens in useMessages, never written back), so a raw
                        // `msg.content` scan matches nothing on either version — hub content is always
                        // AES-encrypted. Decrypt via detectMentionType (the exact live `isMentioned` path)
                        // so offline catch-up reclassifies v2 personal mentions too. The structured `#M`
                        // group-mention tag and the v1 `#p` tag need no decryption and are read directly.
                        for (const [channelId, channelMsgs] of Object.entries(messages)) {
                          for (const msg of channelMsgs) {
                            if (msg.createdAt <= sinceTs) continue
                            if (isOwnHubEvent(msg.pubkey, hubDTag, myPubkey)) continue // wire P → R on v2
                            if (!msg.rawEvent) continue
                            try {
                              const raw = JSON.parse(msg.rawEvent)
                              const hasMTag = raw.tags?.some((t: string[]) => {
                                if (t[0] !== 'M') return false
                                if (t[1] === 'all' || t[1] === 'here') return true
                                return roleIds.some(rid => t[1] === `role:${rid}`)
                              })
                              // v1 carries the personal mention as a plaintext `p` tag. v2 suppresses it →
                              // decrypt the content and look for @npub(myR), matching the live path.
                              let hasPersonal = raw.tags?.some((t: string[]) => t[0] === 'p' && t[1] === myPubkey)
                              if (!hasPersonal) {
                                const det = await detectMentionType(hubDTag, channelId, msg.epoch, msg.content, msg.pubkey)
                                if (det.mentionType === 'personal') hasPersonal = true
                              }
                              if (hasPersonal || hasMTag) {
                                // Same permission/membership gate as the live path: never
                                // surface mentions for hubs the user hasn't joined or
                                // channels they can't access.
                                if (!canReceiveChannelNotification(hubDTag, channelId, myPubkey)) continue
                                // Coordinate with the live handler's dedup set so a mention isn't counted
                                // TWICE — once here and once by the initial-fetch subscription. Whichever
                                // reaches the event first records its id; the other skips the increment.
                                // (The set only gates the unread increment, not store/cache insertion.)
                                if (processedMsgIdsRef.current.has(msg.id)) continue
                                processedMsgIdsRef.current.add(msg.id)
                                const mentionType = hasPersonal ? 'personal'
                                  : raw.tags?.some((t: string[]) => t[0] === 'M' && t[1] === 'all') ? 'everyone'
                                  : raw.tags?.some((t: string[]) => t[0] === 'M' && t[1] === 'here') ? 'here'
                                  : 'role'
                                notifState.incrementChannelUnread(
                                  hubDTag, channelId, msg.createdAt, mentionType
                                )
                              }
                            } catch { /* skip */ }
                          }
                        }
                      }).catch(() => {})
                    }
                  })
                  .catch(() => {})
              })
              await Promise.all(promises)
            }

            // Stagger: process MENTION_BATCH_SIZE hubs, wait, repeat
            ;(async () => {
              for (let i = 0; i < sortedHubDTags.length; i += MENTION_BATCH_SIZE) {
                const chunk = sortedHubDTags.slice(i, i + MENTION_BATCH_SIZE)
                await processMentionBatch(chunk)
                // Yield between batches (skip delay after last batch)
                if (i + MENTION_BATCH_SIZE < sortedHubDTags.length) {
                  await new Promise(r => setTimeout(r, MENTION_BATCH_DELAY_MS))
                }
              }
            })()
          }
        }
      )

      // 2. Real-time — keep open for new messages, polls, and votes
      const realtimeSub = subscribeToRelays(
        [batch.relay],
        {
          kinds: [KINDS.MESSAGE, KINDS.POLL, KINDS.POLL_VOTE, STANDARD_KINDS.REACTION,
                  KINDS.CALENDAR_TIME_EVENT, KINDS.CALENDAR_RSVP, KINDS.HIDE_MESSAGE,
                  KINDS.MESSAGE_EDIT_HINT],
          '#h': batch.hubDTags,
          since: now,
        },
        createEventHandler(null) // null = write-through (no buffer)
      )

      subsRef.current.push(initialSub, realtimeSub)
    }

    // Cleanup on unmount or before rebuilding
    // IMPORTANT: reset fingerprint so effect recreates subscriptions after HMR.
    // Without this, HMR closes subs via cleanup but the stale fingerprint causes
    // the re-run to bail out at the "skip if nothing changed" check (line 503),
    // silently killing all message delivery until manual refresh.
    return () => {
      for (const sub of subsRef.current) {
        sub.close()
      }
      subsRef.current = []
      hubFingerprintRef.current = ''
    }
  }, [hubListLoaded, hubs, reconnectCount])
}
