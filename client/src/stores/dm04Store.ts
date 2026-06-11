/**
 * DM04 Store — NIP-04 Direct Messages state management
 *
 * Kind 4 encrypted DMs with support for:
 * - Replies (e-tag with "reply" marker)
 * - Thread replies (e-tag with "root" + "reply" markers, plus ["thread"] tag)
 * - Emoji reactions (kind 7 with NIP-04 encrypted emoji content)
 *
 * Architecture mirrors dmStore.ts but uses NIP-04 encryption instead of NIP-17 gift wrap.
 */

import { create } from 'zustand'
import { fetchEvents, fetchEventsFromRelays, publishEventProgressive, publishToSpecificRelays, subscribeEvents, subscribeToRelays, getRelays } from '@/lib/nostr/relay-pool'
import { getPublishRelays, usePostingBehaviourStore } from '@/stores/postingBehaviourStore'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { encryptNip04, decryptNip04 } from '@/lib/nostr/nip04dm'
import { useBlockStore } from '@/stores/blockStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useWotStore } from '@/stores/wotStore'
import { useFollowStore } from '@/stores/followStore'
import { useUserListsStore } from '@/stores/userListsStore'
import { createUnsignedEvent, signWithSigner } from '@/lib/nostr/events'
import {
  loadContactRegistry,
  addContact,
  evictAndReplace,
  isSpamBot,
  scheduleRegistryPublish,
  type DM04ContactRegistry,
  type DM04Contact,
} from '@/lib/nostr/dm04ContactRegistry'
import type { ISigner } from '@/stores/userStore'
import type { Event } from 'nostr-tools'
import { playSoundEffect } from '@/lib/voice/soundEffects'

/** Unix timestamp (seconds) of when this session started — DM sounds only play for messages after this */
const dm04SessionStartTime = Math.floor(Date.now() / 1000)

/* ─── Types ─── */

export interface DM04Message {
  id: string             // event id
  content: string        // decrypted content
  senderPubkey: string
  recipientPubkey: string
  createdAt: number
  isMine: boolean
  replyTo?: string       // event id of the message being replied to
  rootRef?: string       // event id of thread root
  isThread?: boolean     // true = thread reply (hidden from main, shown in thread modal)
  deleted?: boolean
  clientTag?: string
  rawEvent?: string      // raw event JSON for "View Raw"
  emojiTags?: [string, string, string?][]    // decrypted [shortcode, url, set-ref?]
  stickerTags?: [string, string, string?][]  // decrypted [shortcode, url, set-ref?]
  gifTags?: [string, string, string][]        // decrypted [name, url, nsfw]
}

export interface DM04Conversation {
  pubkey: string          // counterparty pubkey
  messages: DM04Message[]
  lastMessageAt: number
  lastMessagePreview: string
  unread: number
  oldestTimestamp: number  // oldest event timestamp for pagination
  hasMore: boolean
}

/** Emoji reaction on a DM04 message */
export interface DM04Reaction {
  emoji: string
  count: number
  reacted: boolean       // did current user react with this
  customUrl?: string     // image URL for NIP-30 custom emoji
}

interface DM04State {
  conversations: Map<string, DM04Conversation>
  activeConversation: string | null
  pendingConversations: Set<string>
  loading: boolean
  loadingOlder: boolean
  processedIds: Set<string>
  subscription: { close: () => void } | null

  /** Reactions: messageId → emoji → { users, customUrl? } */
  reactions: Map<string, Map<string, { users: Set<string>; customUrl?: string }>>
  /** Processed reaction event IDs */
  processedReactionIds: Set<string>
  reactionSub: { close: () => void } | null

  /** NIP-78 contact registry (populated from relay on startup) */
  contactRegistry: DM04ContactRegistry | null
  /** Whether the per-person fetch cycle has completed */
  perPersonFetchDone: boolean
  /** Contacts discovered from Track A (raw feed) not yet reconciled with registry */
  pendingNewContacts: Map<string, Event[]>
  /** Contacts loaded from NIP-78 registry that haven't been per-person fetched yet */
  registryOnlyContacts: Set<string>

  /** Relay publish progress per event ID (for inline indicators on real messages) */
  relayProgress: Record<string, { confirmed: number; total: number; acceptedRelays: string[] }>

  setActiveConversation: (pubkey: string | null) => void
  addPendingConversation: (pubkey: string) => void
  removePendingConversation: (pubkey: string) => void
  startSubscription: (
    myPubkey: string,
    signer: ISigner | null,
    privateKey: string | null,
  ) => void
  stopSubscription: () => void
  loadOlderMessages: (
    counterpartyPubkey: string,
    myPubkey: string,
    signer: ISigner | null,
    privateKey: string | null,
  ) => Promise<void>
  sendMessage: (
    recipientPubkey: string,
    content: string,
    myPubkey: string,
    signer: ISigner | null,
    privateKey: string | null,
    replyTo?: string,
    rootRef?: string,
    isThread?: boolean,
    onPhase?: (phase: 'publishing', relayProgress?: { confirmed: number; total: number }) => void,
    emojiTags?: [string, string, string, string][],
    stickerTags?: [string, string, string, string][],
    gifTags?: [string, string, string, string][],
  ) => Promise<void>
  deleteMessage: (
    eventId: string,
    myPubkey: string,
    signer: ISigner | null,
    privateKey: string | null,
  ) => Promise<void>
  addReaction: (
    targetEventId: string,
    targetPubkey: string,
    emoji: string,
    myPubkey: string,
    recipientPubkey: string,
    signer: ISigner | null,
    privateKey: string | null,
    customUrl?: string,
  ) => Promise<void>
  getReactions: (messageId: string, myPubkey: string) => DM04Reaction[]
  getFilteredConversations: (followList: Set<string>) => {
    following: DM04Conversation[]
    other: DM04Conversation[]
  }
  setRelayProgress: (eventId: string, confirmed: number, total: number, acceptedRelays?: string[]) => void
  clearRelayProgress: (eventId: string) => void
}

/** Pagination batch size */
const PAGE_SIZE = 50
/** Max messages per conversation in memory (FIFO eviction) */
const MAX_PER_CONVERSATION = 1000

/** Module-level credentials set by startSubscription for priority fetch */
let _myPubkey: string | null = null
let _signer: ISigner | null = null
let _privateKey: string | null = null
/** Set of pubkeys that have already been priority-fetched (avoids re-fetch on each click) */
const _priorityFetched = new Set<string>()

/* ─── Store ─── */

export const useDM04Store = create<DM04State>((set, get) => ({
  conversations: new Map(),
  activeConversation: null,
  pendingConversations: new Set(),
  loading: false,
  loadingOlder: false,
  processedIds: new Set(),
  subscription: null,
  reactions: new Map(),
  processedReactionIds: new Set(),
  reactionSub: null,
  contactRegistry: null,
  perPersonFetchDone: false,
  pendingNewContacts: new Map(),
  registryOnlyContacts: new Set(),
  relayProgress: {},

  setActiveConversation: (pubkey) => {
    console.log('[DM04] setActiveConversation called:', pubkey?.slice(0, 12))
    set((s) => {
      if (pubkey) {
        const conversations = new Map(s.conversations)
        const conv = conversations.get(pubkey)
        if (conv && conv.unread > 0) {
          console.log('[DM04] Clearing unread for:', pubkey.slice(0, 12), 'was:', conv.unread)
          conv.unread = 0
          return { activeConversation: pubkey, conversations }
        }
        // If no conversation exists yet, add as pending so the DM UI shows it
        if (!conv && !s.pendingConversations.has(pubkey)) {
          const pending = new Set(s.pendingConversations)
          pending.add(pubkey)
          return { activeConversation: pubkey, pendingConversations: pending }
        }
      }
      return { activeConversation: pubkey }
    })
    // Persist read timestamp OUTSIDE the set() callback so it reliably fires
    if (pubkey) {
      console.log('[DM04] Calling markDmRead for:', pubkey.slice(0, 12))
      useNotificationStore.getState().markDmRead(pubkey, 'nip04')

      // Priority fetch: if conversation has no messages and Track B hasn't finished,
      // immediately fetch this contact's messages instead of waiting for the queue
      const state = get()
      const conv = state.conversations.get(pubkey)
      const hasNoMessages = !conv || conv.messages.length === 0
      if (hasNoMessages && !state.perPersonFetchDone && !_priorityFetched.has(pubkey) && _myPubkey) {
        _priorityFetched.add(pubkey)
        console.log(`[DM04] Priority fetch for ${pubkey.slice(0, 12)}…`)
        fetchPerPerson(pubkey, _myPubkey, _signer, _privateKey, set, get)
          .catch((err) => console.warn(`[DM04] Priority fetch failed for ${pubkey.slice(0, 12)}…:`, err))
      }
    }
  },

  addPendingConversation: (pubkey) => {
    set((s) => {
      const next = new Set(s.pendingConversations)
      next.add(pubkey)
      return { pendingConversations: next }
    })
  },

  removePendingConversation: (pubkey) => {
    set((s) => {
      const next = new Set(s.pendingConversations)
      next.delete(pubkey)
      return { pendingConversations: next }
    })
  },

  /**
   * Start subscription for NIP-04 DMs (kind 4).
   *
   * Two-track architecture:
   * - Track A: Raw feed (last 100 events + live subscription) — immediate UI
   * - Track B: NIP-78 contact registry + per-person fetch — background, comprehensive
   *
   * Also subscribes to kind 7 reactions on our DM events.
   */
  startSubscription: (myPubkey, signer, privateKey) => {
    if (!privateKey && !signer?.nip04) {
      console.warn('[DM04] NIP-04 encryption not available — NIP-04 DMs disabled')
      set({ loading: false })
      return
    }

    // Close existing subs
    get().subscription?.close()
    get().reactionSub?.close()

    set({ loading: true, perPersonFetchDone: false, pendingNewContacts: new Map(), registryOnlyContacts: new Set() })

    // Store credentials for priority fetch
    _myPubkey = myPubkey
    _signer = signer
    _privateKey = privateKey
    _priorityFetched.clear()

    // ─── Track A: Raw Feed (immediate UI) ───
    // Fetch last 100 NIP-04 events + keep live subscription open.
    // Extract unique counterparties as events arrive for later NIP-78 reconciliation.

    let initialPhase = true
    const msgBuffer: DM04Message[] = []
    const counterpartyBuffer: string[] = []
    let trackAReceivedCount = 0
    let trackASentCount = 0

    const onDMEvent = async (event: Event) => {
      const state = get()
      if (state.processedIds.has(event.id)) return

      set((s) => ({
        processedIds: new Set(s.processedIds).add(event.id),
      }))

      // Track counterparty for NIP-78 reconciliation (metadata only — no decrypt needed)
      const isMine = event.pubkey === myPubkey
      if (isMine) trackASentCount++; else trackAReceivedCount++
      const recipientTag = event.tags.find((t) => t[0] === 'p')
      const counterparty = isMine ? recipientTag?.[1] : event.pubkey
      if (counterparty) {
        set((s) => {
          const pending = new Map(s.pendingNewContacts)
          if (!pending.has(counterparty)) pending.set(counterparty, [])
          pending.get(counterparty)!.push(event)
          return { pendingNewContacts: pending }
        })
      }

      if (initialPhase) {
        await processNip04EventBuffered(event, myPubkey, signer, privateKey, msgBuffer, counterpartyBuffer)
        // If EOSE fired while we were awaiting decrypt, the buffer was already flushed
        // and cleared. Any messages we just pushed are orphaned — flush them directly.
        if (!initialPhase && msgBuffer.length > 0) {
          set((s) => {
            const conversations = new Map(s.conversations)
            for (let i = 0; i < msgBuffer.length; i++) {
              addDM04ToConversations(conversations, msgBuffer[i], counterpartyBuffer[i])
            }
            return { conversations }
          })
          msgBuffer.length = 0
          counterpartyBuffer.length = 0
        }
      } else {
        await processNip04Event(event, myPubkey, signer, privateKey, set, get)
      }
    }

    let eoseCount = 0
    const onEose = () => {
      eoseCount++
      if (eoseCount >= 2) {
        initialPhase = false

        console.log(`[DM04:TrackA] EOSE — received: ${trackAReceivedCount}, sent: ${trackASentCount}, decrypted: ${msgBuffer.length}`)

        // Flush all buffered messages in a single state update
        if (msgBuffer.length > 0) {
          set((s) => {
            const conversations = new Map(s.conversations)
            for (let i = 0; i < msgBuffer.length; i++) {
              addDM04ToConversations(conversations, msgBuffer[i], counterpartyBuffer[i])
            }
            return { conversations }
          })
          msgBuffer.length = 0
          counterpartyBuffer.length = 0
        }

        set({ loading: false })

        // Recalculate unreads using notification store's persistent lastRead timestamps
        const recalcUnreads = () => {
          const notifState = useNotificationStore.getState()
          if (!notifState.initialized) {
            setTimeout(recalcUnreads, 1500)
            return
          }
          set((s) => {
            const conversations = new Map(s.conversations)
            let changed = false
            for (const [pubkey, conv] of conversations) {
              const lastRead = notifState.dm04Unreads[pubkey]?.lastRead ?? 0
              const trueUnread = lastRead > 0
                ? conv.messages.filter(m => !m.isMine && m.createdAt > lastRead).length
                : conv.unread
              if (lastRead > 0 && trueUnread !== conv.unread) {
                conv.unread = trueUnread
                changed = true
              }
            }
            return changed ? { conversations } : {}
          })
        }
        recalcUnreads()
      }
    }

    // Track A subscriptions: last 100 events + live
    const TRACK_A_LIMIT = 100

    const subReceived = subscribeEvents(
      { kinds: [STANDARD_KINDS.NIP04_DM], '#p': [myPubkey], limit: TRACK_A_LIMIT },
      onDMEvent,
      onEose,
    )

    const subSent = subscribeEvents(
      { kinds: [STANDARD_KINDS.NIP04_DM], authors: [myPubkey], limit: TRACK_A_LIMIT },
      onDMEvent,
      onEose,
    )

    const sub = {
      close: () => {
        subReceived.close()
        subSent.close()
      },
    }

    // Reaction subscriptions (unchanged)
    const onReactionEvent = async (event: Event) => {
      const state = get()
      if (state.processedReactionIds.has(event.id)) return

      set((s) => ({
        processedReactionIds: new Set(s.processedReactionIds).add(event.id),
      }))

      await processReactionEvent(event, myPubkey, signer, privateKey, set, get)
    }

    const reactionSubReceived = subscribeEvents(
      { kinds: [STANDARD_KINDS.REACTION], '#p': [myPubkey], limit: TRACK_A_LIMIT },
      onReactionEvent,
    )
    const reactionSubSent = subscribeEvents(
      { kinds: [STANDARD_KINDS.REACTION], authors: [myPubkey], limit: TRACK_A_LIMIT },
      onReactionEvent,
    )

    const reactionSub = {
      close: () => {
        reactionSubReceived.close()
        reactionSubSent.close()
      },
    }

    set({ subscription: sub, reactionSub })

    // ─── Track B: NIP-78 Registry + Per-Person Fetch (background) ───
    // Runs independently of Track A — populates sidebar with all known contacts.
    runContactRegistryTrack(myPubkey, signer, privateKey, set, get)
  },

  stopSubscription: () => {
    get().subscription?.close()
    get().reactionSub?.close()
    set({ subscription: null, reactionSub: null })
  },

  loadOlderMessages: async (counterpartyPubkey, myPubkey, signer, privateKey) => {
    if (!privateKey && !signer?.nip04) return

    const state = get()
    if (state.loadingOlder) return

    const conv = state.conversations.get(counterpartyPubkey)
    if (conv && !conv.hasMore) return

    set({ loadingOlder: true })

    try {
      const until = conv?.oldestTimestamp || Math.floor(Date.now() / 1000)

      // Fetch both sent and received
      const [receivedEvents, sentEvents] = await Promise.all([
        fetchEvents({
          kinds: [STANDARD_KINDS.NIP04_DM],
          '#p': [myPubkey],
          authors: [counterpartyPubkey],
          until: until - 1,
          limit: PAGE_SIZE,
        }),
        fetchEvents({
          kinds: [STANDARD_KINDS.NIP04_DM],
          authors: [myPubkey],
          '#p': [counterpartyPubkey],
          until: until - 1,
          limit: PAGE_SIZE,
        }),
      ])

      const events = [...receivedEvents, ...sentEvents]

      for (const event of events) {
        if (state.processedIds.has(event.id)) continue
        set((s) => ({
          processedIds: new Set(s.processedIds).add(event.id),
        }))
        await processNip04Event(event, myPubkey, signer, privateKey, set, get)
      }

      // Update hasMore
      set((s) => {
        const conversations = new Map(s.conversations)
        const conv = conversations.get(counterpartyPubkey)
        if (conv) {
          conv.messages.sort((a, b) => a.createdAt - b.createdAt)
          if (events.length < PAGE_SIZE) {
            conv.hasMore = false
          }
        }
        return { conversations, loadingOlder: false }
      })
    } catch (err) {
      console.error('[DM04] Failed to load older messages:', err)
      set({ loadingOlder: false })
    }
  },

  sendMessage: async (recipientPubkey, content, myPubkey, signer, privateKey, replyTo, rootRef, isThread, onPhase, emojiTags, stickerTags, gifTags) => {
    if (!privateKey && !signer?.nip04) {
      throw new Error('NIP-04 encryption is not available with your current login method.')
    }

    try {
      const sendTime = Math.floor(Date.now() / 1000)
      const encrypted = await encryptNip04(content, recipientPubkey, signer, privateKey)

      const tags: [string, ...string[]][] = [
        ['p', recipientPubkey],
      ]

      // Reply tags (NIP-10 e-tags)
      if (replyTo) {
        tags.push(['e', rootRef || replyTo, '', 'root'])
        tags.push(['e', replyTo, '', 'reply'])
      }

      // Thread marker
      if (isThread) {
        tags.push(['thread'])
      }

      // NIP-04-encrypt emoji tags
      if (emojiTags && emojiTags.length > 0) {
        for (const tag of emojiTags) {
          const encSc = await encryptNip04(tag[1], recipientPubkey, signer, privateKey)
          const encUrl = await encryptNip04(tag[2], recipientPubkey, signer, privateKey)
          const encSet = tag[3] ? await encryptNip04(tag[3], recipientPubkey, signer, privateKey) : ''
          tags.push(['emoji', encSc, encUrl, ...(encSet ? [encSet] : [])])
        }
      }

      // NIP-04-encrypt sticker tags
      if (stickerTags && stickerTags.length > 0) {
        for (const tag of stickerTags) {
          const encSc = await encryptNip04(tag[1], recipientPubkey, signer, privateKey)
          const encUrl = await encryptNip04(tag[2], recipientPubkey, signer, privateKey)
          const encSet = tag[3] ? await encryptNip04(tag[3], recipientPubkey, signer, privateKey) : ''
          tags.push(['sticker', encSc, encUrl, ...(encSet ? [encSet] : [])])
        }
      }

      // NIP-04-encrypt GIF tags
      if (gifTags && gifTags.length > 0) {
        for (const tag of gifTags) {
          const encName = await encryptNip04(tag[1], recipientPubkey, signer, privateKey)
          const encUrl = await encryptNip04(tag[2], recipientPubkey, signer, privateKey)
          const encNsfw = tag[3] ? await encryptNip04(tag[3], recipientPubkey, signer, privateKey) : ''
          tags.push(['j', encName, encUrl, ...(encNsfw ? [encNsfw] : [])])
        }
      }

      // Client tag
      if (typeof window !== 'undefined' && localStorage.getItem('den-chat-client-tag') !== 'false') {
        tags.push(['client', 'DEN Chat'])
      }

      const unsigned = createUnsignedEvent(STANDARD_KINDS.NIP04_DM, encrypted, tags)
      const signed = await signWithSigner(unsigned, signer, privateKey)

      // Pre-register
      set((s) => ({
        processedIds: new Set(s.processedIds).add(signed.id),
      }))

      // Publish with progressive relay tracking
      onPhase?.('publishing')
      const publishRelays = getPublishRelays()
      // Discover recipient's preferred relays (NIP-65 + DM relay list + DNN metadata)
      const { discoverRecipientRelays } = await import('@/lib/nostr/relayDiscovery')
      const extraRelays = await discoverRecipientRelays(recipientPubkey, publishRelays)
      const allRelays = extraRelays.length > 0
        ? [...publishRelays, ...extraRelays]
        : publishRelays

      if (extraRelays.length > 0) {
        console.log(`[DM04] Merging ${extraRelays.length} recipient relay(s):`, extraRelays)
      }

      await publishEventProgressive(
        signed,
        (confirmed, total, acceptedRelays) => {
          get().setRelayProgress(signed.id, confirmed, total, acceptedRelays)
          onPhase?.('publishing', { confirmed, total })
        },
        allRelays.length > 0 ? allRelays : undefined,
      )

      // Auto-clear relay progress after 5 seconds
      setTimeout(() => {
        get().clearRelayProgress(signed.id)
      }, 5000)

      // Remove from pending
      get().removePendingConversation(recipientPubkey)

      // Add locally
      const msg: DM04Message = {
        id: signed.id,
        content,
        senderPubkey: myPubkey,
        recipientPubkey,
        createdAt: sendTime,
        isMine: true,
        replyTo,
        rootRef,
        isThread,
        clientTag: typeof window !== 'undefined' && localStorage.getItem('den-chat-client-tag') !== 'false' ? 'DEN Chat' : undefined,
        rawEvent: JSON.stringify(signed),
        emojiTags: emojiTags?.map((t) => [t[1], t[2], t[3] || undefined] as [string, string, string?]),
        stickerTags: stickerTags?.map((t) => [t[1], t[2], t[3] || undefined] as [string, string, string?]),
        gifTags: gifTags?.map((t) => [t[1], t[2], t[3] || 'sfw'] as [string, string, string]),
      }

      set((s) => {
        const conversations = new Map(s.conversations)
        const existing = conversations.get(recipientPubkey)
        if (existing) {
          const isDupe = existing.messages.some(
            (m) => m.id === msg.id || (m.isMine && m.content === msg.content && Math.abs(m.createdAt - msg.createdAt) < 5)
          )
          if (!isDupe) {
            const newMessages = [...existing.messages, msg].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
            conversations.set(recipientPubkey, {
              ...existing,
              messages: newMessages,
              lastMessageAt: msg.createdAt,
              lastMessagePreview: content.slice(0, 80),
            })
          }
        } else {
          conversations.set(recipientPubkey, {
            pubkey: recipientPubkey,
            messages: [msg],
            lastMessageAt: msg.createdAt,
            lastMessagePreview: content.slice(0, 80),
            unread: 0,
            oldestTimestamp: sendTime,
            hasMore: true,
          })
        }
        return { conversations }
      })
    } catch (err) {
      console.error('[DM04] Failed to send message:', err)
      throw err
    }
  },

  deleteMessage: async (eventId, myPubkey, signer, privateKey) => {
    if (!signer && !privateKey) return

    // NIP-09 deletion
    const tags: [string, ...string[]][] = [['e', eventId]]
    const unsigned = createUnsignedEvent(STANDARD_KINDS.DELETION, 'User requested deletion', tags)
    const signed = await signWithSigner(unsigned, signer, privateKey)

    const publishRelays = getPublishRelays()
    await publishToSpecificRelays(publishRelays, signed)

    // Mark deleted locally (immutable update)
    set((s) => {
      const conversations = new Map(s.conversations)
      for (const [key, conv] of conversations) {
        const idx = conv.messages.findIndex((m) => m.id === eventId)
        if (idx >= 0) {
          const newMessages = conv.messages.map((m) =>
            m.id === eventId ? { ...m, deleted: true } : m
          )
          conversations.set(key, { ...conv, messages: newMessages })
          break
        }
      }
      return { conversations }
    })
  },

  addReaction: async (targetEventId, targetPubkey, emoji, myPubkey, recipientPubkey, signer, privateKey, customUrl) => {
    if (!privateKey && !signer?.nip04) return

    // NIP-25: content = encrypted emoji string
    const counterparty = targetPubkey === myPubkey ? recipientPubkey : targetPubkey
    const encryptedEmoji = await encryptNip04(emoji, counterparty, signer, privateKey)

    const tags: [string, ...string[]][] = [
      ['e', targetEventId],
      ['p', targetPubkey],
    ]

    // NIP-30: add encrypted emoji tag for custom emoji (shortcode + URL individually encrypted)
    if (customUrl) {
      const scMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/)
      const shortcode = scMatch ? scMatch[1] : emoji
      const encSc = await encryptNip04(shortcode, counterparty, signer, privateKey)
      const encUrl = await encryptNip04(customUrl, counterparty, signer, privateKey)
      tags.push(['emoji', encSc, encUrl])
    }

    const unsigned = createUnsignedEvent(STANDARD_KINDS.REACTION, encryptedEmoji, tags)
    const signed = await signWithSigner(unsigned, signer, privateKey)

    // Pre-register
    set((s) => ({
      processedReactionIds: new Set(s.processedReactionIds).add(signed.id),
    }))

    const publishRelays = getPublishRelays()
    await publishToSpecificRelays(publishRelays, signed)

    // Add locally
    set((s) => {
      const reactions = new Map(s.reactions)
      if (!reactions.has(targetEventId)) {
        reactions.set(targetEventId, new Map())
      }
      const msgReactions = reactions.get(targetEventId)!
      if (!msgReactions.has(emoji)) {
        msgReactions.set(emoji, { users: new Set(), customUrl })
      }
      msgReactions.get(emoji)!.users.add(myPubkey)
      return { reactions }
    })
  },

  getReactions: (messageId, myPubkey) => {
    const state = get()
    const msgReactions = state.reactions.get(messageId)
    if (!msgReactions) return []

    const result: DM04Reaction[] = []
    for (const [emoji, data] of msgReactions) {
      result.push({
        emoji,
        count: data.users.size,
        reacted: data.users.has(myPubkey),
        customUrl: data.customUrl,
      })
    }
    return result
  },

  getFilteredConversations: (followList) => {
    const { conversations, pendingConversations } = get()
    const blockedPubkeys = useBlockStore.getState().blockedPubkeys

    const following: DM04Conversation[] = []
    const other: DM04Conversation[] = []

    for (const [pubkey, conv] of conversations) {
      if (blockedPubkeys.has(pubkey)) continue
      if (useWotStore.getState().shouldHide(pubkey, 'dms')) continue
      if (followList.has(pubkey)) {
        following.push(conv)
      } else {
        other.push(conv)
      }
    }

    // Add pending conversations
    for (const pk of pendingConversations) {
      if (blockedPubkeys.has(pk)) continue
      if (!conversations.has(pk)) {
        const empty: DM04Conversation = {
          pubkey: pk,
          messages: [],
          lastMessageAt: Math.floor(Date.now() / 1000),
          lastMessagePreview: '',
          unread: 0,
          oldestTimestamp: Math.floor(Date.now() / 1000),
          hasMore: false,
        }
        if (followList.has(pk)) {
          following.push(empty)
        } else {
          other.push(empty)
        }
      }
    }

    const sortFn = (a: DM04Conversation, b: DM04Conversation) => b.lastMessageAt - a.lastMessageAt
    following.sort(sortFn)
    other.sort(sortFn)

    return { following, other }
  },

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
}))

/* ─── Helpers ─── */

function sortedInsertIndex(messages: DM04Message[], createdAt: number, id: string): number {
  let lo = 0
  let hi = messages.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    const m = messages[mid]
    if (m.createdAt < createdAt || (m.createdAt === createdAt && m.id < id)) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  return lo
}

/** Process an incoming kind 4 event */
async function processNip04Event(
  event: Event,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  set: (fn: (s: DM04State) => Partial<DM04State>) => void,
  get: () => DM04State,
) {
  const isMine = event.pubkey === myPubkey
  const recipientTag = event.tags.find((t) => t[0] === 'p')
  const recipientPubkey = recipientTag?.[1]
  if (!recipientPubkey) return

  const counterparty = isMine ? recipientPubkey : event.pubkey

  // Decrypt content
  let content: string
  try {
    content = await decryptNip04(event.content, isMine ? recipientPubkey : event.pubkey, signer, privateKey)
  } catch (err) {
    console.warn(`[DM04] Decrypt failed for ${isMine ? 'sent' : 'received'} event ${event.id.slice(0, 12)}… (counterparty: ${counterparty.slice(0, 12)}…):`, err)
    return // Can't decrypt — skip
  }

  // Parse reply tags (NIP-10)
  let replyTo: string | undefined
  let rootRef: string | undefined
  const eTags = event.tags.filter((t) => t[0] === 'e')
  for (const tag of eTags) {
    const marker = tag[3]
    if (marker === 'reply') replyTo = tag[1]
    else if (marker === 'root') rootRef = tag[1]
  }
  // Fallback: if only one e-tag without markers, treat as reply
  if (!replyTo && !rootRef && eTags.length === 1) {
    replyTo = eTags[0][1]
  }

  const isThread = event.tags.some((t) => t[0] === 'thread')
  const clientTag = event.tags.find((t) => t[0] === 'client')?.[1]
  const deleted = event.tags.some((t) => t[0] === 'deleted')

  // Decrypt emoji tags
  let emojiTags: [string, string, string?][] | undefined
  const rawEmojiTags = event.tags.filter((t: string[]) => t[0] === 'emoji' && t[1] && t[2])
  if (rawEmojiTags.length > 0) {
    emojiTags = []
    for (const tag of rawEmojiTags) {
      let sc = tag[1], url = tag[2], setRef: string | undefined = tag[3]
      try { sc = await decryptNip04(sc, counterparty, signer, privateKey) } catch { /* cleartext */ }
      try { url = await decryptNip04(url, counterparty, signer, privateKey) } catch { /* cleartext */ }
      if (setRef) { try { setRef = await decryptNip04(setRef, counterparty, signer, privateKey) } catch { /* cleartext */ } }
      emojiTags.push([sc, url, setRef])
    }
  }

  // Decrypt sticker tags
  let stickerTags: [string, string, string?][] | undefined
  const rawStickerTags = event.tags.filter((t: string[]) => t[0] === 'sticker' && t[1] && t[2])
  if (rawStickerTags.length > 0) {
    stickerTags = []
    for (const tag of rawStickerTags) {
      let sc = tag[1], url = tag[2], setRef: string | undefined = tag[3]
      try { sc = await decryptNip04(sc, counterparty, signer, privateKey) } catch { /* cleartext */ }
      try { url = await decryptNip04(url, counterparty, signer, privateKey) } catch { /* cleartext */ }
      if (setRef) { try { setRef = await decryptNip04(setRef, counterparty, signer, privateKey) } catch { /* cleartext */ } }
      stickerTags.push([sc, url, setRef])
    }
  }

  const msg: DM04Message = {
    id: event.id,
    content,
    senderPubkey: event.pubkey,
    recipientPubkey,
    createdAt: event.created_at,
    isMine,
    replyTo,
    rootRef,
    isThread,
    deleted,
    clientTag,
    rawEvent: JSON.stringify(event),
    emojiTags,
    stickerTags,
  }

  // Decrypt GIF tags
  let gifTags: [string, string, string][] | undefined
  const rawGifTags = event.tags.filter((t: string[]) => t[0] === 'j' && t[2])
  if (rawGifTags.length > 0) {
    gifTags = []
    for (const tag of rawGifTags) {
      let name = tag[1] || '', url = tag[2], nsfw = tag[3] || 'sfw'
      try { name = await decryptNip04(name, counterparty, signer, privateKey) } catch { /* cleartext */ }
      try { url = await decryptNip04(url, counterparty, signer, privateKey) } catch { /* cleartext */ }
      try { nsfw = await decryptNip04(nsfw, counterparty, signer, privateKey) } catch { /* cleartext */ }
      gifTags.push([name, url, nsfw])
    }
    if (gifTags.length > 0) msg.gifTags = gifTags
  }

  set((s) => {
    const conversations = new Map(s.conversations)
    addDM04ToConversations(conversations, msg, counterparty)
    return { conversations }
  })
}

/**
 * Buffered variant of processNip04Event — decrypts the event and pushes
 * the resulting DM04Message + counterparty into the provided arrays
 * instead of writing to the store. Used during initial load to enable
 * a single batched state update at EOSE.
 */
async function processNip04EventBuffered(
  event: Event,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  msgBuffer: DM04Message[],
  counterpartyBuffer: string[],
) {
  const isMine = event.pubkey === myPubkey
  const recipientTag = event.tags.find((t) => t[0] === 'p')
  const recipientPubkey = recipientTag?.[1]
  if (!recipientPubkey) return

  const counterparty = isMine ? recipientPubkey : event.pubkey

  // Decrypt content
  let content: string
  try {
    content = await decryptNip04(event.content, isMine ? recipientPubkey : event.pubkey, signer, privateKey)
  } catch (err) {
    console.warn(`[DM04] Decrypt failed for ${isMine ? 'sent' : 'received'} event ${event.id.slice(0, 12)}… (counterparty: ${counterparty.slice(0, 12)}…):`, err)
    return // Can't decrypt — skip
  }

  // Parse reply tags (NIP-10)
  let replyTo: string | undefined
  let rootRef: string | undefined
  const eTags = event.tags.filter((t) => t[0] === 'e')
  for (const tag of eTags) {
    const marker = tag[3]
    if (marker === 'reply') replyTo = tag[1]
    else if (marker === 'root') rootRef = tag[1]
  }
  if (!replyTo && !rootRef && eTags.length === 1) {
    replyTo = eTags[0][1]
  }

  const isThread = event.tags.some((t) => t[0] === 'thread')
  const clientTag = event.tags.find((t) => t[0] === 'client')?.[1]
  const deleted = event.tags.some((t) => t[0] === 'deleted')

  // Decrypt emoji tags
  let emojiTags: [string, string, string?][] | undefined
  const rawEmojiTags = event.tags.filter((t: string[]) => t[0] === 'emoji' && t[1] && t[2])
  if (rawEmojiTags.length > 0) {
    emojiTags = []
    for (const tag of rawEmojiTags) {
      let sc = tag[1], url = tag[2], setRef: string | undefined = tag[3]
      try { sc = await decryptNip04(sc, counterparty, signer, privateKey) } catch { /* cleartext */ }
      try { url = await decryptNip04(url, counterparty, signer, privateKey) } catch { /* cleartext */ }
      if (setRef) { try { setRef = await decryptNip04(setRef, counterparty, signer, privateKey) } catch { /* cleartext */ } }
      emojiTags.push([sc, url, setRef])
    }
  }

  // Decrypt sticker tags
  let stickerTags: [string, string, string?][] | undefined
  const rawStickerTags = event.tags.filter((t: string[]) => t[0] === 'sticker' && t[1] && t[2])
  if (rawStickerTags.length > 0) {
    stickerTags = []
    for (const tag of rawStickerTags) {
      let sc = tag[1], url = tag[2], setRef: string | undefined = tag[3]
      try { sc = await decryptNip04(sc, counterparty, signer, privateKey) } catch { /* cleartext */ }
      try { url = await decryptNip04(url, counterparty, signer, privateKey) } catch { /* cleartext */ }
      if (setRef) { try { setRef = await decryptNip04(setRef, counterparty, signer, privateKey) } catch { /* cleartext */ } }
      stickerTags.push([sc, url, setRef])
    }
  }

  const msg: DM04Message = {
    id: event.id,
    content,
    senderPubkey: event.pubkey,
    recipientPubkey,
    createdAt: event.created_at,
    isMine,
    replyTo,
    rootRef,
    isThread,
    deleted,
    clientTag,
    rawEvent: JSON.stringify(event),
    emojiTags,
    stickerTags,
  }

  // Decrypt GIF tags
  let gifTags: [string, string, string][] | undefined
  const rawGifTags = event.tags.filter((t: string[]) => t[0] === 'j' && t[2])
  if (rawGifTags.length > 0) {
    gifTags = []
    for (const tag of rawGifTags) {
      let name = tag[1] || '', url = tag[2], nsfw = tag[3] || 'sfw'
      try { name = await decryptNip04(name, counterparty, signer, privateKey) } catch { /* cleartext */ }
      try { url = await decryptNip04(url, counterparty, signer, privateKey) } catch { /* cleartext */ }
      try { nsfw = await decryptNip04(nsfw, counterparty, signer, privateKey) } catch { /* cleartext */ }
      gifTags.push([name, url, nsfw])
    }
    if (gifTags.length > 0) msg.gifTags = gifTags
  }

  // Push to buffers instead of writing to store
  msgBuffer.push(msg)
  counterpartyBuffer.push(counterparty)
}

/** Process an incoming kind 7 reaction event */
async function processReactionEvent(
  event: Event,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  set: (fn: (s: DM04State) => Partial<DM04State>) => void,
  _get: () => DM04State,
) {
  // Find the target message e-tag
  const eTag = event.tags.find((t) => t[0] === 'e')
  if (!eTag) return
  const targetEventId = eTag[1]

  // Determine counterparty for decryption
  const pTag = event.tags.find((t) => t[0] === 'p')
  const isMine = event.pubkey === myPubkey
  const counterparty = isMine ? pTag?.[1] : event.pubkey
  if (!counterparty) return

  // NIP-25: decrypt emoji from content
  let emoji: string
  let customUrl: string | undefined
  try {
    emoji = await decryptNip04(event.content, counterparty, signer, privateKey)
  } catch {
    // Fallback to plaintext (might be from another client)
    emoji = event.content || '❤️'
  }

  // NIP-30: decrypt emoji tag for custom emoji URL
  const emojiTag = event.tags.find((t) => t[0] === 'emoji' && t[1] && t[2])
  if (emojiTag) {
    try {
      const decUrl = await decryptNip04(emojiTag[2], counterparty, signer, privateKey)
      if (decUrl && decUrl.startsWith('http')) {
        customUrl = decUrl
      }
    } catch {
      // Tag might be cleartext from another client
      if (emojiTag[2].startsWith('http')) {
        customUrl = emojiTag[2]
      }
    }
  }

  // Normalize empty/invalid emoji
  if (!emoji || emoji.length > 32) emoji = '❤️'

  set((s) => {
    const reactions = new Map(s.reactions)
    if (!reactions.has(targetEventId)) {
      reactions.set(targetEventId, new Map())
    }
    const msgReactions = reactions.get(targetEventId)!
    if (!msgReactions.has(emoji)) {
      msgReactions.set(emoji, { users: new Set(), customUrl })
    }
    msgReactions.get(emoji)!.users.add(event.pubkey)
    return { reactions }
  })
}

function addDM04ToConversations(
  conversations: Map<string, DM04Conversation>,
  msg: DM04Message,
  counterparty: string,
) {
  // Check if this message was already read (persisted in notification store)
  const lastRead = useNotificationStore.getState().dm04Unreads[counterparty]?.lastRead ?? 0
  const isAlreadyRead = lastRead > 0 && msg.createdAt <= lastRead

  // Check if the user is currently viewing this conversation
  const isActiveConv = useDM04Store.getState().activeConversation === counterparty

  const existing = conversations.get(counterparty)
  if (existing) {
    // Dedup by id
    if (existing.messages.some((m) => m.id === msg.id)) return
    // Dedup by content+sender
    if (msg.isMine && existing.messages.some((m) => m.isMine && m.content === msg.content && Math.abs(m.createdAt - msg.createdAt) < 10)) return

    let newMessages = [...existing.messages, msg].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

    // FIFO cap: trim oldest-cached (front of sorted array) when over limit
    if (newMessages.length > MAX_PER_CONVERSATION) {
      newMessages = newMessages.slice(newMessages.length - MAX_PER_CONVERSATION)
    }

    // If user is viewing this conversation, mark read immediately instead of incrementing badge
    let newUnread = existing.unread
    if (!msg.isMine) {
      if (isActiveConv) {
        newUnread = 0
        useNotificationStore.getState().markDmRead(counterparty, 'nip04')
      } else if (!isAlreadyRead) {
        newUnread = existing.unread + 1
      }
      // Play DM sound for real-time messages from followed users
      if (msg.createdAt >= dm04SessionStartTime && useFollowStore.getState().followedPubkeys.has(counterparty)) {
        playSoundEffect('dm_message')
      }
    }

    conversations.set(counterparty, {
      ...existing,
      messages: newMessages,
      lastMessageAt: msg.createdAt > existing.lastMessageAt ? msg.createdAt : existing.lastMessageAt,
      lastMessagePreview: msg.createdAt > existing.lastMessageAt || !existing.lastMessagePreview
        ? msg.content.slice(0, 80)
        : existing.lastMessagePreview,
      oldestTimestamp: msg.createdAt < existing.oldestTimestamp ? msg.createdAt : existing.oldestTimestamp,
      unread: newUnread,
    })
  } else {
    if (isActiveConv && !msg.isMine) {
      useNotificationStore.getState().markDmRead(counterparty, 'nip04')
    }
    // Play DM sound for real-time messages from followed users (new conversation)
    if (!msg.isMine && msg.createdAt >= dm04SessionStartTime && useFollowStore.getState().followedPubkeys.has(counterparty)) {
      playSoundEffect('dm_message')
    }
    conversations.set(counterparty, {
      pubkey: counterparty,
      messages: [msg],
      lastMessageAt: msg.createdAt,
      lastMessagePreview: msg.content.slice(0, 80),
      unread: msg.isMine || isAlreadyRead || isActiveConv ? 0 : 1,
      oldestTimestamp: msg.createdAt,
      hasMore: true,
    })
  }
}

/* ─── Track B: NIP-78 Contact Registry + Per-Person Fetch ─── */

/** Per-person fetch concurrency limit */
const PER_PERSON_CONCURRENCY = 3
/** Max non-followed contacts to per-person fetch per session */
const MAX_NON_FOLLOWED_FETCH = 100
/** Per-person fetch limit (events per direction per person) */
const PER_PERSON_LIMIT = 10

/**
 * Build the relay set for DM fetching, respecting posting behaviour settings.
 * Combines client relays + NIP-65 user relays (no hub relays — DMs aren't hub-scoped).
 * This ensures per-person fetch queries the same relays the user publishes to.
 */
function getDMFetchRelays(): string[] {
  const { postToClientRelays, postToUserRelays, limitRelaysPerList } = usePostingBehaviourStore.getState()
  const limit = limitRelaysPerList ? 3 : Infinity
  const result = new Set<string>()

  if (postToClientRelays) {
    const clientRelays = getRelays()
    const pick = clientRelays.length <= limit ? clientRelays : clientRelays.slice(0, limit)
    pick.forEach((r) => result.add(r))
  }

  if (postToUserRelays) {
    const userRelays = useUserListsStore.getState().userRelays
    const pick = userRelays.length <= limit ? userRelays : userRelays.slice(0, limit)
    pick.forEach((r) => result.add(r))
  }

  // Fallback: always include at least the client relays
  if (result.size === 0) {
    getRelays().forEach((r) => result.add(r))
  }

  return Array.from(result)
}

/**
 * Track B orchestrator: loads NIP-78 registry → populates sidebar → per-person fetch → reconcile.
 * Runs entirely in the background, independent of Track A.
 */
async function runContactRegistryTrack(
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  set: (fn: (s: DM04State) => Partial<DM04State>) => void,
  get: () => DM04State,
) {
  try {
    // 1. Load NIP-78 contact registry
    console.log('[DM04:TrackB] Loading contact registry from relay...')
    const registry = await loadContactRegistry(myPubkey, signer, privateKey)
    set(() => ({ contactRegistry: registry }))

    // 2. Populate sidebar with known contacts (names only — no messages yet)
    if (registry.contacts.length > 0) {
      const blockedPubkeys = useBlockStore.getState().blockedPubkeys
      const registryPubkeys = new Set(registry.contacts.map((c) => c.pubkey))
      set((s) => {
        const conversations = new Map(s.conversations)
        for (const contact of registry.contacts) {
          // Skip blocked users — don't populate sidebar with them
          if (blockedPubkeys.has(contact.pubkey)) continue
          if (!conversations.has(contact.pubkey)) {
            // Create empty placeholder conversation for sidebar display
            conversations.set(contact.pubkey, {
              pubkey: contact.pubkey,
              messages: [],
              lastMessageAt: contact.lastSeen,
              lastMessagePreview: '',
              unread: 0,
              oldestTimestamp: contact.lastSeen,
              hasMore: true,
            })
          }
        }
        return { conversations, registryOnlyContacts: registryPubkeys }
      })
      console.log(`[DM04:TrackB] Populated sidebar with ${registry.contacts.length} contacts`)
    }

    // 3. Per-person fetch cycle (concurrency 3, followed-first)
    const followList = useFollowStore.getState().followedPubkeys
    await runPerPersonFetchCycle(registry.contacts, myPubkey, signer, privateKey, followList, set, get)
    set(() => ({ perPersonFetchDone: true }))

    // 4. Reconcile: diff Track A discoveries against registry
    reconcileNewContacts(registry, myPubkey, signer, privateKey, followList, set, get)
  } catch (err) {
    console.error('[DM04:TrackB] Contact registry track failed:', err)
    set(() => ({ perPersonFetchDone: true }))
  }
}

/**
 * Per-person fetch cycle: fetches last N events per contact with concurrency limiter.
 * Processes followed contacts first, caps non-followed at MAX_NON_FOLLOWED_FETCH.
 */
async function runPerPersonFetchCycle(
  contacts: DM04Contact[],
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  followList: Set<string>,
  set: (fn: (s: DM04State) => Partial<DM04State>) => void,
  get: () => DM04State,
) {
  if (contacts.length === 0) return

  // Sort: followed first, then non-followed by lastSeen DESC
  const sorted = [...contacts].sort((a, b) => {
    const aFollow = followList.has(a.pubkey) ? 0 : 1
    const bFollow = followList.has(b.pubkey) ? 0 : 1
    if (aFollow !== bFollow) return aFollow - bFollow
    return b.lastSeen - a.lastSeen
  })

  // Cap non-followed
  let nonFollowedCount = 0
  const toFetch = sorted.filter((c) => {
    if (followList.has(c.pubkey)) return true
    if (nonFollowedCount >= MAX_NON_FOLLOWED_FETCH) return false
    nonFollowedCount++
    return true
  })

  console.log(`[DM04:TrackB] Starting per-person fetch for ${toFetch.length} contacts (${toFetch.length - nonFollowedCount} followed, ${nonFollowedCount} non-followed)`)

  // Process with concurrency pool
  for (let i = 0; i < toFetch.length; i += PER_PERSON_CONCURRENCY) {
    const batch = toFetch.slice(i, i + PER_PERSON_CONCURRENCY)
    await Promise.allSettled(
      batch.map((contact) =>
        fetchPerPerson(contact.pubkey, myPubkey, signer, privateKey, set, get)
          .then((latestCreatedAt) => {
            // Update lastSeen in registry
            if (latestCreatedAt > contact.lastSeen) {
              contact.lastSeen = latestCreatedAt
            }
            // Remove from registryOnlyContacts once fetched
            set((s) => {
              const registryOnly = new Set(s.registryOnlyContacts)
              registryOnly.delete(contact.pubkey)
              return { registryOnlyContacts: registryOnly }
            })
          })
      )
    )
  }

  console.log('[DM04:TrackB] Per-person fetch cycle complete')
}

/**
 * Fetch the last N events for a specific counterparty (both directions).
 * Uses fetchEventsFromRelays with timeout protection.
 * If the initial fetch returns 0 events, discovers the counterparty's
 * NIP-65 / DM relay list and retries on those relays.
 * Returns the most recent created_at found.
 */
async function fetchPerPerson(
  counterpartyPubkey: string,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  set: (fn: (s: DM04State) => Partial<DM04State>) => void,
  get: () => DM04State,
): Promise<number> {
  let latestCreatedAt = 0

  const processEvents = async (events: Event[]) => {
    for (const event of events) {
      const state = get()
      if (state.processedIds.has(event.id)) continue

      set((s) => ({
        processedIds: new Set(s.processedIds).add(event.id),
      }))

      if (event.created_at > latestCreatedAt) {
        latestCreatedAt = event.created_at
      }

      await processNip04Event(event, myPubkey, signer, privateKey, set, get)
    }
  }

  try {
    // Use combined relay set (client + NIP-65 user relays) to maximize coverage
    const dmRelays = getDMFetchRelays()

    // Fetch both directions in parallel with timeout protection
    const allEvents = await fetchDMEventsWithTimeout(dmRelays, counterpartyPubkey, myPubkey)
    const newCount = allEvents.filter(e => !get().processedIds.has(e.id)).length
    if (allEvents.length > 0 && newCount < allEvents.length) {
      console.log(`[DM04:TrackB] ${counterpartyPubkey.slice(0, 12)}… — ${allEvents.length} events (${allEvents.length - newCount} already processed by Track A)`)
    }
    await processEvents(allEvents)

    // If initial fetch found nothing, try counterparty's relays as fallback
    if (allEvents.length === 0) {
      const extraRelays = await discoverCounterpartyRelays(counterpartyPubkey, dmRelays)
      if (extraRelays.length > 0) {
        console.log(`[DM04:TrackB] Retrying ${counterpartyPubkey.slice(0, 12)}… on ${extraRelays.length} counterparty relays`)
        const fallbackEvents = await fetchDMEventsWithTimeout(extraRelays, counterpartyPubkey, myPubkey)
        await processEvents(fallbackEvents)
      }
    }
  } catch (err) {
    console.warn(`[DM04:TrackB] Per-person fetch failed for ${counterpartyPubkey.slice(0, 12)}…:`, err)
  }

  return latestCreatedAt
}

/** Timeout-protected wrapper for fetching DMs in both directions */
async function fetchDMEventsWithTimeout(
  relays: string[],
  counterpartyPubkey: string,
  myPubkey: string,
): Promise<Event[]> {
  const FETCH_TIMEOUT = 12_000 // 12 seconds per fetch

  const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`[DM04] Timeout: ${label}`)), FETCH_TIMEOUT)
      ),
    ])

  const [receivedEvents, sentEvents] = await Promise.allSettled([
    withTimeout(
      fetchEventsFromRelays(
        relays,
        { kinds: [STANDARD_KINDS.NIP04_DM], authors: [counterpartyPubkey], '#p': [myPubkey], limit: PER_PERSON_LIMIT },
      ),
      `received from ${counterpartyPubkey.slice(0, 12)}`,
    ),
    withTimeout(
      fetchEventsFromRelays(
        relays,
        { kinds: [STANDARD_KINDS.NIP04_DM], authors: [myPubkey], '#p': [counterpartyPubkey], limit: PER_PERSON_LIMIT },
      ),
      `sent to ${counterpartyPubkey.slice(0, 12)}`,
    ),
  ])

  // Collect whatever succeeded — don't discard results just because one direction timed out
  const events: Event[] = []
  const rcvCount = receivedEvents.status === 'fulfilled' ? receivedEvents.value.length : 0
  const sntCount = sentEvents.status === 'fulfilled' ? sentEvents.value.length : 0
  if (receivedEvents.status === 'fulfilled') events.push(...receivedEvents.value)
  else console.warn(`[DM04:TrackB] Received fetch FAILED for ${counterpartyPubkey.slice(0, 12)}…:`, (receivedEvents as PromiseRejectedResult).reason?.message)
  if (sentEvents.status === 'fulfilled') events.push(...sentEvents.value)
  else console.warn(`[DM04:TrackB] Sent fetch FAILED for ${counterpartyPubkey.slice(0, 12)}…:`, (sentEvents as PromiseRejectedResult).reason?.message)
  if (rcvCount > 0 || sntCount > 0) {
    console.log(`[DM04:TrackB] ${counterpartyPubkey.slice(0, 12)}… — received: ${rcvCount}, sent: ${sntCount}`)
  }
  return events
}

/**
 * Discover the counterparty's preferred relays by fetching their NIP-65 relay list (kind 10002)
 * and DM relay list (kind 10050). Returns relay URLs not already in `existingRelays`.
 */
async function discoverCounterpartyRelays(
  counterpartyPubkey: string,
  existingRelays: string[],
): Promise<string[]> {
  try {
    const existingSet = new Set(existingRelays.map((r) => r.replace(/\/$/, '')))
    const discoveredRelays = new Set<string>()

    // Fetch NIP-65 relay list and DM relay list in parallel
    const [relayListEvents, dmRelayListEvents] = await Promise.allSettled([
      fetchEvents({ kinds: [STANDARD_KINDS.RELAY_LIST], authors: [counterpartyPubkey], limit: 1 }),
      fetchEvents({ kinds: [STANDARD_KINDS.DM_RELAY_LIST], authors: [counterpartyPubkey], limit: 1 }),
    ])

    // Parse NIP-65 relay list (kind 10002): tags are ['r', 'wss://...', 'read'|'write'|'']
    if (relayListEvents.status === 'fulfilled' && relayListEvents.value.length > 0) {
      const event = relayListEvents.value[0]
      for (const tag of event.tags) {
        if (tag[0] === 'r' && tag[1]) {
          const url = tag[1].replace(/\/$/, '')
          if (!existingSet.has(url)) discoveredRelays.add(tag[1])
        }
      }
    }

    // Parse DM relay list (kind 10050): tags are ['relay', 'wss://...']
    if (dmRelayListEvents.status === 'fulfilled' && dmRelayListEvents.value.length > 0) {
      const event = dmRelayListEvents.value[0]
      for (const tag of event.tags) {
        if (tag[0] === 'relay' && tag[1]) {
          const url = tag[1].replace(/\/$/, '')
          if (!existingSet.has(url)) discoveredRelays.add(tag[1])
        }
      }
    }

    return Array.from(discoveredRelays)
  } catch {
    return []
  }
}

/**
 * After both Track A and Track B settle: diff discovered contacts against registry.
 * Adds genuinely new contacts (with spam check), evicts if over 750.
 * Publishes updated registry (10s debounce).
 */
function reconcileNewContacts(
  registry: DM04ContactRegistry,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
  followList: Set<string>,
  set: (fn: (s: DM04State) => Partial<DM04State>) => void,
  get: () => DM04State,
) {
  const state = get()
  const pendingNew = state.pendingNewContacts
  let modified = false

  const blockedPubkeys = useBlockStore.getState().blockedPubkeys

  for (const [pubkey, events] of pendingNew) {
    // Skip blocked users — never add them to the registry
    if (blockedPubkeys.has(pubkey)) continue

    // Skip if already in registry
    if (registry.contacts.find((c) => c.pubkey === pubkey)) {
      // Still update lastSeen if we have a newer timestamp
      const newestCreatedAt = Math.max(...events.map((e) => e.created_at))
      const existing = registry.contacts.find((c) => c.pubkey === pubkey)!
      if (newestCreatedAt > existing.lastSeen) {
        existing.lastSeen = newestCreatedAt
        modified = true
      }
      continue
    }

    // Spam check
    if (isSpamBot(events)) {
      console.log(`[DM04:Registry] Skipping spam-detected npub: ${pubkey.slice(0, 12)}…`)
      continue
    }

    const lastSeen = Math.max(...events.map((e) => e.created_at))

    if (addContact(registry, pubkey, lastSeen)) {
      modified = true
    } else {
      // At capacity — try eviction
      const evicted = evictAndReplace(registry, pubkey, lastSeen, followList)
      if (evicted) modified = true
    }
  }

  // Clear pending
  set(() => ({ pendingNewContacts: new Map() }))

  if (modified) {
    set(() => ({ contactRegistry: registry }))
    scheduleRegistryPublish(registry, myPubkey, signer, privateKey)
  }
}
