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
  loadAllCachedMessages,
  cacheMessage,
  pruneAll,
} from '@/lib/cache/messageCache'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import { usePollStore, parsePollEvent, parseVoteEvent } from '@/stores/pollStore'
import { useCalendarStore, parseCalendarEvent, parseCalendarRsvp } from '@/stores/calendarStore'
import { processHideEvent } from '@/hooks/useHideMessages'
import { useNotificationStore } from '@/stores/notificationStore'
import { useUserStore } from '@/stores/userStore'
import { aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { nip19 } from 'nostr-tools'


import type { Event } from 'nostr-tools'

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

  if (!dTag || !hubDTag || !channelId) return null

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
  const relays = [...new Set([...hub.generalRelays, ...hub.filterRelays])].filter(Boolean)
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
        cacheMessage(msg).catch(() => {})
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

  const relays = [...new Set([...hub.generalRelays, ...hub.filterRelays])].filter(Boolean)
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
        cacheMessage(msg).catch(() => {})
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

  const relays = [...new Set([...hub.generalRelays, ...hub.filterRelays])].filter(Boolean)
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
          cacheMessage(msg).catch(() => {})
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
  const relays = [...new Set([...hub.generalRelays, ...hub.filterRelays])].filter(Boolean)
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
          cacheMessage(msg).catch(() => {})
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
  store.addReaction(hubDTag, targetEventId, {
    emoji: event.content, // encrypted — will be decrypted at render
    pubkey: event.pubkey,
    eventId: event.id,
    rawContent: event.content,
    rawEmojiTag: emojiTag ? [emojiTag[1], emojiTag[2]] : undefined,
    decrypted: false,
  })
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
async function detectMentionType(
  hubDTag: string,
  channelId: string,
  epoch: number,
  encryptedContent: string,
  senderPubkey: string
): Promise<'personal' | 'everyone' | 'here' | 'role' | undefined> {
  // Don't scan our own messages
  const myPubkey = useUserStore.getState().pubkey
  if (!myPubkey || senderPubkey === myPubkey) return undefined

  // Get hub secret
  const secretHex = useHubStore.getState().hubSecrets[hubDTag]
  if (!secretHex) return undefined // key not loaded yet — can't decrypt

  // Derive channel key and decrypt
  const secretBytes = new Uint8Array(secretHex.match(/.{2}/g)!.map((b: string) => parseInt(b, 16)))
  const channelKey = deriveChannelKey(secretBytes, channelId, epoch)
  const plaintext = await aesDecrypt(channelKey, encryptedContent)

  // Check for personal mention (nostr:npub1..., @npub1...)
  const myNpub = nip19.npubEncode(myPubkey)
  if (plaintext.includes(myNpub) || plaintext.includes(`nostr:${myNpub}`)) {
    return 'personal'
  }

  // Check for @everyone
  if (plaintext.includes('@everyone')) return 'everyone'

  // Check for @here
  if (plaintext.includes('@here')) return 'here'

  // Check for @role mentions — scan hub role names
  const hub = useHubStore.getState().hubs[hubDTag]
  if (hub?.roles?.length) {
    for (const role of hub.roles) {
      if (role.name && plaintext.includes(`@${role.name}`)) return 'role'
    }
  }

  return undefined // normal message, no special mention
}

export function useHubSubscriptions() {
  const hubs = useHubStore((s) => s.hubs)
  const hubListLoaded = useHubStore((s) => s.hubListLoaded)
  const activeHubId = useHubStore((s) => s.activeHubId)
  const activeChannelId = useHubStore((s) => s.activeChannelId)
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

  // Load cached messages from IndexedDB on startup (once)
  useEffect(() => {
    if (cacheLoadedRef.current) return
    cacheLoadedRef.current = true

    loadAllCachedMessages().then((cached) => {
      if (cached.length > 0) {
        console.log(`[HubSubs] Loaded ${cached.length} cached messages from IndexedDB`)
        for (const msg of cached) {
          // Validate PoW on cached messages
          const hub = hubsRef.current[msg.hubDTag]
          const minPow = hub?.minPow || 0
          if (minPow > 0 && countLeadingZeroBits(msg.id) < minPow) continue
          addMessageRef.current(msg)
        }
      }
    })
  }, [])

  // Re-subscribe when tab becomes visible (browsers drop WebSockets in background)
  const [reconnectCount, setReconnectCount] = useState(0)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Reset fingerprint and bump counter to force re-subscription
        hubFingerprintRef.current = ''
        setReconnectCount((c) => c + 1)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  useEffect(() => {
    if (!hubListLoaded) return

    const hubKeys = Object.keys(hubs)
    if (hubKeys.length === 0) return

    // Build a fingerprint to detect relay config changes
    const fingerprint = hubKeys
      .sort()
      .map((k) => {
        const h = hubs[k]
        return `${k}:${h.generalRelays.join(',')}:${h.filterRelays.join(',')}`
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

    // Event handler — shared between initial fetch and real-time
    const handleEvent = (event: Event) => {
      // Route poll events to pollStore
      if (event.kind === KINDS.POLL) {
        const poll = parsePollEvent(event)
        if (poll) usePollStore.getState().addPoll(poll)
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

      const msg = parseMessage(event)
      if (!msg) return

      // Validate PoW — reject messages that don't meet hub difficulty
      const hub = hubsRef.current[msg.hubDTag]
      const minPow = hub?.minPow || 0
      if (minPow > 0 && countLeadingZeroBits(event.id) < minPow) return

      // Add to in-memory store (messageStore handles its own dedup)
      addMessageRef.current(msg)

      // Write-through to IndexedDB cache
      cacheMessage(msg).catch(() => {})

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
      // Skip own messages — they should never count as "unread"
      const myPubkey = useUserStore.getState().pubkey
      if (event.pubkey === myPubkey) return
      if (msg.hubDTag !== activeHubIdRef.current || msg.channelId !== activeChannelIdRef.current) {
        // Attempt async mention detection, fall back to undefined (normal message)
        detectMentionType(msg.hubDTag, msg.channelId, msg.epoch, event.content, event.pubkey)
          .then((mentionType) => {
            useNotificationStore.getState().incrementChannelUnread(
              msg.hubDTag, msg.channelId, msg.createdAt, mentionType
            )
          })
          .catch(() => {
            // Decryption failed (key not ready, wrong epoch, etc.) — treat as normal message
            useNotificationStore.getState().incrementChannelUnread(
              msg.hubDTag, msg.channelId, msg.createdAt
            )
          })

        // Also bump the legacy per-hub counter for the old sidebar badge
        if (msg.hubDTag !== activeHubIdRef.current) {
          incrementUnreadRef.current(msg.hubDTag)
        }
      }
    }

    // Create TWO subscriptions per batch:
    for (const batch of batches) {
      // 1. Initial fetch — latest N messages (closes on EOSE)
      const initialSub = subscribeToRelays(
        [batch.relay],
        {
          kinds: [KINDS.MESSAGE, KINDS.POLL, STANDARD_KINDS.REACTION,
                  KINDS.CALENDAR_TIME_EVENT, KINDS.CALENDAR_RSVP, KINDS.HIDE_MESSAGE],
          '#h': batch.hubDTags,
          limit: INITIAL_LIMIT,
        },
        handleEvent,
        () => {
          // EOSE: initial history is loaded, close this subscription
          initialSub.close()
        }
      )

      // 2. Real-time — keep open for new messages, polls, and votes
      const realtimeSub = subscribeToRelays(
        [batch.relay],
        {
          kinds: [KINDS.MESSAGE, KINDS.POLL, KINDS.POLL_VOTE, STANDARD_KINDS.REACTION,
                  KINDS.CALENDAR_TIME_EVENT, KINDS.CALENDAR_RSVP, KINDS.HIDE_MESSAGE],
          '#h': batch.hubDTags,
          since: now,
        },
        handleEvent
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
