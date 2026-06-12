/**
 * DM Store — NIP-17 Direct Messages state management
 *
 * Subscription-based loading with scroll pagination:
 * - Initial load: subscribe to recent gift wraps (last 50 messages)
 * - Real-time: subscription stays open for new incoming DMs
 * - Pagination: fetch older 20-message batches on scroll-to-top
 */

import { create } from 'zustand'
import { fetchEvents, publishToSpecificRelays, publishEventProgressive, subscribeEvents } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import { createGiftWrap, unwrapGiftWrap, computeRumorId, type UnwrappedDM } from '@/lib/nostr/nip17'
import { useBlockStore } from '@/stores/blockStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { useWotStore } from '@/stores/wotStore'
import { useFollowStore } from '@/stores/followStore'
import { playSoundEffect } from '@/lib/voice/soundEffects'
import type { ISigner } from '@/stores/userStore'
import type { Event } from 'nostr-tools'

/** Unix timestamp (seconds) of when this session started — sounds only play for messages after this */
const dmSessionStartTime = Math.floor(Date.now() / 1000)

/* ─── Types ─── */

export interface DMMessage {
  id: string // gift wrap event id (for dedup)
  content: string
  senderPubkey: string
  recipientPubkey: string
  createdAt: number // rumor timestamp (real ordering)
  wrapCreatedAt: number // gift wrap timestamp (for pagination cursor)
  isMine: boolean
  clientTag?: string // from ["client", "..."] tag on the rumor
  emojiTags?: [string, string, string?][]    // [shortcode, url, set-ref?] from rumor tags
  stickerTags?: [string, string, string?][]  // [shortcode, url, set-ref?] from rumor tags
  gifTags?: [string, string, string][]        // [name, url, nsfw] from rumor tags
  // NIP-17 kind 15 file attachment fields (merged from linked kind 15 events)
  fileUrl?: string              // URL of the encrypted file on Blossom
  fileMimeType?: string         // original MIME type (before encryption)
  fileDecryptionKey?: string    // AES-256-GCM key (hex)
  fileDecryptionNonce?: string  // AES-GCM nonce (hex)
  fileOriginalHash?: string     // SHA-256 of original plaintext file (hex)
  fileEncryptedHash?: string    // SHA-256 of encrypted file (hex)
  fileSize?: number             // encrypted file size in bytes
  /** Internal: rumor ID for e-tag linking with kind 15 file messages */
  _rumorId?: string
}

export interface Conversation {
  pubkey: string // counterparty
  messages: DMMessage[]
  lastMessageAt: number
  lastMessagePreview: string
  unread: number
  oldestWrapTimestamp: number // for pagination — oldest gift wrap we've seen
  hasMore: boolean // whether more older messages might exist
}

interface DMState {
  conversations: Map<string, Conversation>
  activeConversation: string | null
  pendingConversations: Set<string> // locally-added users with no messages yet
  loading: boolean
  loadingOlder: boolean
  processedWrapIds: Set<string>
  subscription: { close: () => void } | null

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
    emojiTags?: [string, string, string, string][],
    stickerTags?: [string, string, string, string][],
    gifTags?: [string, string, string, string][],
    onProgress?: (phase: 'encrypting' | 'publishing', relayProgress?: { confirmed: number; total: number }) => void,
  ) => Promise<{ rumorId: string }>
  getFilteredConversations: (followList: Set<string>) => {
    following: Conversation[]
    other: Conversation[]
  }
  setRelayProgress: (eventId: string, confirmed: number, total: number, acceptedRelays?: string[]) => void
  clearRelayProgress: (eventId: string) => void
}

/** Initial subscription limit — kept low for NIP-17.
 *  NIP-17 is best-effort: we can't filter by sender (ephemeral keys),
 *  so we fetch the most recent 50 wraps and accept the coverage tradeoff.
 *  The app directs users to NIP-04 ("Private") as the primary DM protocol. */
const INITIAL_LIMIT = 50
/** Pagination batch size — older messages loaded on scroll */
const PAGE_SIZE = 50
/** Max messages per conversation in memory (FIFO eviction) */
const MAX_PER_CONVERSATION = 1000

/* ─── Store ─── */

export const useDMStore = create<DMState>((set, get) => ({
  conversations: new Map(),
  activeConversation: null,
  pendingConversations: new Set(),
  loading: false,
  loadingOlder: false,
  processedWrapIds: new Set(),
  subscription: null,
  relayProgress: {},

  setActiveConversation: (pubkey) => {
    set((s) => {
      if (pubkey) {
        const conversations = new Map(s.conversations)
        const conv = conversations.get(pubkey)
        if (conv && conv.unread > 0) {
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
      useNotificationStore.getState().markDmRead(pubkey, 'nip17')
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
   * Start a SINGLE subscription for gift-wrap events addressed to us.
   *
   * Architecture:
   * - Filter uses `limit` only (NO `since`!) — this is critical for NIP-17.
   * - `limit` is relay-side only: caps how many stored events are sent before EOSE.
   * - After EOSE, ALL new matching events are forwarded in real-time.
   * - nostr-tools' `matchFilter` does NOT check `limit`, only `since`/`until`,
   *   so without those filters, real-time events are never client-side rejected.
   * - This avoids the fundamental NIP-17 problem: randomized gift wrap timestamps
   *   (±48h) being rejected by `since` checks.
   */
  startSubscription: (myPubkey, signer, privateKey) => {
    // Capability check
    if (!privateKey && !signer?.nip44) {
      console.warn('[DM] NIP-44 encryption not available with current auth method — DMs disabled')
      set({ loading: false })
      return
    }

    // Close any existing subscription
    get().subscription?.close()

    set({ loading: true })

    // Buffer for initial-load batching: collect all DMs before EOSE,
    // then flush them in a single state update to avoid N re-renders.
    let initialPhase = true
    const dmBuffer: UnwrappedDM[] = []

    const sub = subscribeEvents(
      {
        kinds: [STANDARD_KINDS.GIFT_WRAP],
        '#p': [myPubkey],
        limit: INITIAL_LIMIT, // relay-side only — caps initial batch, not real-time
      },
      // onEvent — handles both initial batch AND real-time events
      async (event: Event) => {
        const state = get()
        if (state.processedWrapIds.has(event.id)) return

        // Mark as processed immediately to prevent race conditions
        set((s) => ({
          processedWrapIds: new Set(s.processedWrapIds).add(event.id),
        }))

        const dm = await unwrapGiftWrap(
          event as { id: string; pubkey: string; created_at: number; content: string; tags: string[][] },
          myPubkey,
          signer,
          privateKey,
        )
        if (!dm) return

        if (initialPhase) {
          // Buffer during initial load — will be flushed in onEose
          dmBuffer.push(dm)
        } else {
          // Real-time: apply immediately (single message, cheap)
          set((s) => {
            const conversations = new Map(s.conversations)
            addDMToConversations(conversations, dm, myPubkey)
            return { conversations }
          })
        }
      },
      // onEose — initial batch complete: flush buffer + recalculate unreads
      () => {
        initialPhase = false

        // Flush all buffered DMs in a single state update
        if (dmBuffer.length > 0) {
          set((s) => {
            const conversations = new Map(s.conversations)
            for (const dm of dmBuffer) {
              addDMToConversations(conversations, dm, myPubkey)
            }
            return { conversations }
          })
          dmBuffer.length = 0 // clear buffer
        }

        set({ loading: false })

        const recalcUnreads = () => {
          const notifState = useNotificationStore.getState()
          if (!notifState.initialized) {
            // Notification store hasn't loaded read timestamps yet — retry shortly
            setTimeout(recalcUnreads, 1500)
            return
          }
          set((s) => {
            const conversations = new Map(s.conversations)
            let changed = false
            for (const [pubkey, conv] of conversations) {
              const lastRead = notifState.dm17Unreads[pubkey]?.lastRead ?? 0
              if (lastRead > 0) {
                const trueUnread = conv.messages.filter(m => !m.isMine && m.createdAt > lastRead).length
                if (trueUnread !== conv.unread) {
                  conv.unread = trueUnread
                  changed = true
                }
              }
            }
            return changed ? { conversations } : {}
          })
        }

        recalcUnreads()
      },
    )

    set({ subscription: sub })
  },

  /**
   * Close the active DM subscription.
   */
  stopSubscription: () => {
    get().subscription?.close()
    set({ subscription: null })
  },

  /**
   * Load older messages for a specific conversation.
   * Uses the oldest gift-wrap timestamp as the "until" cursor.
   * Fetches PAGE_SIZE events and filters to the target counterparty.
   */
  loadOlderMessages: async (counterpartyPubkey, myPubkey, signer, privateKey) => {
    // Capability check
    if (!privateKey && !signer?.nip44) return

    const state = get()
    if (state.loadingOlder) return

    const conv = state.conversations.get(counterpartyPubkey)
    if (conv && !conv.hasMore) return

    set({ loadingOlder: true })

    try {
      // Use the oldest wrap timestamp as the cursor
      const until = conv?.oldestWrapTimestamp || Math.floor(Date.now() / 1000)

      const events = await fetchEvents({
        kinds: [STANDARD_KINDS.GIFT_WRAP],
        '#p': [myPubkey],
        until: until - 1, // strictly before the oldest we have
        limit: PAGE_SIZE,
      })

      let addedCount = 0

      for (const event of events) {
        if (state.processedWrapIds.has(event.id)) continue

        const dm = await unwrapGiftWrap(
          event as { id: string; pubkey: string; created_at: number; content: string; tags: string[][] },
          myPubkey,
          signer,
          privateKey,
        )
        if (!dm) continue

        // Determine which conversation this belongs to
        const isMine = dm.senderPubkey === myPubkey
        const counterparty = isMine
          ? dm.rumor.tags.find((t) => t[0] === 'p')?.[1] || dm.recipientPubkey
          : dm.senderPubkey

        set((s) => {
          const conversations = new Map(s.conversations)
          const processedWrapIds = new Set(s.processedWrapIds)
          processedWrapIds.add(dm.wrapId)
          addDMToConversations(conversations, dm, myPubkey)
          return { conversations, processedWrapIds }
        })

        if (counterparty === counterpartyPubkey) addedCount++
      }

      // Sort messages after loading older ones and update hasMore
      set((s) => {
        const conversations = new Map(s.conversations)
        const conv = conversations.get(counterpartyPubkey)
        if (conv) {
          conv.messages.sort((a, b) => a.createdAt - b.createdAt)
          // If we got fewer events than PAGE_SIZE, there are probably no more
          if (events.length < PAGE_SIZE) {
            conv.hasMore = false
          }
        }
        return { conversations, loadingOlder: false }
      })
    } catch (err) {
      console.error('[DM] Failed to load older messages:', err)
      set({ loadingOlder: false })
    }
  },

  sendMessage: async (recipientPubkey, content, myPubkey, signer, privateKey, emojiTags, stickerTags, gifTags, onProgress) => {
    // Capability check
    if (!privateKey && !signer?.nip44) {
      throw new Error('NIP-44 encryption is not available with your current login method. DMs require NIP-44 support.')
    }

    try {
      // Capture timestamp NOW (before async work) so the local message
      // matches the rumor's created_at and isn't delayed by network latency
      const sendTime = Math.floor(Date.now() / 1000)

      // Build extra tags for emoji/sticker (plaintext inside the rumor)
      const extraTags: string[][] = []
      if (emojiTags && emojiTags.length > 0) {
        for (const tag of emojiTags) {
          extraTags.push(['emoji', tag[1], tag[2], ...(tag[3] ? [tag[3]] : [])])
        }
      }
      if (stickerTags && stickerTags.length > 0) {
        for (const tag of stickerTags) {
          extraTags.push(['sticker', tag[1], tag[2], ...(tag[3] ? [tag[3]] : [])])
        }
      }
      if (gifTags && gifTags.length > 0) {
        for (const tag of gifTags) {
          extraTags.push(['j', tag[1], tag[2], ...(tag[3] ? [tag[3]] : [])])
        }
      }

      // Start relay discovery in parallel with gift-wrap creation (non-blocking)
      const publishRelays = getPublishRelays()
      const { discoverRecipientRelays } = await import('@/lib/nostr/relayDiscovery')
      const relayDiscoveryPromise = discoverRecipientRelays(recipientPubkey, publishRelays)

      const wraps = await createGiftWrap(
        content,
        recipientPubkey,
        myPubkey,
        signer,
        privateKey,
        extraTags,
      )

      // Compute the rumor ID (deterministic hash of the unsigned kind-14 event)
      const rumorId = computeRumorId(wraps.rumor)
      const wrapRecipientId = (wraps.wrapForRecipient as { id?: string }).id
      const wrapSelfId = (wraps.wrapForSelf as { id?: string }).id

      set((s) => {
        const processedWrapIds = new Set(s.processedWrapIds)
        if (wrapRecipientId) processedWrapIds.add(wrapRecipientId)
        if (wrapSelfId) processedWrapIds.add(wrapSelfId)
        return { processedWrapIds }
      })

      // Remove from pending if it was there
      get().removePendingConversation(recipientPubkey)

      // Add the message locally BEFORE publishing so it appears instantly
      // (same pattern as hub chat — don't wait for relay confirmation)
      const msg: DMMessage = {
        id: wrapSelfId || crypto.randomUUID(),
        content,
        senderPubkey: myPubkey,
        recipientPubkey,
        createdAt: sendTime,
        wrapCreatedAt: sendTime,
        isMine: true,
        clientTag: typeof window !== 'undefined' && localStorage.getItem('den-chat-client-tag') !== 'false' ? 'DEN Chat' : undefined,
        emojiTags: emojiTags?.map((t) => [t[1], t[2], t[3] || undefined] as [string, string, string?]),
        stickerTags: stickerTags?.map((t) => [t[1], t[2], t[3] || undefined] as [string, string, string?]),
        gifTags: gifTags?.map((t) => [t[1], t[2], t[3] || 'sfw'] as [string, string, string]),
        _rumorId: rumorId,
      }

      set((s) => {
        const conversations = new Map(s.conversations)
        const existing = conversations.get(recipientPubkey)
        if (existing) {
          // Dedup: don't add if same content from same sender already exists very recently
          const isDupe = existing.messages.some(
            (m) => m.id === msg.id || (m.isMine && m.content === msg.content && Math.abs(m.createdAt - msg.createdAt) < 5)
          )
          if (!isDupe) {
            const idx = sortedInsertIndex(existing.messages, msg.createdAt, msg.id)
            existing.messages.splice(idx, 0, msg)
            // Safety-net sort (O(n) on nearly-sorted data)
            existing.messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
            existing.lastMessageAt = msg.createdAt
            existing.lastMessagePreview = content.slice(0, 80)
          }
        } else {
          conversations.set(recipientPubkey, {
            pubkey: recipientPubkey,
            messages: [msg],
            lastMessageAt: msg.createdAt,
            lastMessagePreview: content.slice(0, 80),
            unread: 0,
            oldestWrapTimestamp: sendTime,
            hasMore: true,
          })
        }
        return { conversations }
      })

      // Publish entirely in background — relay discovery + publish don't block the return
      ;(async () => {
        try {
          const extraRelays = await relayDiscoveryPromise
          const recipientRelays = extraRelays.length > 0
            ? [...publishRelays, ...extraRelays]
            : publishRelays

          if (extraRelays.length > 0) {
            console.log(`[DM] Merging ${extraRelays.length} recipient relay(s):`, extraRelays)
          }

          onProgress?.('publishing')
          const allRelays = [...new Set([...recipientRelays, ...publishRelays])]
          const totalRelays = allRelays.length
          let recipientConfirmed = 0
          let selfConfirmed = 0
          const allAcceptedRelays: string[] = []

          await Promise.all([
            publishEventProgressive(
              wraps.wrapForRecipient as unknown as Event,
              (confirmed, _total, acceptedRelays) => {
                recipientConfirmed = confirmed
                allAcceptedRelays.push(...(acceptedRelays || []))
                const selfWrapId = wrapSelfId || 'self'
                get().setRelayProgress(selfWrapId, recipientConfirmed + selfConfirmed, totalRelays, [...allAcceptedRelays])
                onProgress?.('publishing', { confirmed: recipientConfirmed + selfConfirmed, total: totalRelays })
              },
              recipientRelays,
            ),
            publishEventProgressive(
              wraps.wrapForSelf as unknown as Event,
              (confirmed, _total, acceptedRelays) => {
                selfConfirmed = confirmed
                allAcceptedRelays.push(...(acceptedRelays || []))
                const selfWrapId = wrapSelfId || 'self'
                get().setRelayProgress(selfWrapId, recipientConfirmed + selfConfirmed, totalRelays, [...allAcceptedRelays])
                onProgress?.('publishing', { confirmed: recipientConfirmed + selfConfirmed, total: totalRelays })
              },
              publishRelays,
            ),
          ])

          // Auto-clear relay progress after 5 seconds
          const progressId = wrapSelfId || 'self'
          setTimeout(() => {
            get().clearRelayProgress(progressId)
          }, 5000)
        } catch (err) {
          console.error('[DM] Relay publish failed:', err)
        }
      })()

      return { rumorId }
    } catch (err) {
      console.error('[DM] Failed to send message:', err)
      throw err
    }
  },

  getFilteredConversations: (followList) => {
    const { conversations, pendingConversations } = get()
    const blockedPubkeys = useBlockStore.getState().blockedPubkeys

    const following: Conversation[] = []
    const other: Conversation[] = []

    for (const [pubkey, conv] of conversations) {
      if (blockedPubkeys.has(pubkey)) continue
      if (useWotStore.getState().shouldHide(pubkey, 'dms')) continue
      if (followList.has(pubkey)) {
        following.push(conv)
      } else {
        other.push(conv)
      }
    }

    // Add pending conversations (no messages yet) to following
    for (const pk of pendingConversations) {
      if (blockedPubkeys.has(pk)) continue
      if (!conversations.has(pk)) {
        const empty: Conversation = {
          pubkey: pk,
          messages: [],
          lastMessageAt: Math.floor(Date.now() / 1000),
          lastMessagePreview: '',
          unread: 0,
          oldestWrapTimestamp: Math.floor(Date.now() / 1000),
          hasMore: false,
        }
        if (followList.has(pk)) {
          following.push(empty)
        } else {
          other.push(empty)
        }
      }
    }

    // Sort by most recent
    const sortFn = (a: Conversation, b: Conversation) => b.lastMessageAt - a.lastMessageAt
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

/** Binary search for the insertion index to keep messages sorted by createdAt.
 *  Uses message ID as a deterministic tiebreaker for same-second timestamps,
 *  so both sender and receiver sort messages identically regardless of arrival order. */
function sortedInsertIndex(messages: DMMessage[], createdAt: number, id: string): number {
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

function addDMToConversations(
  conversations: Map<string, Conversation>,
  dm: UnwrappedDM,
  myPubkey: string,
) {
  const isMine = dm.senderPubkey === myPubkey
  const counterparty = isMine
    ? dm.rumor.tags.find((t) => t[0] === 'p')?.[1] || dm.recipientPubkey
    : dm.senderPubkey

  const clientTagVal = dm.rumor.tags.find((t) => t[0] === 'client')?.[1]

  // ─── Kind 15 (file message) — merge into parent kind 14 or create standalone ───
  if (dm.rumor.kind === STANDARD_KINDS.DM_FILE) {
    const fileUrl = dm.rumor.content
    const fileMimeType = dm.rumor.tags.find((t) => t[0] === 'file-type')?.[1]
    const fileDecryptionKey = dm.rumor.tags.find((t) => t[0] === 'decryption-key')?.[1]
    const fileDecryptionNonce = dm.rumor.tags.find((t) => t[0] === 'decryption-nonce')?.[1]
    const fileOriginalHash = dm.rumor.tags.find((t) => t[0] === 'ox')?.[1]
    const fileEncryptedHash = dm.rumor.tags.find((t) => t[0] === 'x')?.[1]
    const fileSizeStr = dm.rumor.tags.find((t) => t[0] === 'size')?.[1]
    const fileSize = fileSizeStr ? parseInt(fileSizeStr, 10) : undefined

    // Check for parent kind-14 link (e tag)
    const parentRumorId = dm.rumor.tags.find((t) => t[0] === 'e')?.[1]

    if (parentRumorId) {
      // Try to merge into existing parent message
      const conv = conversations.get(counterparty)
      if (conv) {
        const parentMsg = conv.messages.find((m) => m.id === dm.wrapId || m._rumorId === parentRumorId)
        if (parentMsg) {
          // Merge file fields into the parent message
          parentMsg.fileUrl = fileUrl
          parentMsg.fileMimeType = fileMimeType
          parentMsg.fileDecryptionKey = fileDecryptionKey
          parentMsg.fileDecryptionNonce = fileDecryptionNonce
          parentMsg.fileOriginalHash = fileOriginalHash
          parentMsg.fileEncryptedHash = fileEncryptedHash
          parentMsg.fileSize = fileSize
          return // merged — no new message entry
        }
      }

      // Parent not found yet (race condition — kind 15 arrived before kind 14)
      // Store as a pending file attachment to merge later
      if (!pendingFileAttachments.has(parentRumorId)) {
        pendingFileAttachments.set(parentRumorId, [])
      }
      pendingFileAttachments.get(parentRumorId)!.push({
        wrapId: dm.wrapId,
        fileUrl,
        fileMimeType,
        fileDecryptionKey,
        fileDecryptionNonce,
        fileOriginalHash,
        fileEncryptedHash,
        fileSize,
      })
      return // buffered — will merge when parent arrives
    }

    // No e-tag — standalone file message (file-only send, or from another client)
    const fileMsg: DMMessage = {
      id: dm.wrapId,
      content: '',
      senderPubkey: dm.senderPubkey,
      recipientPubkey: dm.recipientPubkey,
      createdAt: dm.rumor.created_at,
      wrapCreatedAt: dm.wrapCreatedAt,
      isMine,
      clientTag: clientTagVal,
      fileUrl,
      fileMimeType,
      fileDecryptionKey,
      fileDecryptionNonce,
      fileOriginalHash,
      fileEncryptedHash,
      fileSize,
    }
    insertMessage(conversations, counterparty, fileMsg, isMine)
    return
  }

  // ─── Kind 14 (text message) — standard processing ───

  // Extract emoji/sticker tags from the rumor (plaintext inside the encrypted envelope)
  const emojiTags: [string, string, string?][] = dm.rumor.tags
    .filter((t) => t[0] === 'emoji' && t[1] && t[2])
    .map((t) => [t[1], t[2], t[3]] as [string, string, string?])
  const stickerTags: [string, string, string?][] = dm.rumor.tags
    .filter((t) => t[0] === 'sticker' && t[1] && t[2])
    .map((t) => [t[1], t[2], t[3]] as [string, string, string?])
  const gifTags: [string, string, string][] = dm.rumor.tags
    .filter((t) => t[0] === 'j' && t[2])
    .map((t) => [t[1] || '', t[2], t[3] || 'sfw'] as [string, string, string])

  // Compute rumor ID for e-tag linking with kind 15 file messages
  const rumorId = computeRumorId(dm.rumor)

  const msg: DMMessage = {
    id: dm.wrapId,
    content: dm.rumor.content,
    senderPubkey: dm.senderPubkey,
    recipientPubkey: dm.recipientPubkey,
    createdAt: dm.rumor.created_at,
    wrapCreatedAt: dm.wrapCreatedAt,
    isMine,
    clientTag: clientTagVal,
    emojiTags: emojiTags.length > 0 ? emojiTags : undefined,
    stickerTags: stickerTags.length > 0 ? stickerTags : undefined,
    gifTags: gifTags.length > 0 ? gifTags : undefined,
    _rumorId: rumorId,
  }

  // Check if a kind-15 file arrived before this kind-14 parent
  const pendingFiles = pendingFileAttachments.get(rumorId)
  if (pendingFiles && pendingFiles.length > 0) {
    // Merge the first pending file attachment
    const file = pendingFiles[0]
    msg.fileUrl = file.fileUrl
    msg.fileMimeType = file.fileMimeType
    msg.fileDecryptionKey = file.fileDecryptionKey
    msg.fileDecryptionNonce = file.fileDecryptionNonce
    msg.fileOriginalHash = file.fileOriginalHash
    msg.fileEncryptedHash = file.fileEncryptedHash
    msg.fileSize = file.fileSize
    pendingFileAttachments.delete(rumorId)
  }

  insertMessage(conversations, counterparty, msg, isMine)
}

/** Buffer for kind-15 file events that arrive before their parent kind-14 */
interface PendingFileData {
  wrapId: string
  fileUrl?: string
  fileMimeType?: string
  fileDecryptionKey?: string
  fileDecryptionNonce?: string
  fileOriginalHash?: string
  fileEncryptedHash?: string
  fileSize?: number
}
const pendingFileAttachments = new Map<string, PendingFileData[]>()

/** Insert a DMMessage into the correct conversation, handling dedup and sorting */
function insertMessage(
  conversations: Map<string, Conversation>,
  counterparty: string,
  msg: DMMessage,
  isMine: boolean,
) {
  const existing = conversations.get(counterparty)
  if (existing) {
    // Dedup by id
    if (existing.messages.some((m) => m.id === msg.id)) return
    // Dedup by content+sender (catches locally-added messages that have different ID)
    if (isMine && existing.messages.some((m) => m.isMine && m.content === msg.content && Math.abs(m.createdAt - msg.createdAt) < 10)) return

    // Insert in sorted order by createdAt (binary insert)
    const insertIdx = sortedInsertIndex(existing.messages, msg.createdAt, msg.id)
    existing.messages.splice(insertIdx, 0, msg)
    // Safety-net re-sort: fixes any timing edge cases from rapid same-second
    // messages arriving out of order. O(n) on nearly-sorted data (TimSort).
    existing.messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

    // FIFO cap: trim oldest-cached (front of sorted array) when over limit
    if (existing.messages.length > MAX_PER_CONVERSATION) {
      existing.messages.splice(0, existing.messages.length - MAX_PER_CONVERSATION)
    }

    if (msg.createdAt > existing.lastMessageAt) {
      existing.lastMessageAt = msg.createdAt
      existing.lastMessagePreview = msg.fileUrl ? `📎 ${msg.fileMimeType?.split('/')[0] || 'File'}` : msg.content.slice(0, 80)
    }
    // Track oldest wrap timestamp for pagination
    if (msg.wrapCreatedAt < existing.oldestWrapTimestamp) {
      existing.oldestWrapTimestamp = msg.wrapCreatedAt
    }
    // Only count as unread if the message is newer than the persisted lastRead
    // AND the user is NOT currently viewing this conversation
    if (!isMine) {
      const activeConv = useDMStore.getState().activeConversation
      if (activeConv === counterparty) {
        // User is viewing this conversation — mark read immediately, don't increment badge
        useNotificationStore.getState().markDmRead(counterparty, 'nip17')
      } else {
        const lastRead = useNotificationStore.getState().dm17Unreads[counterparty]?.lastRead ?? 0
        if (msg.createdAt > lastRead) {
          existing.unread++
        }
      }
      // Play DM sound for real-time messages from followed users
      if (msg.createdAt >= dmSessionStartTime && useFollowStore.getState().followedPubkeys.has(counterparty)) {
        playSoundEffect('dm_message')
      }
    }
  } else {
    // For new conversations, check lastRead before setting initial unread
    let initialUnread = 0
    if (!isMine) {
      const activeConv = useDMStore.getState().activeConversation
      if (activeConv === counterparty) {
        useNotificationStore.getState().markDmRead(counterparty, 'nip17')
      } else {
        const lastRead = useNotificationStore.getState().dm17Unreads[counterparty]?.lastRead ?? 0
        if (msg.createdAt > lastRead) initialUnread = 1
      }
      // Play DM sound for real-time messages from followed users
      if (msg.createdAt >= dmSessionStartTime && useFollowStore.getState().followedPubkeys.has(counterparty)) {
        playSoundEffect('dm_message')
      }
    }
    conversations.set(counterparty, {
      pubkey: counterparty,
      messages: [msg],
      lastMessageAt: msg.createdAt,
      lastMessagePreview: msg.fileUrl ? `📎 ${msg.fileMimeType?.split('/')[0] || 'File'}` : msg.content.slice(0, 80),
      unread: initialUnread,
      oldestWrapTimestamp: msg.wrapCreatedAt,
      hasMore: true,
    })
  }
}
