/**
 * useMessages — Hook for reading decrypted messages and sending messages in a channel
 *
 * Messages come from the shared messageStore, which is populated by:
 * 1. IndexedDB cache (loaded on startup — instant)
 * 2. Initial fetch subscription (limit: 50 latest messages, hub-wide)
 * 3. Per-channel fetch on channel open (fetchChannelLatest — fills gaps from hub-wide fetch)
 * 4. Real-time subscription (new messages as they arrive)
 * 5. History pagination (fetchOlderMessages — scroll-triggered)
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import { useHubStore } from '@/stores/hubStore'
import { useUserStore } from '@/stores/userStore'
import { useMessageStore, type ChatMessage as RawChatMessage } from '@/stores/messageStore'
import type { Attachment } from '@/stores/messageStore'
export type { Attachment }
import { publishEventProgressive, publishToSpecificRelays, assertPublished } from '@/lib/nostr/relay-pool'
import { getPublishRelays, getDeletePublishRelays } from '@/stores/postingBehaviourStore'
import { signWithSigner, mineAndSign, createMessageEvent, createDeletionEvent, createDeletedMessageEvent, createReactionEvent, createEditHintEvent } from '@/lib/nostr/events'
import { nip19 } from 'nostr-tools'
import { KINDS, STANDARD_KINDS } from '@/lib/crypto/constants'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { countLeadingZeroBits } from '@/lib/pow/pow'
import { isClientTagEnabled } from '@/components/social/ComposeSettings'
import { extractEmojiTags, encryptEmojiTags, decryptEmojiTags } from '@/lib/nostr/customEmoji'
import { encryptStickerTags, decryptStickerTags } from '@/lib/nostr/customSticker'
import { encryptGifTags, decryptGifTags } from '@/lib/nostr/customGif'
import { getEmojiMap } from '@/stores/emojiStore'

export interface ChatMessage {
  id: string
  dTag: string
  pubkey: string
  content: string
  timestamp: number
  replyTo?: string
  rootRef?: string
  edited?: boolean
  deleted?: boolean
  /** Underlying event created_at — carried through so edit/replace comparisons
   *  in messageStore keep working after a local self-edit. */
  eventCreatedAt?: number
  decrypted: boolean
  isThread?: boolean
  rawEvent?: string
  attachments?: Attachment[]
  nsfw?: boolean
  clientTag?: string
  facilitator?: string  // npub of the facilitator (from message event tag)
  isForum?: boolean     // true if this is a forum post
  title?: string        // forum post title (from decrypted content)
  featuredImage?: string // forum post featured image URL (from decrypted content)
  forumTags?: string[]  // forum post tags (from decrypted content)
  emojiTags?: [string, string, string?][]  // decrypted NIP-30 emoji tags [shortcode, url, set-ref?]
  stickerTags?: [string, string, string?][]  // decrypted sticker tags [shortcode, url, set-ref?]
  gifTags?: [string, string, string][]  // decrypted GIF tags [name, url, nsfw]
}

/** Stable empty array to avoid Zustand selector returning new reference each render */
const EMPTY_MESSAGES: RawChatMessage[] = []

/**
 * Extract relay-queryable mention tags from plaintext message content.
 * Returns { mentionPubkeys, mentionGroups } to pass to createMessageEvent.
 *
 * - Individual @npub1... → hex pubkey in mentionPubkeys (one p tag each)
 * - @everyone → 'all' in mentionGroups (M tag)
 * - @here → 'here' in mentionGroups (M tag)
 * - @roleName → 'role:<roleId>' in mentionGroups (M tag)
 */
function extractMentionTags(
  text: string,
  hubDTag: string
): { mentionPubkeys: string[]; mentionGroups: string[] } {
  const mentionPubkeys: string[] = []
  const mentionGroups: string[] = []

  // Extract @npub mentions (inserted by the autocomplete as @npub1...)
  const npubPattern = /@(npub1[a-zA-Z0-9]+)/g
  let match: RegExpExecArray | null
  while ((match = npubPattern.exec(text)) !== null) {
    try {
      const { type, data } = nip19.decode(match[1])
      if (type === 'npub' && typeof data === 'string' && !mentionPubkeys.includes(data)) {
        mentionPubkeys.push(data)
      }
    } catch { /* invalid npub — skip */ }
  }

  // Group mentions: @everyone, @here
  if (/(^|[^a-zA-Z0-9_])@everyone(?=[^a-zA-Z0-9_]|$)/i.test(text)) {
    mentionGroups.push('all')
  }
  if (/(^|[^a-zA-Z0-9_])@here(?=[^a-zA-Z0-9_]|$)/i.test(text)) {
    mentionGroups.push('here')
  }

  // Role mentions: @roleName (match against hub's role definitions)
  const hub = useHubStore.getState().hubs[hubDTag]
  if (hub?.roles) {
    for (const role of hub.roles) {
      if (role.name.toLowerCase() === 'everyone') continue // handled by @everyone above
      // Use word-boundary matching to avoid false positives
      const escaped = role.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const roleRegex = new RegExp(`(^|[^a-zA-Z0-9_])@${escaped}(?=[^a-zA-Z0-9_]|$)`, 'i')
      if (roleRegex.test(text)) {
        mentionGroups.push(`role:${role.roleId}`)
      }
    }
  }

  return { mentionPubkeys, mentionGroups }
}

export function useMessages(hubDTag: string | null, channelId: string | null) {
  const [decryptedMessages, setDecryptedMessages] = useState<ChatMessage[]>([])
  const privateKey = useUserStore((s) => s.privateKey)
  const signer = useUserStore((s) => s.signer)
  const pubkey = useUserStore((s) => s.pubkey)
  // Subscribe to a lightweight version counter instead of entire secret objects.
  // This avoids new references on every unrelated secret change, which could cause
  // getChannelKey → decryptContent → effect re-run → setState → re-render → infinite loop.
  const secretsVersion = useHubStore((s) => s._secretsVersion ?? 0)

  // Read raw messages from the shared store — populated by subscriptions + cache
  const rawMessages = useMessageStore((s) => {
    if (!hubDTag || !channelId) return EMPTY_MESSAGES
    return s.messages[hubDTag]?.[channelId] ?? EMPTY_MESSAGES
  })
  const clearUnread = useMessageStore((s) => s.clearUnread)

  // Derive channel key from hub secret or group secret (for encrypted channels)
  // Accepts optional msgEpoch to look up historical secrets for older messages
  //
  // NOTE: This callback intentionally does NOT depend on `hubs` reactively.
  // The hubs object changes dozens of times during startup (metadata, members,
  // channels loading), and each change would cascade through decryptContent →
  // decrypt effect, causing constant cancellation of in-flight async decrypts.
  // Instead, we read hub data from a Zustand snapshot. The `secretsVersion`
  // counter is the ONLY reactive trigger — it bumps when actual encryption
  // keys become available, which is the only change that matters for decryption.
  const getChannelKey = useCallback((msgEpoch?: number): Uint8Array | null => {
    if (!hubDTag || !channelId) return null

    // Read hub from snapshot — avoids recreating this callback on every
    // unrelated hubs change (member lists, metadata, etc.)
    const hub = useHubStore.getState().hubs[hubDTag]
    if (!hub) return null

    // Check if this channel (or its synced category) uses a group encryption key
    const channel = hub.channels.find(ch => ch.channelId === channelId)
    let groupId: string | null = null
    if (channel?.encryption) {
      groupId = channel.encryption
    } else if (channel?.synced && channel.categoryId) {
      // Synced channel inherits category encryption
      const cat = hub.categories.find(c => c.categoryId === channel.categoryId)
      if (cat?.encryption) groupId = cat.encryption
    }

    // Read secrets from store snapshot (not reactive — we react to secretsVersion instead)
    const state = useHubStore.getState()
    const hubSecrets = state.hubSecrets
    const groupSecrets = state.groupSecrets
    const epochSecrets = state.epochSecrets
    const groupEpochSecrets = state.groupEpochSecrets

    let secretHex: string | undefined
    let epoch: number

    if (groupId) {
      // Use group secret + group epoch
      const group = hub.groupedRoles?.find(g => g.groupId === groupId)
      const currentGroupEpoch = group?.epoch || 1
      epoch = msgEpoch ?? currentGroupEpoch

      // If message epoch matches current, use current group secret (fast path)
      if (epoch === currentGroupEpoch) {
        secretHex = groupSecrets[hubDTag]?.[groupId]
      } else {
        // Look up historical group epoch secret
        secretHex = groupEpochSecrets[hubDTag]?.[groupId]?.[epoch]
        if (!secretHex) {
          // Fallback: try current group secret
          secretHex = groupSecrets[hubDTag]?.[groupId]
          epoch = currentGroupEpoch
        }
      }
    } else {
      // Hub-wide secret path
      const currentEpoch = hub.epoch || 1
      epoch = msgEpoch ?? currentEpoch

      // If message epoch matches current, use current secret (fast path)
      if (epoch === currentEpoch) {
        secretHex = hubSecrets[hubDTag]
      } else {
        // Look up historical epoch secret
        secretHex = epochSecrets[hubDTag]?.[epoch]
        if (!secretHex) {
          // Fallback: try current secret (might work if epoch didn't actually change the key)
          secretHex = hubSecrets[hubDTag]
          epoch = currentEpoch
        }
      }
    }

    if (!secretHex) return null

    const secret = new Uint8Array(secretHex.length / 2)
    for (let i = 0; i < secretHex.length; i += 2) {
      secret[i / 2] = parseInt(secretHex.substring(i, i + 2), 16)
    }

    return deriveChannelKey(secret, channelId, epoch)
  }, [hubDTag, channelId, secretsVersion])

  // Decrypt a raw message using its epoch tag for the correct key
  const decryptContent = useCallback(async (raw: RawChatMessage): Promise<ChatMessage> => {
    const key = getChannelKey(raw.epoch)
    let content = raw.content
    let decrypted = false
    let attachments: Attachment[] | undefined
    let isNsfw = false
    let title: string | undefined
    let featuredImage: string | undefined
    let forumTags: string[] | undefined

    if (key && content) {
      try {
        content = await aesDecrypt(key, content)
        decrypted = true
      } catch {
        content = '[Encrypted message]'
      }
    }

    // Try parsing as JSON message format {text, attachments}
    if (decrypted && content) {
      try {
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed.text === 'string') {
          content = parsed.text
          if (Array.isArray(parsed.attachments) && parsed.attachments.length > 0) {
            attachments = parsed.attachments
          }
          // Check for nsfw flag in decrypted JSON
          if (parsed.nsfw === true) {
            isNsfw = true
          }
          // Forum post fields
          if (typeof parsed.title === 'string') {
            title = parsed.title
          }
          if (typeof parsed.featured_image === 'string') {
            featuredImage = parsed.featured_image
          }
          if (Array.isArray(parsed.tags)) {
            forumTags = parsed.tags
          }
        }
      } catch {
        // Not JSON — legacy plain text message, content stays as-is
      }
    }

    // Decrypt emoji, sticker, and GIF tags from raw event
    let emojiTags: [string, string, string?][] | undefined
    let stickerTags: [string, string, string?][] | undefined
    let gifTags: [string, string, string][] | undefined
    const channelKey = getChannelKey(raw.epoch)
    if (raw.rawEvent) {
      emojiTags = await decryptEmojiTags(raw.rawEvent, channelKey)
      stickerTags = await decryptStickerTags(raw.rawEvent, channelKey)
      gifTags = await decryptGifTags(raw.rawEvent, channelKey)
    }

    return {
      id: raw.id,
      dTag: raw.dTag,
      pubkey: raw.pubkey,
      content,
      timestamp: raw.createdAt,
      replyTo: raw.replyTo,
      rootRef: raw.rootRef,
      edited: raw.edited,
      deleted: raw.deleted,
      decrypted,
      isThread: raw.isThread,
      rawEvent: raw.rawEvent,
      attachments,
      nsfw: isNsfw,
      clientTag: raw.clientTag,
      facilitator: raw.facilitator,
      isForum: raw.isForum || !!title,  // derive from raw tag OR decrypted content
      title,
      featuredImage,
      forumTags,
      emojiTags,
      stickerTags,
      gifTags,
    }
  }, [getChannelKey])

  // Clear unread when viewing a hub
  useEffect(() => {
    if (hubDTag) {
      clearUnread(hubDTag)
    }
  }, [hubDTag, channelId, clearUnread])

  // Cache for self-sent messages: stores pre-decrypted versions so they appear
  // immediately without waiting for the async decrypt pipeline. Entries are
  // cleaned up once the pipeline produces the same message (matched by dTag).
  const selfDecryptedRef = useRef<Map<string, ChatMessage>>(new Map())

  // Decrypt raw messages whenever they change
  // NOTE: We intentionally do NOT include `hubs` in the dependency array.
  // The hubs object changes frequently during startup (metadata, members,
  // channels, etc.), and each change would cancel the in-flight async decrypt
  // via the `cancelled` flag — causing recently-injected messages to vanish.
  // minPow is read from a Zustand snapshot instead. The `decryptContent`
  // callback already reacts to key changes via `secretsVersion`.
  useEffect(() => {
    if (rawMessages.length === 0) {
      // Even with no raw messages, show any self-decrypted cache entries
      if (selfDecryptedRef.current.size > 0) {
        setDecryptedMessages([...selfDecryptedRef.current.values()])
      } else {
        setDecryptedMessages([])
      }
      return
    }

    // Filter out messages that don't meet hub PoW difficulty
    // Read from snapshot to avoid adding `hubs` as a reactive dependency
    const hubSnapshot = hubDTag ? useHubStore.getState().hubs[hubDTag] : null
    const minPow = hubSnapshot?.minPow || 0
    const filtered = minPow > 0
      ? rawMessages.filter((m) => countLeadingZeroBits(m.id) >= minPow)
      : rawMessages


    if (filtered.length === 0) {
      if (selfDecryptedRef.current.size > 0) {
        setDecryptedMessages([...selfDecryptedRef.current.values()])
      } else {
        setDecryptedMessages([])
      }
      return
    }

    let cancelled = false


    Promise.all(filtered.map(decryptContent)).then((decrypted) => {
      if (!cancelled) {
        // Apply hub prefs visibility filtering
        const prefs = hubDTag ? useHubStore.getState().hubPrefs[hubDTag] : undefined
        const members = hubDTag ? useHubStore.getState().hubMembers[hubDTag] : undefined
        const banList = hubDTag ? useHubStore.getState().hubBanLists[hubDTag] : undefined
        const facMembers = hubDTag ? useHubStore.getState().hubFacilitatorMembers[hubDTag] : undefined
        const modBans = hubDTag ? useHubStore.getState().modBanLists[hubDTag] : undefined
        const memberPubkeys = members ? new Set(members.map((m) => m.pubkey)) : new Set<string>()
        const bannedPubkeys = banList ? new Set(banList) : new Set<string>()

        // Merge mod ban lists — subtract mod-banned pubkeys, except w-flagged members (NIP-CHAT §5.3)
        if (modBans) {
          const whitelistedPubkeys = new Set(
            members?.filter(m => m.flags?.includes('w')).map(m => m.pubkey) || []
          )
          for (const modBanList of Object.values(modBans)) {
            for (const pk of modBanList) {
              if (!whitelistedPubkeys.has(pk)) bannedPubkeys.add(pk)
            }
          }
        }

        const showFacilitated = prefs?.showFacilitatedMessages ?? true
        const hideNonMember = useHubStore.getState().hideNonMemberMessages

        const visible = decrypted.filter((msg) => {
          // Always show own messages
          if (msg.pubkey === pubkey) return true
          // Never show messages from banned users
          if (bannedPubkeys.has(msg.pubkey)) return false
          // Members always shown
          if (memberPubkeys.size === 0 || memberPubkeys.has(msg.pubkey)) return true
          // Facilitated messages — verify facilitator is a member AND author is in facilitator's tree
          if (msg.facilitator && memberPubkeys.has(msg.facilitator)) {
            const isInFacTree = facMembers?.[msg.facilitator]?.includes(msg.pubkey)
            if (isInFacTree) return showFacilitated
          }
          // Non-member without valid facilitation — respect hideNonMemberMessages toggle
          return !hideNonMember
        })

        // Merge self-decrypted cache: ensures self-sent messages are always
        // visible even when the async decrypt pipeline gets interrupted.
        // Clean up cache entries once the pipeline produces the real version.
        const visibleDTags = new Set(visible.map((m) => m.dTag))
        for (const [dTag] of selfDecryptedRef.current) {
          if (visibleDTags.has(dTag)) {
            // Pipeline produced this message — cache no longer needed
            selfDecryptedRef.current.delete(dTag)
          } else {
            // Pipeline hasn't caught up — inject from cache
            const cached = selfDecryptedRef.current.get(dTag)!
            visible.push(cached)
          }
        }
        visible.sort((a, b) => a.timestamp - b.timestamp)


        setDecryptedMessages(visible)
      }
    })

    return () => { cancelled = true }
  }, [rawMessages, decryptContent, hubDTag, pubkey])

  // Send a message
  const sendMessage = useCallback(async (
    text: string,
    replyTo?: { pubkey: string; dTag?: string; eventId?: string },
    onPhase?: (phase: 'mining' | 'publishing', relayProgress?: { confirmed: number; total: number }, sentDTag?: string) => void,
    rootRef?: string,
    attachments?: Attachment[],
    nsfw?: boolean,
    isThread?: boolean,
    encrypted?: boolean,
    facilitator?: string,
    forumFields?: { title: string; featuredImage?: string; tags?: string[] },
    stickerTags?: [string, string, string, string][],
    gifTags?: [string, string, string, string][]
  ) => {
    if (!hubDTag || !channelId || (!signer && !privateKey)) return

    // Determine if we should encrypt (default: yes if we have a key)
    const shouldEncrypt = encrypted !== false
    const key = shouldEncrypt ? getChannelKey() : null

    // Guard: don't send to an encrypted channel without a key.
    // During startup, the hub secret may still be loading. Sending plaintext
    // to an encrypted channel would create a permanently unreadable message
    // (AES decrypt of plaintext fails after the key loads → data corruption).
    if (shouldEncrypt && !key) {
      throw new Error('Encryption key not ready — hub secret is still loading')
    }

    // Wrap as JSON if attachments, nsfw, or forum fields present
    let plaintext = text
    if ((attachments && attachments.length > 0) || nsfw || forumFields) {
      const payload: any = { text }
      if (attachments && attachments.length > 0) payload.attachments = attachments
      if (nsfw) payload.nsfw = true
      if (forumFields) {
        payload.title = forumFields.title
        if (forumFields.featuredImage) payload.featured_image = forumFields.featuredImage
        if (forumFields.tags && forumFields.tags.length > 0) payload.tags = forumFields.tags
      }
      plaintext = JSON.stringify(payload)
    }

    let content = plaintext
    if (key) {
      content = await aesEncrypt(key, plaintext)
    }

    // Read hub data from snapshot — NOT from the `hubs` closure.
    // During startup, the useCallback closure may capture stale hub data
    // (minPow=0, epoch=1) because the hub definition hasn't loaded yet.
    // Using getState() ensures we always have the latest values at call time.
    const hub = useHubStore.getState().hubs[hubDTag!]
    if (!hub) {
      throw new Error('Hub data not loaded yet')
    }
    const minPow = hub.minPow || 0
    const epoch = hub.epoch || 1

    // Extract mention tags from plaintext for relay-queryable p and M tags
    const { mentionPubkeys, mentionGroups } = extractMentionTags(text, hubDTag!)

    let unsigned = createMessageEvent(content, hubDTag, channelId, epoch, replyTo, undefined, rootRef, nsfw, isThread, facilitator, !!forumFields, mentionPubkeys.length > 0 ? mentionPubkeys : undefined, mentionGroups.length > 0 ? mentionGroups : undefined)

    // Tag with the original publication time — edits carry this forward so
    // all clients can order the message at its original position
    unsigned = { ...unsigned, tags: [...unsigned.tags, ['published_at', unsigned.created_at.toString()]] }

    // Add client tag if enabled in preferences
    if (isClientTagEnabled()) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, ['client', 'DEN Chat']] }
    }

    // Add NIP-30 custom emoji tags for :shortcode: in the message
    const emojiTags = extractEmojiTags(text, getEmojiMap())
    if (emojiTags.length > 0) {
      // Encrypt emoji tag values with the channel key if available
      const encTags = key ? await encryptEmojiTags(emojiTags, key) : emojiTags
      unsigned = { ...unsigned, tags: [...unsigned.tags, ...encTags] }
    }

    // Add sticker tags (encrypted if available)
    if (stickerTags && stickerTags.length > 0) {
      const encStickers = key ? await encryptStickerTags(stickerTags, key) : stickerTags
      unsigned = { ...unsigned, tags: [...unsigned.tags, ...encStickers] }
    }

    // Add GIF tags (encrypted if available)
    if (gifTags && gifTags.length > 0) {
      const encGifs = key ? await encryptGifTags(gifTags, key) : gifTags
      unsigned = { ...unsigned, tags: [...unsigned.tags, ...encGifs] }
    }

    // Mine PoW + sign (with automatic retry if signer invalidates PoW)
    if (minPow > 0) onPhase?.('mining')
    const signed = await mineAndSign(unsigned, minPow, pubkey, signer, privateKey)

    const sentDTag = unsigned.tags.find((t: string[]) => t[0] === 'd')![1]
    onPhase?.('publishing', { confirmed: 0, total: 0 }, sentDTag)
    const eventId = signed.id

    // Build the store message and self-decrypt entry
    const publishedAtTag = signed.tags.find((t: string[]) => t[0] === 'published_at')
    const ownMsg: import('@/stores/messageStore').ChatMessage = {
      id: signed.id,
      dTag: signed.tags.find((t: string[]) => t[0] === 'd')![1],
      hubDTag: hubDTag!,
      channelId: channelId!,
      pubkey: signed.pubkey,
      content: signed.content,
      createdAt: publishedAtTag ? parseInt(publishedAtTag[1], 10) : signed.created_at,
      eventCreatedAt: signed.created_at,
      epoch: epoch,
      replyTo: replyTo ? `${KINDS.MESSAGE}:${replyTo.pubkey}:${replyTo.dTag}` : undefined,
      rootRef: rootRef,
      deleted: false,
      isThread: isThread,
      isForum: !!forumFields,
      rawEvent: JSON.stringify(signed),
      clientTag: isClientTagEnabled() ? 'DEN Chat' : undefined,
      facilitator: facilitator,
    }

    // ── Instant local injection (before publish) ──
    // Inject into the message store + self-decrypt cache immediately so the
    // message renders without waiting for any relay confirmation.
    useMessageStore.getState().addMessage(ownMsg)
    import('@/lib/cache/messageCache').then(({ cacheMessageWithDedup }) => {
      cacheMessageWithDedup(ownMsg).catch(() => {})
    })

    const selfMsg: ChatMessage = {
      id: signed.id,
      dTag: ownMsg.dTag,
      pubkey: signed.pubkey,
      content: text,          // use original user text, not JSON-wrapped plaintext
      timestamp: ownMsg.createdAt,
      replyTo: ownMsg.replyTo,
      rootRef: rootRef,
      deleted: false,
      decrypted: true,
      isThread: isThread,
      rawEvent: ownMsg.rawEvent,
      attachments: (attachments && attachments.length > 0) ? attachments : undefined,
      nsfw: nsfw,
      clientTag: ownMsg.clientTag,
      facilitator: facilitator,
      isForum: !!forumFields,
      title: forumFields?.title,
      featuredImage: forumFields?.featuredImage,
      forumTags: forumFields?.tags,
    }
    selfDecryptedRef.current.set(ownMsg.dTag, selfMsg)

    // Immediately merge into current decrypted messages so it renders now
    setDecryptedMessages((prev) => {
      if (prev.some((m) => m.dTag === ownMsg.dTag && m.pubkey === signed.pubkey)) return prev
      return [...prev, selfMsg].sort((a, b) => a.timestamp - b.timestamp)
    })

    // ── Fire-and-forget publish ──
    // Publish in the background — the message is already visible locally.
    // Progress callbacks update relay indicators; if ALL relays reject,
    // the onPhase callback notifies the component to show a failed state.
    const hubRelays = hub?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays)
    const { setRelayProgress, clearRelayProgress } = useMessageStore.getState()

    // Seed relay progress at 0/N immediately so the counter is visible
    // from the moment the message appears — no gap where it looks "published"
    setRelayProgress(eventId, 0, publishRelays.length, [])
    onPhase?.('publishing', { confirmed: 0, total: publishRelays.length })

    ;(async () => {
      try {
        const accepted = await publishEventProgressive(signed, (confirmed, total, acceptedRelays) => {
          setRelayProgress(eventId, confirmed, total, acceptedRelays)
          onPhase?.('publishing', { confirmed, total })
        }, publishRelays)

        if (accepted.length === 0) {
          // All relays rejected — remove from local store to avoid phantom message
          useMessageStore.getState().removeMessage(hubDTag!, channelId!, ownMsg.dTag)
          selfDecryptedRef.current.delete(ownMsg.dTag)
          setDecryptedMessages((prev) => prev.filter((m) => !(m.dTag === ownMsg.dTag && m.pubkey === signed.pubkey)))
          onPhase?.('publishing', { confirmed: 0, total: publishRelays.length })
          throw new Error('Message rejected by all relays')
        }

        // Auto-clear the relay progress indicator after 5 seconds
        setTimeout(() => clearRelayProgress(eventId), 5000)
      } catch (err) {
        console.error('[useMessages] Background publish failed:', err)
      }
    })()
  }, [hubDTag, channelId, signer, privateKey, pubkey, getChannelKey])

  // Edit a message — re-publish with the same d-tag (relay replaces the old version)
  // Preserves reply context (replyTo + rootRef) so reply tags aren't lost on edit
  const editMessage = useCallback(async (
    dTag: string,
    newText: string,
    replyTo?: string,
    rootRef?: string,
    forumFields?: { title: string; featuredImage?: string; tags?: string[] },
    attachments?: Attachment[],
    nsfw?: boolean,
    isThread?: boolean
  ) => {
    if (!hubDTag || !channelId || (!signer && !privateKey)) return

    const key = getChannelKey()

    // Wrap as JSON if attachments, nsfw, or forum fields present (same as sendMessage)
    let plaintext = newText
    if ((attachments && attachments.length > 0) || nsfw || forumFields) {
      const payload: any = { text: newText }
      if (attachments && attachments.length > 0) payload.attachments = attachments
      if (nsfw) payload.nsfw = true
      if (forumFields) {
        payload.title = forumFields.title
        if (forumFields.featuredImage) payload.featured_image = forumFields.featuredImage
        if (forumFields.tags && forumFields.tags.length > 0) payload.tags = forumFields.tags
      }
      plaintext = JSON.stringify(payload)
    }

    let content = plaintext
    if (key) {
      content = await aesEncrypt(key, plaintext)
    }

    // Parse the a-tag ref back into {pubkey, dTag} for createMessageEvent
    let replyToObj: { pubkey: string; dTag: string } | undefined
    if (replyTo) {
      const parts = replyTo.split(':')
      if (parts.length >= 3) {
        replyToObj = { pubkey: parts[1], dTag: parts.slice(2).join(':') }
      }
    }

    const hub = useHubStore.getState().hubs[hubDTag!]
    const minPow = hub?.minPow || 0
    const epoch = hub?.epoch || 1
    // Re-publish with same d-tag — relay replaces the previous version
    // Extract mention tags from edited text for relay-queryable p and M tags
    const { mentionPubkeys, mentionGroups } = extractMentionTags(newText, hubDTag!)

    // Preserve nsfw + thread markers on edit — otherwise an edited thread-reply
    // loses its ['thread'] tag and re-renders as a normal reply in the main chat.
    let unsigned = createMessageEvent(content, hubDTag, channelId, epoch, replyToObj, dTag, rootRef, nsfw, isThread, undefined, !!forumFields, mentionPubkeys.length > 0 ? mentionPubkeys : undefined, mentionGroups.length > 0 ? mentionGroups : undefined)

    // Carry forward published_at from the original message so the edited
    // version stays at its original position in the timeline for all clients.
    // Also set created_at to previous +1 so the relay accepts the replacement
    // but keeps the event in its original chronological bucket (prevents
    // edited old messages from stealing slots in limit-based fetches).
    const existingMessages = useMessageStore.getState().messages[hubDTag]?.[channelId] || []
    const originalMsg = existingMessages.find((m) => m.dTag === dTag && m.pubkey === pubkey)
    if (originalMsg) {
      // +1 from the actual event timestamp (not published_at) so repeated edits accumulate
      const prevEventTs = originalMsg.eventCreatedAt || originalMsg.createdAt
      unsigned = { ...unsigned, created_at: prevEventTs + 1 }

      // Carry forward published_at from original raw event tags; fall back to createdAt
      let publishedAt = originalMsg.createdAt.toString()
      if (originalMsg.rawEvent) {
        try {
          const raw = JSON.parse(originalMsg.rawEvent)
          const tag = raw.tags?.find((t: string[]) => t[0] === 'published_at')
          if (tag?.[1]) publishedAt = tag[1]
        } catch { /* use fallback */ }
      }
      unsigned = { ...unsigned, tags: [...unsigned.tags, ['published_at', publishedAt]] }
    }

    // Add client tag if enabled in preferences
    if (isClientTagEnabled()) {
      unsigned = { ...unsigned, tags: [...unsigned.tags, ['client', 'DEN Chat']] }
    }

    // Add NIP-30 custom emoji tags for :shortcode: in the edited message
    const emojiTags = extractEmojiTags(newText, getEmojiMap())
    if (emojiTags.length > 0) {
      const encTags = key ? await encryptEmojiTags(emojiTags, key) : emojiTags
      unsigned = { ...unsigned, tags: [...unsigned.tags, ...encTags] }
    }

    // Mine PoW + sign (with automatic retry if signer invalidates PoW)
    const signed = await mineAndSign(unsigned, minPow, pubkey, signer, privateKey)
    const eventId = signed.id
    const hubRelays = useHubStore.getState().hubs[hubDTag!]?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays)

    // Optimistic local update — immediately reflect the edit in the UI
    // Uses the new event ID so RelayProgressIndicator can track publish progress
    const { setRelayProgress, clearRelayProgress, updateMessageContent } = useMessageStore.getState()
    updateMessageContent(
      hubDTag!, channelId!, dTag, pubkey!,
      content, // the (possibly encrypted) content — store holds raw content
      signed.created_at,
      eventId,
      JSON.stringify(signed),
      epoch, // update epoch so decrypt pipeline uses the correct key
    )

    // Inject pre-decrypted edit into selfDecryptedRef so the UI doesn't briefly
    // flash "Encrypted Message" while the async decrypt pipeline re-runs.
    // Same pattern as sendMessage (line 534).
    // Uses functional updater to avoid stale closure on decryptedMessages.
    setDecryptedMessages((prev) => {
      const existingDecrypted = prev.find((m) => m.dTag === dTag && m.pubkey === pubkey)
      if (!existingDecrypted) return prev
      const selfEditedMsg: ChatMessage = {
        ...existingDecrypted,
        id: eventId,
        content: newText,        // plaintext — the user's actual text
        edited: true,
        eventCreatedAt: signed.created_at,
        rawEvent: JSON.stringify(signed),
        attachments: attachments,
        nsfw: nsfw,
        title: forumFields?.title,
        featuredImage: forumFields?.featuredImage,
        forumTags: forumFields?.tags,
      }
      selfDecryptedRef.current.set(dTag, selfEditedMsg)
      return prev.map((m) => (m.dTag === dTag && m.pubkey === pubkey) ? selfEditedMsg : m)
    })

    // Persist edited message to IndexedDB cache so the stale pre-edit version
    // doesn't resurrect on restart (same pattern as sendMessage + deleteMessage)
    const publishedAtTag = signed.tags.find((t: string[]) => t[0] === 'published_at')
    const editedCacheMsg: import('@/stores/messageStore').ChatMessage = {
      id: signed.id,
      dTag,
      hubDTag: hubDTag!,
      channelId: channelId!,
      pubkey: signed.pubkey,
      content: signed.content,
      createdAt: publishedAtTag ? parseInt(publishedAtTag[1], 10) : signed.created_at,
      eventCreatedAt: signed.created_at,
      epoch,
      replyTo: replyTo,
      rootRef: rootRef,
      edited: true,
      deleted: false,
      isForum: !!forumFields,
      rawEvent: JSON.stringify(signed),
      clientTag: isClientTagEnabled() ? 'DEN Chat' : undefined,
    }
    import('@/lib/cache/messageCache').then(async ({ replaceCachedMessage }) => {
      // Atomic delete-old + write-new in a single IDB transaction
      // (avoids readwrite queue stall from concurrent subscription cacheMessage calls)
      const oldId = originalMsg?.id
      console.log(`[Edit] Replacing cache: old=${oldId?.slice(0, 12)}… → new=${signed.id.slice(0, 12)}…, dTag=${dTag.slice(0, 12)}…, eventCreatedAt=${signed.created_at}`)
      await replaceCachedMessage(oldId, editedCacheMsg).then(() => {
        console.log(`[Edit] Cache replace SUCCESS for eventId=${signed.id.slice(0, 12)}…`)
      }).catch((e) => console.warn('[Edit] Cache replace FAILED:', e))
    })

    // Progressive publishing — fires callback on each relay confirmation
    // The RelayProgressIndicator next to the message picks this up via eventId
    const editAccepted = await publishEventProgressive(signed, (confirmed, total, acceptedRelays) => {
      setRelayProgress(eventId, confirmed, total, acceptedRelays)
    }, publishRelays)
    assertPublished(editAccepted)   // dead-relay → throw so the edit field shows an error

    // Publish ephemeral edit hint (kind 26943) to notify other connected clients.
    // Fire-and-forget — hint failure should not affect the edit itself.
    // Uses mineAndSign to meet hub PoW difficulty (prevents amplification abuse, §6.13).
    const hintUnsigned = createEditHintEvent(hubDTag!, dTag, channelId!)
    mineAndSign(hintUnsigned, minPow, pubkey, signer, privateKey)
      .then((hintSigned) => {
        console.log(`[EditHint] Publishing hint id=${hintSigned.id.slice(0, 12)}… kind=${hintSigned.kind} to ${publishRelays.length} relays, tags=${JSON.stringify(hintSigned.tags)}`)
        return publishToSpecificRelays(publishRelays, hintSigned)
      })
      .then((accepted) => {
        console.log(`[EditHint] Hint accepted by ${accepted.length}/${publishRelays.length} relays: ${accepted.join(', ')}`)
      })
      .catch((err) => {
        console.error(`[EditHint] Hint publish FAILED:`, err)
      })

    // Auto-clear the relay progress indicator after 5 seconds
    setTimeout(() => {
      clearRelayProgress(eventId)
    }, 5000)
  }, [hubDTag, channelId, signer, privateKey, pubkey, getChannelKey])

  // Delete a message — re-publish with deleted tag + NIP-09 fallback via a-tag
  const deleteMessage = useCallback(async (dTag: string) => {
    if (!hubDTag || !channelId || (!signer && !privateKey) || !pubkey) return

    // Look up original message timestamp for created_at + 1 ordering
    const existingMessages = useMessageStore.getState().messages[hubDTag]?.[channelId] || []
    const originalMsg = existingMessages.find((m) => m.dTag === dTag && m.pubkey === pubkey)
    const originalCreatedAt = originalMsg?.eventCreatedAt || originalMsg?.createdAt

    // 1. Re-publish with same d-tag + deleted tag (primary — replaces original on relay)
    const hub = useHubStore.getState().hubs[hubDTag!]
    const epoch = hub?.epoch || 1
    const deletedEvent = createDeletedMessageEvent(dTag, hubDTag, channelId, epoch, originalCreatedAt)
    const signedDeleted = await signWithSigner(deletedEvent, signer, privateKey)
    const hubRelays = useHubStore.getState().hubs[hubDTag!]?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays)
    const deleteRelays = getDeletePublishRelays(hubRelays)
    await publishToSpecificRelays(deleteRelays, signedDeleted)

    // 2. NIP-09 deletion request as fallback
    const aRef = `${KINDS.MESSAGE}:${pubkey}:${dTag}`
    const deletionEvent = createDeletionEvent([], [aRef], 'User requested deletion')
    const signedDeletion = await signWithSigner(deletionEvent, signer, privateKey)
    await publishToSpecificRelays(deleteRelays, signedDeletion)

    // Mark deleted locally for immediate UI feedback
    useMessageStore.getState().markDeleted(hubDTag, channelId, dTag)

    // Persist deletion to IndexedDB cache so the message doesn't resurrect on reload.
    // Remove the old cache entry (keyed by original event ID) and write the deleted replacement.
    import('@/lib/cache/messageCache').then(({ deleteCachedMessage, cacheMessageWithDedup }) => {
      if (originalMsg) {
        deleteCachedMessage(originalMsg.id).catch(() => {})
      }
      // Cache the deleted replacement so the store picks up deleted: true from cache on next load
      const deletedCacheMsg: import('@/stores/messageStore').ChatMessage = {
        id: signedDeleted.id,
        dTag,
        hubDTag: hubDTag!,
        channelId: channelId!,
        pubkey: signedDeleted.pubkey,
        content: '',
        createdAt: originalMsg?.createdAt || signedDeleted.created_at,
        eventCreatedAt: signedDeleted.created_at,
        epoch,
        deleted: true,
      }
      cacheMessageWithDedup(deletedCacheMsg).catch(() => {})
    })

    // Publish ephemeral deletion hint (kind 26943) to notify other connected clients.
    // Reuses the same edit hint event — receivers re-fetch the dTag and get the
    // deleted version, removing the message from their UI in real-time.
    // Fire-and-forget — hint failure should not affect the deletion itself.
    const minPow = hub?.minPow || 0
    const hintUnsigned = createEditHintEvent(hubDTag!, dTag, channelId!)
    mineAndSign(hintUnsigned, minPow, pubkey, signer, privateKey)
      .then((hintSigned) => {
        console.log(`[DeleteHint] Publishing hint id=${hintSigned.id.slice(0, 12)}… kind=${hintSigned.kind} to ${publishRelays.length} relays`)
        return publishToSpecificRelays(publishRelays, hintSigned)
      })
      .then((accepted) => {
        console.log(`[DeleteHint] Hint accepted by ${accepted.length}/${publishRelays.length} relays: ${accepted.join(', ')}`)
      })
      .catch((err) => {
        console.error(`[DeleteHint] Hint publish FAILED:`, err)
      })
  }, [hubDTag, channelId, signer, privateKey, pubkey])

  // Publish a reaction (kind 7) to a message
  const publishReaction = useCallback(async (
    emoji: string,
    targetEventId: string,
    targetPubkey: string,
    targetDTag?: string,
    customUrl?: string
  ) => {
    if (!hubDTag || !channelId || (!signer && !privateKey)) return

    const key = getChannelKey()
    const hub = useHubStore.getState().hubs[hubDTag!]
    const epoch = hub?.epoch || 1

    // Encrypt emoji content
    let content = emoji
    if (key) content = await aesEncrypt(key, emoji)

    // Build the event — only include a-tag ref for addressable events (messages with dTag)
    const targetARef = targetDTag ? `${KINDS.MESSAGE}:${targetPubkey}:${targetDTag}` : undefined
    let unsigned = createReactionEvent(content, hubDTag!, channelId!, epoch, targetEventId, targetARef, targetPubkey)

    // Custom emoji tag (encrypted with channel key)
    if (customUrl) {
      const scMatch = emoji.match(/^:([a-zA-Z0-9_-]+):$/)
      if (scMatch) {
        if (key) {
          const encSc = await aesEncrypt(key, scMatch[1])
          const encUrl = await aesEncrypt(key, customUrl)
          unsigned = { ...unsigned, tags: [...unsigned.tags, ['emoji', encSc, encUrl]] }
        } else {
          unsigned = { ...unsigned, tags: [...unsigned.tags, ['emoji', scMatch[1], customUrl]] }
        }
      }
    }

    // Client tag is added by createReactionEvent (respects the settings toggle)

    const signed = await signWithSigner(unsigned, signer, privateKey)
    const hubRelays = hub?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays)

    // Mark as processed to avoid dedup with subscription
    useMessageStore.getState().markReactionProcessed(signed.id)

    await publishToSpecificRelays(publishRelays, signed)
  }, [hubDTag, channelId, signer, privateKey, getChannelKey])

  // Unreact — send kind 5 deletion request only
  const unreactReaction = useCallback(async (
    reactionEventId: string,
  ) => {
    if (!hubDTag || !channelId || (!signer && !privateKey)) return

    const hub = useHubStore.getState().hubs[hubDTag!]
    const hubRelays = hub?.generalRelays || []
    const publishRelays = getDeletePublishRelays(hubRelays)

    // Kind 5 deletion request for the reaction event
    const deletionEvent = createDeletionEvent([reactionEventId], [], 'User removed reaction')
    const signedDeletion = await signWithSigner(deletionEvent, signer, privateKey)
    await publishToSpecificRelays(publishRelays, signedDeletion)
  }, [hubDTag, channelId, signer, privateKey])

  return { messages: decryptedMessages, loading: false, sendMessage, editMessage, deleteMessage, publishReaction, unreactReaction, getChannelKey }
}
