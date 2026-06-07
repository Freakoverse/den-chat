/**
 * Message Store — Zustand store for chat messages and unread counts
 *
 * Messages are stored indexed by hubDTag → channelId → messages[].
 * Unread counts track how many new messages arrived for inactive hubs.
 *
 * Memory management:
 * - Per-channel cap: MAX_PER_CHANNEL (1000) — oldest-cached messages evicted first
 * - Global cap: MAX_GLOBAL (20000) — prevents total memory from growing unbounded
 * - Eviction is FIFO (oldest-cached first, not oldest-event) to preserve scroll-up history
 */

import { create } from 'zustand'

/** Max messages per channel in memory */
const MAX_PER_CHANNEL = 1000
/** Max total messages across all hubs/channels in memory */
const MAX_GLOBAL = 20000

/** Blossom file attachment metadata — used in message JSON payload */
export interface Attachment {
  hash: string   // SHA-256 hash of the file (ciphertext hash when encrypted)
  type: string   // MIME type (e.g. "image/png")
  name: string   // Original filename
  size: number   // File size in bytes (ciphertext size when encrypted)
  /** Present only for encrypted file attachments (opt-in per upload) */
  encryption?: {
    algorithm: string      // 'aes-gcm'
    key: string            // AES-256 key hex (64 chars)
    nonce: string          // AES-GCM nonce hex (24 chars = 12 bytes)
    originalHash: string   // SHA-256 of the plaintext file (hex)
  }
}

export interface ChatMessage {
  id: string            // event id
  dTag: string          // d tag — unique message identifier (addressable)
  hubDTag: string       // from #h tag
  channelId: string     // from #c tag
  pubkey: string        // sender pubkey
  content: string       // raw encrypted content
  createdAt: number     // ordering timestamp — published_at if edited, otherwise created_at
  eventCreatedAt: number // actual event created_at — used for replacement comparison
  epoch: number         // from epoch tag
  replyTo?: string      // from a tag with 'reply' marker (format: "36943:pubkey:dTag")
  rootRef?: string      // from a tag with 'root' marker — thread root reference
  edited?: boolean      // true if this message has been edited (replaced with newer version)
  deleted?: boolean     // true if this message has been request-deleted
  isThread?: boolean    // true if this is a thread reply (has ["thread"] tag)
  rawEvent?: string     // full raw Nostr event JSON (for "View Raw Event")
  clientTag?: string    // from ["client", "..."] tag — what app sent this message
  facilitator?: string  // from ["facilitator", "<npub>"] tag — facilitated posting
  isForum?: boolean     // true if this is a forum post (has ["forum"] tag)
}

/** A single reaction stored in the message store */
export interface StoredReaction {
  emoji: string
  pubkey: string
  eventId: string
  customUrl?: string
  /** Unix timestamp (seconds) of the reaction event */
  createdAt?: number
  /** Raw encrypted content from the event (for lazy decryption) */
  rawContent?: string
  /** Raw encrypted emoji tag [shortcode, url] (for lazy decryption) */
  rawEmojiTag?: [string, string]
  /** Whether this reaction has been decrypted */
  decrypted?: boolean
}

interface MessageState {
  /** Messages indexed by hubDTag → channelId → ChatMessage[] */
  messages: Record<string, Record<string, ChatMessage[]>>
  /** Unread counts per hub: hubDTag → count */
  unreadCounts: Record<string, number>
  /** Transient relay progress during publishing: eventId → { confirmed, total, acceptedRelays } */
  relayProgress: Record<string, { confirmed: number; total: number; acceptedRelays: string[] }>
  /** Reactions: hubDTag → targetMsgEventId → StoredReaction[] */
  reactions: Record<string, Record<string, StoredReaction[]>>
  /** Processed reaction event IDs (deduplication) */
  processedReactionIds: Set<string>
  /** Insertion-order tracking for FIFO eviction (oldest-cached first) */
  _insertionOrder: string[]

  /** Add a single message — inserts sorted by createdAt, deduplicates by id */
  addMessage: (msg: ChatMessage) => void
  /** Bulk set messages for a specific channel (e.g. history load) */
  setMessages: (hubDTag: string, channelId: string, msgs: ChatMessage[]) => void
  /** Remove a message locally (by d-tag) */
  removeMessage: (hubDTag: string, channelId: string, dTag: string) => void
  /** Mark a message as deleted (by d-tag) */
  markDeleted: (hubDTag: string, channelId: string, dTag: string) => void
  /** Optimistically update a message's content + mark as edited (for instant UI feedback after edits) */
  updateMessageContent: (hubDTag: string, channelId: string, dTag: string, pubkey: string, newContent: string, newEventCreatedAt: number, newEventId: string, newRawEvent?: string) => void
  /** Reset unread count for a hub (when user views it) */
  clearUnread: (hubDTag: string) => void
  /** Increment unread count for a hub */
  incrementUnread: (hubDTag: string) => void
  /** Set relay progress for a publishing event */
  setRelayProgress: (eventId: string, confirmed: number, total: number, acceptedRelays?: string[]) => void
  /** Clear relay progress (publishing complete) */
  clearRelayProgress: (eventId: string) => void

  /** Add a reaction (deduplicates by eventId) */
  addReaction: (hubDTag: string, targetMsgId: string, reaction: StoredReaction) => void
  /** Remove a reaction (unreact) */
  removeReaction: (hubDTag: string, targetMsgId: string, emoji: string, pubkey: string) => void
  /** Mark a reaction event ID as processed */
  markReactionProcessed: (eventId: string) => boolean // returns false if already processed
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  unreadCounts: {},
  relayProgress: {},
  reactions: {},
  processedReactionIds: new Set(),
  _insertionOrder: [],

  addMessage: (msg) =>
    set((state) => {
      const hubMsgs = state.messages[msg.hubDTag] || {}
      const channelMsgs = hubMsgs[msg.channelId] || []

      // Addressable replacement: same dTag + pubkey = updated message
      const existingIdx = channelMsgs.findIndex(
        (m) => m.dTag === msg.dTag && m.pubkey === msg.pubkey
      )

      if (existingIdx !== -1) {
        // Replace with newer version, only if newer (compare actual event timestamps, not display order)
        const existing = channelMsgs[existingIdx]
        const msgEventTs = msg.eventCreatedAt || msg.createdAt
        const existingEventTs = existing.eventCreatedAt || existing.createdAt
        if (msgEventTs <= existingEventTs) return state

        const updated = [...channelMsgs]
        updated[existingIdx] = {
          ...msg,
          edited: true, // mark as edited since it replaced an existing version
        }
        return {
          messages: {
            ...state.messages,
            [msg.hubDTag]: {
              ...hubMsgs,
              [msg.channelId]: updated,
            },
          },
        }
      }

      // Deduplicate by event id (fallback)
      if (channelMsgs.some((m) => m.id === msg.id)) return state

      // Insert sorted by createdAt
      let updated = [...channelMsgs, msg].sort((a, b) => a.createdAt - b.createdAt)

      // Per-channel FIFO cap
      if (updated.length > MAX_PER_CHANNEL) {
        updated = updated.slice(updated.length - MAX_PER_CHANNEL)
      }

      // Track insertion order for global cap
      let insertionOrder = [...state._insertionOrder, msg.id]

      // Global FIFO cap
      const newMessages = { ...state.messages, [msg.hubDTag]: { ...hubMsgs, [msg.channelId]: updated } }
      if (insertionOrder.length > MAX_GLOBAL) {
        const excess = insertionOrder.length - MAX_GLOBAL
        const toEvict = new Set(insertionOrder.slice(0, excess))
        insertionOrder = insertionOrder.slice(excess)
        // Evict from all channels
        for (const [hd, channels] of Object.entries(newMessages)) {
          for (const [ch, msgs] of Object.entries(channels)) {
            const filtered = msgs.filter((m: ChatMessage) => !toEvict.has(m.id))
            if (filtered.length !== msgs.length) {
              if (!newMessages[hd]) newMessages[hd] = { ...channels }
              newMessages[hd][ch] = filtered
            }
          }
        }
      }

      return { messages: newMessages, _insertionOrder: insertionOrder }
    }),

  setMessages: (hubDTag, channelId, msgs) =>
    set((state) => {
      const hubMsgs = state.messages[hubDTag] || {}
      let sorted = msgs.sort((a, b) => a.createdAt - b.createdAt)

      // Per-channel FIFO cap
      if (sorted.length > MAX_PER_CHANNEL) {
        sorted = sorted.slice(sorted.length - MAX_PER_CHANNEL)
      }

      // Add new IDs to insertion order (skip duplicates)
      const existingIds = new Set(state._insertionOrder)
      const newIds = sorted.map(m => m.id).filter(id => !existingIds.has(id))
      const insertionOrder = [...state._insertionOrder, ...newIds]

      return {
        messages: {
          ...state.messages,
          [hubDTag]: {
            ...hubMsgs,
            [channelId]: sorted,
          },
        },
        _insertionOrder: insertionOrder,
      }
    }),

  clearUnread: (hubDTag) =>
    set((state) => ({
      unreadCounts: { ...state.unreadCounts, [hubDTag]: 0 },
    })),

  removeMessage: (hubDTag, channelId, dTag) =>
    set((state) => {
      const hubMsgs = state.messages[hubDTag] || {}
      const channelMsgs = hubMsgs[channelId] || []
      return {
        messages: {
          ...state.messages,
          [hubDTag]: {
            ...hubMsgs,
            [channelId]: channelMsgs.filter((m) => m.dTag !== dTag),
          },
        },
      }
    }),

  markDeleted: (hubDTag, channelId, dTag) =>
    set((state) => {
      const hubMsgs = state.messages[hubDTag] || {}
      const channelMsgs = hubMsgs[channelId] || []
      const idx = channelMsgs.findIndex((m) => m.dTag === dTag)
      if (idx === -1) return state
      const updated = [...channelMsgs]
      updated[idx] = { ...updated[idx], deleted: true }
      return {
        messages: {
          ...state.messages,
          [hubDTag]: {
            ...hubMsgs,
            [channelId]: updated,
          },
        },
      }
    }),

  updateMessageContent: (hubDTag, channelId, dTag, pubkey, newContent, newEventCreatedAt, newEventId, newRawEvent) =>
    set((state) => {
      const hubMsgs = state.messages[hubDTag] || {}
      const channelMsgs = hubMsgs[channelId] || []
      const idx = channelMsgs.findIndex((m) => m.dTag === dTag && m.pubkey === pubkey)
      if (idx === -1) return state
      const updated = [...channelMsgs]
      updated[idx] = {
        ...updated[idx],
        id: newEventId,
        content: newContent,
        edited: true,
        eventCreatedAt: newEventCreatedAt,
        ...(newRawEvent ? { rawEvent: newRawEvent } : {}),
      }
      return {
        messages: {
          ...state.messages,
          [hubDTag]: {
            ...hubMsgs,
            [channelId]: updated,
          },
        },
      }
    }),

  incrementUnread: (hubDTag) =>
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [hubDTag]: (state.unreadCounts[hubDTag] || 0) + 1,
      },
    })),

  setRelayProgress: (eventId, confirmed, total, acceptedRelays) =>
    set((state) => ({
      relayProgress: {
        ...state.relayProgress,
        [eventId]: { confirmed, total, acceptedRelays: acceptedRelays || [] },
      },
    })),

  clearRelayProgress: (eventId) =>
    set((state) => {
      const { [eventId]: _, ...rest } = state.relayProgress
      return { relayProgress: rest }
    }),

  addReaction: (hubDTag, targetMsgId, reaction) =>
    set((state) => {
      const hubReactions = state.reactions[hubDTag] || {}
      const existing = hubReactions[targetMsgId] || []
      // Deduplicate: skip if same emoji + pubkey already exists
      if (existing.some((r) => r.emoji === reaction.emoji && r.pubkey === reaction.pubkey)) return state
      return {
        reactions: {
          ...state.reactions,
          [hubDTag]: {
            ...hubReactions,
            [targetMsgId]: [...existing, reaction],
          },
        },
      }
    }),

  removeReaction: (hubDTag, targetMsgId, emoji, pubkey) =>
    set((state) => {
      const hubReactions = state.reactions[hubDTag] || {}
      const existing = hubReactions[targetMsgId] || []
      return {
        reactions: {
          ...state.reactions,
          [hubDTag]: {
            ...hubReactions,
            [targetMsgId]: existing.filter((r) => !(r.emoji === emoji && r.pubkey === pubkey)),
          },
        },
      }
    }),

  markReactionProcessed: (eventId) => {
    const state = get()
    if (state.processedReactionIds.has(eventId)) return false
    set({ processedReactionIds: new Set(state.processedReactionIds).add(eventId) })
    return true
  },
}))

