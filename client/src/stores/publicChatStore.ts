/**
 * Public Chat Store — Zustand store for permissionless topic-based chat (Kind 1312)
 *
 * Features:
 * - Topic list persistence via NIP-78 (kind 30078)
 * - Messages grouped by topic
 * - PoW-based spam filtering (coupled: filter difficulty = post difficulty)
 * - Relay subscription management per active topic
 * - No encryption, no authority, no editing
 * - NIP-09 deletion monitoring (kind 5) scoped by #k + #t tags
 */

import { create } from 'zustand'
import { KINDS, STANDARD_KINDS } from '@/lib/crypto/constants'
import { createPublicChatMessage, createPublicChatList } from '@/lib/nostr/events'
import { signWithSigner, mineAndSign } from '@/lib/nostr'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import { isClientTagEnabled } from '@/components/social/ComposeSettings'
import {
  fetchEvents,
  fetchReplaceable,
  subscribeEvents,
  publishEvent,
  publishEventProgressive,
} from '@/lib/nostr/relay-pool'
import type { ISigner } from '@/stores/userStore'
import type { Event } from 'nostr-tools'

// ─── Types ───

export interface PublicChatMessage {
  id: string
  pubkey: string
  content: string        // plaintext
  createdAt: number
  topic: string          // first t tag (normalized lowercase)
  replyTo?: string       // e tag with 'reply' marker (event ID)
  rootRef?: string       // e tag with 'root' marker (event ID)
  deleted?: boolean
  pow: number            // computed difficulty of this event's ID
  clientTag?: string     // from ["client", "..."] tag
  nsfw?: boolean         // from ["content-warning", ...] tag (NIP-36)
  stickerTags?: [string, string, string?][]  // [shortcode, url, setRef?]
  gifTags?: [string, string, string][]       // [name, url, nsfw-flag]
}

/** Number of messages to fetch per page */
const PAGE_SIZE = 50

/** Max deletion event IDs to track for dedup (FIFO eviction) */
const DELETION_DEDUP_CAP = 50

/** Max messages to keep in memory per topic */
const MAX_PER_TOPIC = 1000

// ─── Store ───

interface PublicChatState {
  /** User's subscribed topics (persisted via NIP-78) */
  topics: string[]
  /** Currently active/viewed topic */
  activeTopic: string | null
  /** Messages indexed by topic */
  messages: Record<string, PublicChatMessage[]>
  /** PoW difficulty — coupled filter + post (default 15) */
  powDifficulty: number
  /** Whether topic list has been loaded from relay */
  topicListLoaded: boolean
  /** Loading state for initial message fetch per topic */
  loadingTopic: Record<string, boolean>
  /** Whether there are older messages available per topic */
  hasMore: Record<string, boolean>
  /** Whether currently loading older messages */
  loadingOlder: boolean

  // ── Content Filters (defaults OFF) ──
  /** Show embedded media (images, videos, stickers, GIFs) */
  showMedia: boolean
  /** Show link previews */
  showLinkPreviews: boolean
  /** Show custom emojis (in reactions and text) */
  showCustomEmojis: boolean
  /** Hide muted words (redact them in messages) — default ON */
  hideMutedWords: boolean
  /** Only show messages from DNN ID holders — default OFF */
  dnnIdOnly: boolean
  /** Active subscription handle */
  _sub: { close: () => void } | null
  /** Active deletion subscription handle */
  _deletionSub: { close: () => void } | null
  /** Processed deletion event IDs (dedup, capped at DELETION_DEDUP_CAP) */
  _processedDeletionIds: string[]
  /** Relay progress for publishing */
  relayProgress: Record<string, { confirmed: number; total: number; acceptedRelays: string[] }>

  // ── Actions ──
  setActiveTopic: (topic: string | null) => void
  setShowMedia: (v: boolean) => void
  setShowLinkPreviews: (v: boolean) => void
  setShowCustomEmojis: (v: boolean) => void
  setHideMutedWords: (v: boolean) => void
  setDnnIdOnly: (v: boolean) => void
  setPowDifficulty: (d: number) => void
  addTopic: (topic: string, pubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  removeTopic: (topic: string, pubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  fetchTopicList: (pubkey: string) => Promise<void>

  /** Subscribe to real-time messages for the active topic */
  startSubscription: (topic: string) => void
  stopSubscription: () => void

  /** Subscribe to deletion events for the active topic */
  startDeletionSubscription: (topic: string) => void
  stopDeletionSubscription: () => void

  /** Remove a message by ID (used for deletion processing + optimistic removal) */
  removeMessage: (topic: string, msgId: string) => void

  /** Fetch initial/older messages */
  fetchMessages: (topic: string) => Promise<void>
  fetchOlderMessages: (topic: string) => Promise<void>

  /** Send a message */
  sendMessage: (params: {
    content: string
    topic: string
    pubkey: string
    signer: ISigner | null
    privateKey: string | null
    replyTo?: string
    replyToPubkey?: string
    rootRef?: string
    extraTags?: string[][]
    nsfw?: boolean
  }) => Promise<void>

  /** Add a message from subscription or fetch */
  addMessage: (msg: PublicChatMessage) => void

  /** Relay progress */
  setRelayProgress: (eventId: string, confirmed: number, total: number, acceptedRelays?: string[]) => void
  clearRelayProgress: (eventId: string) => void
}

/** Parse a kind 1312 event into a PublicChatMessage */
function parsePublicChatEvent(event: Event): PublicChatMessage | null {
  const tTag = event.tags.find(t => t[0] === 't')
  if (!tTag || !tTag[1]) return null

  const topic = tTag[1].toLowerCase()

  // NIP-10 reply/root from e tags
  let replyTo: string | undefined
  let rootRef: string | undefined
  for (const tag of event.tags) {
    if (tag[0] === 'e') {
      const marker = tag[3]
      if (marker === 'reply') replyTo = tag[1]
      else if (marker === 'root') rootRef = tag[1]
    }
  }

  const clientTag = event.tags.find(t => t[0] === 'client')?.[1]
  const nsfw = event.tags.some(t => t[0] === 'content-warning')
  const pow = countLeadingZeroBits(event.id)

  // Sticker tags: ['sticker', shortcode, url, setAddress?]
  const stickerTags = event.tags
    .filter(t => t[0] === 'sticker' && t[1] && t[2])
    .map(t => [t[1], t[2], t[3]] as [string, string, string?])

  // GIF tags: ['j', name, url, nsfw-flag]
  const gifTags = event.tags
    .filter(t => t[0] === 'j' && t[2])
    .map(t => [t[1] || '', t[2], t[3] || 'sfw'] as [string, string, string])

  return {
    id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
    topic,
    replyTo,
    rootRef,
    pow,
    clientTag,
    nsfw: nsfw || undefined,
    stickerTags: stickerTags.length > 0 ? stickerTags : undefined,
    gifTags: gifTags.length > 0 ? gifTags : undefined,
  }
}

export const usePublicChatStore = create<PublicChatState>((set, get) => ({
  topics: [],
  activeTopic: null,
  messages: {},
  powDifficulty: 15,
  topicListLoaded: false,
  loadingTopic: {},
  hasMore: {},
  loadingOlder: false,
  _sub: null,
  _deletionSub: null,
  _processedDeletionIds: [],
  relayProgress: {},

  // Content filters — default OFF, persisted in localStorage
  showMedia: typeof window !== 'undefined' && localStorage.getItem('pc_showMedia') === 'true',
  showLinkPreviews: typeof window !== 'undefined' && localStorage.getItem('pc_showLinkPreviews') === 'true',
  showCustomEmojis: typeof window !== 'undefined' && localStorage.getItem('pc_showCustomEmojis') === 'true',
  hideMutedWords: typeof window === 'undefined' || localStorage.getItem('pc_hideMutedWords') !== 'false',
  dnnIdOnly: typeof window !== 'undefined' && localStorage.getItem('pc_dnnIdOnly') === 'true',

  setActiveTopic: (topic) => set({ activeTopic: topic }),

  setPowDifficulty: (d) => set({ powDifficulty: Math.max(0, Math.min(40, d)) }),

  setShowMedia: (v) => {
    localStorage.setItem('pc_showMedia', String(v))
    set({ showMedia: v })
  },
  setShowLinkPreviews: (v) => {
    localStorage.setItem('pc_showLinkPreviews', String(v))
    set({ showLinkPreviews: v })
  },
  setShowCustomEmojis: (v) => {
    localStorage.setItem('pc_showCustomEmojis', String(v))
    set({ showCustomEmojis: v })
  },
  setHideMutedWords: (v) => {
    localStorage.setItem('pc_hideMutedWords', String(v))
    set({ hideMutedWords: v })
  },
  setDnnIdOnly: (v) => {
    localStorage.setItem('pc_dnnIdOnly', String(v))
    set({ dnnIdOnly: v })
  },

  // ── Topic list management (NIP-78) ──

  fetchTopicList: async (pubkey) => {
    try {
      const event = await fetchReplaceable(pubkey, STANDARD_KINDS.APP_DATA, 'public-chat-list')
      if (event) {
        const topics = event.tags
          .filter(t => t[0] === 't' && t[1])
          .map(t => t[1].toLowerCase())
        set({ topics, topicListLoaded: true })
      } else {
        set({ topicListLoaded: true })
      }
    } catch (err) {
      console.error('[PublicChat] Failed to fetch topic list:', err)
      set({ topicListLoaded: true })
    }
  },

  addTopic: async (topic, pubkey, signer, privateKey) => {
    const normalized = topic.toLowerCase().trim()
    if (!normalized) return
    const state = get()
    if (state.topics.includes(normalized)) return

    const newTopics = [...state.topics, normalized]
    set({ topics: newTopics })

    // Publish updated NIP-78 list
    try {
      const unsigned = createPublicChatList(newTopics)
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishEvent(signed)
    } catch (err) {
      console.error('[PublicChat] Failed to publish topic list:', err)
    }
  },

  removeTopic: async (topic, pubkey, signer, privateKey) => {
    const normalized = topic.toLowerCase()
    const state = get()
    const newTopics = state.topics.filter(t => t !== normalized)
    set({ topics: newTopics })

    // Clear messages for removed topic
    const { [normalized]: _, ...remainingMessages } = state.messages
    set({ messages: remainingMessages })

    // If active topic was removed, clear it
    if (state.activeTopic === normalized) {
      set({ activeTopic: null })
    }

    // Publish updated NIP-78 list
    try {
      const unsigned = createPublicChatList(newTopics)
      const signed = await signWithSigner(unsigned, signer, privateKey)
      await publishEvent(signed)
    } catch (err) {
      console.error('[PublicChat] Failed to publish topic list:', err)
    }
  },

  // ── Subscriptions ──

  startSubscription: (topic) => {
    const state = get()
    // Close existing sub if any
    state._sub?.close()

    const sub = subscribeEvents(
      { kinds: [KINDS.PUBLIC_CHAT], '#t': [topic.toLowerCase()], limit: PAGE_SIZE },
      (event) => {
        const msg = parsePublicChatEvent(event)
        if (msg) get().addMessage(msg)
      },
    )

    set({ _sub: sub })
  },

  stopSubscription: () => {
    const state = get()
    state._sub?.close()
    set({ _sub: null })
  },

  // ── Deletion Subscriptions ──

  startDeletionSubscription: (topic) => {
    const state = get()
    state._deletionSub?.close()

    const sub = subscribeEvents(
      { kinds: [STANDARD_KINDS.DELETION], '#k': [String(KINDS.PUBLIC_CHAT)], '#t': [topic.toLowerCase()] },
      (event) => {
        const s = get()
        // Dedup: skip if already processed
        if (s._processedDeletionIds.includes(event.id)) return

        // Add to dedup list (FIFO, capped)
        const updated = [...s._processedDeletionIds, event.id]
        if (updated.length > DELETION_DEDUP_CAP) updated.splice(0, updated.length - DELETION_DEDUP_CAP)
        set({ _processedDeletionIds: updated })

        // Extract e-tags (target message IDs) from the deletion event
        const targetIds = event.tags.filter(t => t[0] === 'e').map(t => t[1]).filter(Boolean)
        if (targetIds.length === 0) return

        // For each target, verify author ownership and remove
        const topicKey = topic.toLowerCase()
        const msgs = s.messages[topicKey] || []
        for (const targetId of targetIds) {
          const msg = msgs.find(m => m.id === targetId)
          if (!msg) continue
          // NIP-09: only the original author can delete their own messages
          if (msg.pubkey !== event.pubkey) continue
          get().removeMessage(topicKey, targetId)
        }
      },
    )

    set({ _deletionSub: sub })
  },

  stopDeletionSubscription: () => {
    const state = get()
    state._deletionSub?.close()
    set({ _deletionSub: null })
  },

  removeMessage: (topic, msgId) =>
    set(s => {
      const existing = s.messages[topic]
      if (!existing) return s
      const filtered = existing.filter(m => m.id !== msgId)
      if (filtered.length === existing.length) return s // nothing removed
      return { messages: { ...s.messages, [topic]: filtered } }
    }),

  // ── Fetch messages ──

  fetchMessages: async (topic) => {
    const normalized = topic.toLowerCase()
    set(s => ({ loadingTopic: { ...s.loadingTopic, [normalized]: true } }))

    try {
      const events = await fetchEvents({
        kinds: [KINDS.PUBLIC_CHAT],
        '#t': [normalized],
        limit: PAGE_SIZE,
      })

      const msgs = events
        .map(parsePublicChatEvent)
        .filter((m): m is PublicChatMessage => m !== null)
        .sort((a, b) => a.createdAt - b.createdAt)

      // Deduplicate
      const seen = new Set<string>()
      const deduped = msgs.filter(m => {
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })

      set(s => ({
        messages: { ...s.messages, [normalized]: deduped },
        hasMore: { ...s.hasMore, [normalized]: events.length >= PAGE_SIZE },
        loadingTopic: { ...s.loadingTopic, [normalized]: false },
      }))
    } catch (err) {
      console.error('[PublicChat] Failed to fetch messages:', err)
      set(s => ({ loadingTopic: { ...s.loadingTopic, [normalized]: false } }))
    }
  },

  fetchOlderMessages: async (topic) => {
    const normalized = topic.toLowerCase()
    const state = get()
    if (state.loadingOlder || !state.hasMore[normalized]) return

    const existing = state.messages[normalized] || []
    if (existing.length === 0) return

    const oldest = existing[0]
    set({ loadingOlder: true })

    try {
      const events = await fetchEvents({
        kinds: [KINDS.PUBLIC_CHAT],
        '#t': [normalized],
        until: oldest.createdAt,
        limit: PAGE_SIZE,
      })

      const msgs = events
        .map(parsePublicChatEvent)
        .filter((m): m is PublicChatMessage => m !== null)
        // Exclude any we already have
        .filter(m => !existing.some(e => e.id === m.id))

      const merged = [...msgs, ...existing].sort((a, b) => a.createdAt - b.createdAt)

      set(s => ({
        messages: { ...s.messages, [normalized]: merged },
        hasMore: { ...s.hasMore, [normalized]: events.length >= PAGE_SIZE },
        loadingOlder: false,
      }))
    } catch (err) {
      console.error('[PublicChat] Failed to fetch older messages:', err)
      set({ loadingOlder: false })
    }
  },

  // ── Send message ──

  sendMessage: async ({ content, topic, pubkey, signer, privateKey, replyTo, replyToPubkey, rootRef, extraTags, nsfw }) => {
    const difficulty = get().powDifficulty

    // Build unsigned event
    let unsigned = createPublicChatMessage(content, topic, replyTo, rootRef)

    // Extract mentioned pubkeys from content (nostr:npub1..., @npub1..., nostr:nprofile1...)
    // and add p-tags so mentioned users receive notifications
    try {
      const { nip19 } = await import('nostr-tools')
      const mentionPattern = /(?:nostr:)?@?(?:npub1[a-zA-Z0-9]+|nprofile1[a-zA-Z0-9]+)/g
      const mentionedPubkeys = new Set<string>()
      let mentionMatch: RegExpExecArray | null
      while ((mentionMatch = mentionPattern.exec(content)) !== null) {
        const raw = mentionMatch[0].replace('nostr:', '').replace(/^@/, '')
        try {
          const decoded = nip19.decode(raw)
          if (decoded.type === 'npub') {
            mentionedPubkeys.add(decoded.data as string)
          } else if (decoded.type === 'nprofile') {
            mentionedPubkeys.add((decoded.data as { pubkey: string }).pubkey)
          }
        } catch { /* invalid bech32 — skip */ }
      }
      // Also tag the author of the replied-to message
      if (replyToPubkey && replyToPubkey !== pubkey) {
        mentionedPubkeys.add(replyToPubkey)
      }
      if (mentionedPubkeys.size > 0) {
        const pTags = [...mentionedPubkeys]
          .filter(pk => pk !== pubkey) // Don't tag yourself
          .map(pk => ['p', pk] as [string, ...string[]])
        if (pTags.length > 0) {
          unsigned = { ...unsigned, tags: [...unsigned.tags, ...pTags] }
        }
      }
    } catch { /* nip19 import failed — skip p-tags */ }

    // Add NSFW content-warning tag (NIP-36)
    if (nsfw) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, ['content-warning', ''], ['L', 'content-warning']] }
    }

    // Add any extra tags (emoji, sticker, gif, etc.)
    if (extraTags && extraTags.length > 0) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, ...extraTags.map(t => t as [string, ...string[]])] }
    }

    // Add client tag if enabled in preferences
    if (isClientTagEnabled()) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, ['client', 'DEN Chat']] }
    }

    // Mine PoW + sign (with automatic retry if signer invalidates PoW)
    const signed = await mineAndSign(unsigned, difficulty, pubkey, signer, privateKey)

    // Publish with progress tracking
    await publishEventProgressive(
      signed,
      (confirmed, total, acceptedRelays) => {
        get().setRelayProgress(signed.id, confirmed, total, acceptedRelays)
      },
    )

    // Clear progress after a delay
    setTimeout(() => get().clearRelayProgress(signed.id), 3000)

    // Optimistically add to local messages
    const msg = parsePublicChatEvent(signed)
    if (msg) get().addMessage(msg)
  },

  // ── Message management ──

  addMessage: (msg) =>
    set(s => {
      const topic = msg.topic.toLowerCase()
      const existing = s.messages[topic] || []

      // Deduplicate
      if (existing.some(m => m.id === msg.id)) return s

      let updated = [...existing, msg].sort((a, b) => a.createdAt - b.createdAt)

      // FIFO cap: trim oldest-cached (front of array) when over limit
      if (updated.length > MAX_PER_TOPIC) {
        updated = updated.slice(updated.length - MAX_PER_TOPIC)
      }

      return { messages: { ...s.messages, [topic]: updated } }
    }),

  setRelayProgress: (eventId, confirmed, total, acceptedRelays) =>
    set(s => ({
      relayProgress: {
        ...s.relayProgress,
        [eventId]: { confirmed, total, acceptedRelays: acceptedRelays || [] },
      },
    })),

  clearRelayProgress: (eventId) =>
    set(s => {
      const { [eventId]: _, ...rest } = s.relayProgress
      return { relayProgress: rest }
    }),
}))
