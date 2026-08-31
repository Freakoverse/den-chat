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
import { nip19, type Event } from 'nostr-tools'
import { KINDS, STANDARD_KINDS } from '@/lib/crypto/constants'
import { stampHubExpiration } from '@/lib/hub/messageExpiration'
import { aesEncrypt, aesDecrypt } from '@/lib/crypto/aes'
import { deriveChannelKey } from '@/lib/crypto/hkdf'
import { makeSubkeySigner, mineAndSignAsSubkey } from '@/lib/nostr/v2send'
import { buildIdentityTag, verifyEventIdentity } from '@/lib/nostr/identity'
import { signHubMemberEvent, resolveV2PostingSigner } from '@/lib/hub/hubMemberSign'
import { ChatContext, canUseV2 } from '@/lib/crypto/skd'
import { isAuthorizedFacilitator } from '@/lib/hub/permissions'
import { isV2 } from '@/lib/hub/version'
import { filterCacheable } from '@/lib/hub/verifyMessageForCache'
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
  expiration?: number   // NIP-40 expiration (unix seconds) — disappearing messages
  /** v2: the real key R resolved from the encrypted `identity` tag. Display author
   *  (name/avatar/own-message checks) should use this, not `pubkey` (= P). */
  realPubkey?: string
  /** v2: true when an `identity` tag is present but its per-message signature failed
   *  to verify — such a message MUST NOT render (spoofed/tampered). */
  identityInvalid?: boolean
}

/** Stable empty array to avoid Zustand selector returning new reference each render */
const EMPTY_MESSAGES: RawChatMessage[] = []
// Dedup set for lazy facilitator-member-list loads (`${dTag}:${facilitatorPubkey}`) — module-level
// so a load is triggered at most once per facilitator across renders/components.
const _facListLoadTriggered = new Set<string>()
// Facilitators whose cached list we've already background-revalidated this session (once each).
const _facListRevalidated = new Set<string>()

/**
 * Clear the module-level facilitator-load dedup sets. MUST be called on account switch — otherwise a
 * `dTag:facilitatorPubkey` marked "loaded/revalidated" under the previous account suppresses the fetch
 * for the new account, leaving a facilitated user with no vouched-member list until a hard reload.
 */
export function clearFacListDedup() {
  _facListLoadTriggered.clear()
  _facListRevalidated.clear()
}


/**
 * Load a facilitator's vouched-member list into the store, with a few backoff retries.
 *
 * Why retry: `loadFacilitatorMemberList` returns an empty array on a transient relay miss (the
 * facilitator's join request simply wasn't returned in time), not just on a real "no list". Without
 * retry that transient empty would be treated as final and permanently hide the facilitator's
 * vouched messages until an app restart — the exact "sometimes they never appear" symptom.
 *
 * On success we keep the dedup key (don't reload). On final give-up we RELEASE the key so a later
 * decrypt pass (new messages, re-open) can try again. `revalidate` = we already have a cached list
 * (possibly from localStorage): do a single quiet refresh and never clear a good cached value.
 */
async function loadFacListWithRetry(
  hubForPerms: { dTag: string; blossomServers: string[] },
  fac: string,
  dTag: string,
  cacheKey: string,
  revalidate = false,
): Promise<void> {
  const delays = revalidate ? [0] : [0, 1500, 3000, 5000]
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
    try {
      const { loadFacilitatorMemberList } = await import('@/hooks/useHubLoader')
      const list = await loadFacilitatorMemberList(hubForPerms, fac)
      if (list.length > 0) {
        useHubStore.getState().setHubFacilitatorMembers(dTag, fac, list)
        return
      }
    } catch { /* fall through to retry */ }
  }
  // Ran out of attempts. For a fresh (non-cached) load, release the key so we can retry later.
  if (!revalidate) _facListLoadTriggered.delete(cacheKey)
}

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

  // Resolve the epoch to STAMP on an outgoing content event for this channel. Group channels rotate on
  // their OWN epoch counter (groupedRoles[].epoch), independent of the hub-wide epoch — and the write
  // key comes from getChannelKey() at that group epoch. Stamping hub.epoch instead would let a reader
  // whose group-epoch history happens to hold a secret at that same integer value derive the wrong key
  // (group and hub epoch counters collide freely). Stamp the same epoch getChannelKey() encrypted with.
  const getChannelEpoch = useCallback((): number => {
    if (!hubDTag || !channelId) return 1
    const hub = useHubStore.getState().hubs[hubDTag]
    if (!hub) return 1
    const channel = hub.channels.find(ch => ch.channelId === channelId)
    let groupId: string | null = null
    if (channel?.encryption) {
      groupId = channel.encryption
    } else if (channel?.synced && channel.categoryId) {
      const cat = hub.categories.find(c => c.categoryId === channel.categoryId)
      if (cat?.encryption) groupId = cat.encryption
    }
    if (groupId) {
      const group = hub.groupedRoles?.find(g => g.groupId === groupId)
      return group?.epoch || 1
    }
    return hub.epoch || 1
  }, [hubDTag, channelId, secretsVersion])

  // Decrypt+verify result cache, keyed by message id. The decrypt effect re-fires on EVERY `addMessage`
  // (rawMessages is a fresh array ref each time) — during hub-open, dozens of cache-ingest + subscription
  // batches stream in, so without this every pass would re-run the SYNCHRONOUS schnorr verify
  // (verifyEventIdentity) + AES decrypt for the whole channel, freezing the main thread for seconds. The
  // signature captures everything the decrypted result depends on beyond the (immutable-per-id) event:
  // the secrets generation (a key may have just loaded) and the mutable deleted/edited flags. A hit skips
  // all crypto. Cleared on channel switch (below) to bound growth.
  const decryptCacheRef = useRef<Map<string, { sig: string; result: ChatMessage }>>(new Map())

  // Decrypt a raw message using its epoch tag for the correct key
  const decryptContent = useCallback(async (raw: RawChatMessage): Promise<ChatMessage> => {
    const sig = `${secretsVersion}|${raw.deleted ? 1 : 0}|${raw.edited ? 1 : 0}`
    const cached = decryptCacheRef.current.get(raw.id)
    if (cached && cached.sig === sig) return cached.result
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

    // v2 identity — resolve the real key R for display and validate the
    // per-message signature (drop-rule stage 2, NIP-CHAT §0.1).
    let realPubkey: string | undefined
    let identityInvalid = false
    const hubForId = raw.hubDTag ? useHubStore.getState().hubs[raw.hubDTag] : null
    if (hubForId && isV2(hubForId) && raw.rawEvent && channelKey) {
      try {
        const res = await verifyEventIdentity(JSON.parse(raw.rawEvent) as Event, channelKey)
        if (res.ok) realPubkey = res.rPub
        else identityInvalid = true
      } catch {
        identityInvalid = true
      }
    }

    const result: ChatMessage = {
      id: raw.id,
      dTag: raw.dTag,
      pubkey: raw.pubkey,
      realPubkey,
      identityInvalid: identityInvalid || undefined,
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
      expiration: raw.expiration,
      facilitator: raw.facilitator,
      isForum: raw.isForum || !!title,  // derive from raw tag OR decrypted content
      title,
      featuredImage,
      forumTags,
      emojiTags,
      stickerTags,
      gifTags,
    }
    decryptCacheRef.current.set(raw.id, { sig, result })
    return result
  }, [getChannelKey, secretsVersion])

  // Bound the decrypt cache — drop it when the channel changes (message ids are globally unique, so a stale
  // entry is never wrong, but this keeps the map from growing unbounded across channel switches).
  useEffect(() => {
    decryptCacheRef.current.clear()
  }, [hubDTag, channelId])

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

  // IDs we've already run the durable-cache re-sweep over (see the effect below), so a re-sweep
  // never re-touches IndexedDB for the same message twice WITHIN one secrets generation. The set is
  // cleared whenever `secretsVersion` advances (a key just loaded), so every message is re-evaluated
  // exactly once per key-load — otherwise a message skipped for a not-yet-loaded key would be marked
  // swept and never persisted after its key arrives.
  const cacheSweptRef = useRef<Set<string>>(new Set())
  const cacheSweptVersionRef = useRef<number>(-1)

  // Decrypt raw messages whenever they change
  // NOTE: We intentionally do NOT include `hubs` in the dependency array.
  // The hubs object changes frequently during startup (metadata, members,
  // channels, etc.), and each change would cancel the in-flight async decrypt
  // via the `cancelled` flag — causing recently-injected messages to vanish.
  // minPow is read from a Zustand snapshot instead. The `decryptContent`
  // callback already reacts to key changes via `secretsVersion`.
  //
  // Reactive: re-run the filter when a facilitator's member list loads (lazily, below) so a
  // facilitated author's messages appear once their facilitator's tree is fetched. This changes
  // only on a facilitator-list load (rare) — unlike `hubs`, so it won't churn the async decrypt.
  const facilitatorMembersReactive = useHubStore((s) => (hubDTag ? s.hubFacilitatorMembers[hubDTag] : undefined))
  // Reactive so the filter re-runs when: the member list loads (else the lazy facilitator load is
  // skipped and never retried until a new message arrives → facilitated messages "sometimes don't
  // appear"); and when the "show facilitated messages" pref toggles (else the toggle does nothing).
  const hubMembersReactive = useHubStore((s) => (hubDTag ? s.hubMembers[hubDTag] : undefined))
  const showFacilitatedReactive = useHubStore((s) => (hubDTag ? s.hubPrefs[hubDTag]?.showFacilitatedMessages : undefined))
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
        const hubForPerms = hubDTag ? useHubStore.getState().hubs[hubDTag] : undefined
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

        // Lazily load the member list of any facilitator referenced by a message we can't yet
        // validate — so members (who never load facilitator trees themselves) can still show
        // facilitated messages. Only facilitators actually cited by a message, once each, in the
        // background; once loaded, `hubFacilitatorMembers` updates and this re-filters to show them.
        if (hubForPerms && members) {
          const refFac = new Set<string>()
          for (const m of decrypted) if (m.facilitator) refFac.add(m.facilitator)
          for (const fac of refFac) {
            const cacheKey = `${hubDTag}:${fac}`
            if (!isAuthorizedFacilitator(hubForPerms, fac, members)) continue // member (by P or R) with the permission
            if (facMembers?.[fac]) {
              // Already have a list (in memory or restored from localStorage) — messages show
              // immediately. Quietly revalidate once per session to pick up any add/remove.
              if (_facListRevalidated.has(cacheKey)) continue
              _facListRevalidated.add(cacheKey)
              loadFacListWithRetry(hubForPerms, fac, hubDTag!, cacheKey, true)
            } else {
              // No list yet — load it with backoff retries (a transient relay miss otherwise
              // hides this facilitator's vouched messages until restart).
              if (_facListLoadTriggered.has(cacheKey)) continue
              _facListLoadTriggered.add(cacheKey)
              loadFacListWithRetry(hubForPerms, fac, hubDTag!, cacheKey, false)
            }
          }
        }

        const visible = decrypted.filter((msg) => {
          // v2 drop rule stage 2: hide messages whose identity attestation failed
          // to verify (spoofed/tampered `identity` tag) — NIP-CHAT §0.1.
          if (msg.identityInvalid) return false
          // Author's real key: v2 resolves R from the identity tag; v1 uses the
          // wire pubkey. Membership/bans/own-message all key on the real key.
          const authorKey = msg.realPubkey ?? msg.pubkey
          // Always show own messages
          if (authorKey === pubkey) return true
          // Never show messages from banned users
          if (bannedPubkeys.has(authorKey)) return false
          // Members always shown
          if (memberPubkeys.size === 0 || memberPubkeys.has(authorKey)) return true
          // Facilitated messages — the facilitator must (a) be a member, (b) still hold the
          // `facilitate` permission (revoking the role/permission hides everyone they vouched),
          // and (c) actually have this author in their tree.
          if (msg.facilitator && hubForPerms) {
            // The facilitator must be a member who still holds `facilitate` (resolved by P OR R, since
            // the tag carries the on-wire key — P in v2, R in v1), AND the ON-WIRE author (msg.pubkey:
            // Pf in v2, R in v1) must be a leaf in their tree — exactly what the tree is keyed on.
            const facAuthorized = isAuthorizedFacilitator(hubForPerms, msg.facilitator, members)
            const isInFacTree = !!facMembers?.[msg.facilitator]?.includes(msg.pubkey)
            if (facAuthorized && isInFacTree) return showFacilitated
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
  }, [rawMessages, decryptContent, hubDTag, pubkey, facilitatorMembersReactive, hubMembersReactive, showFacilitatedReactive])

  // Durable-cache re-sweep for v2 (companion to the verify-before-cache gate).
  // The cache-admission gate (verifyMessageForCache) refuses to persist a v2 message whose channel key
  // isn't loaded yet — correct at ingest, but it means messages that arrived BEFORE the secret loaded
  // (notably history-paginated ones, which are only evaluated once) are never written to IndexedDB. When
  // the key later becomes available (secretsVersion bumps), re-run the gate over the current channel's raw
  // store messages and persist the ones that now verify. `cacheSweptRef` bounds this to one attempt per id
  // so it isn't hammering IndexedDB on every unrelated rawMessages change. v1/unknown hubs cache eagerly at
  // ingest and don't need this.
  useEffect(() => {
    if (!hubDTag || !channelId) return
    const hub = useHubStore.getState().hubs[hubDTag]
    if (!hub || !isV2(hub)) return
    // A key just loaded → forget prior verdicts and re-evaluate everything once. (A channel switch needs
    // no reset: the new channel's messages have ids not yet in the set, so they're evaluated anyway.)
    if (cacheSweptVersionRef.current !== secretsVersion) {
      cacheSweptRef.current.clear()
      cacheSweptVersionRef.current = secretsVersion
    }
    const pending = rawMessages.filter((m) => !cacheSweptRef.current.has(m.id))
    if (pending.length === 0) return
    let cancelled = false
    ;(async () => {
      const cacheable = await filterCacheable(pending)
      if (cancelled) return
      // Mark every message we examined (not just the cacheable ones) so an un-verifiable message isn't
      // re-checked forever; it re-enters the set only if the store hands us a fresh object for that id.
      for (const m of pending) cacheSweptRef.current.add(m.id)
      if (cacheable.length === 0) return
      const { cacheMessagesWithDedup } = await import('@/lib/cache/messageCache')
      cacheMessagesWithDedup(cacheable).catch(() => { /* non-fatal; re-fetched from relays otherwise */ })
    })()
    return () => { cancelled = true }
  }, [rawMessages, hubDTag, channelId, secretsVersion])

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

    // Determine if we should encrypt (default: yes if we have a key). Snapshot the epoch FIRST, then derive
    // the key FOR THAT epoch, so the key and the stamped epoch are consistent even if a rotation (kick/ban)
    // lands mid-send. Reading them separately (key now, epoch after the await) could encrypt with the old
    // key but stamp the new epoch → every reader derives the wrong key → on v2 the message is DROPPED.
    const shouldEncrypt = encrypted !== false
    const epoch = getChannelEpoch()
    const key = shouldEncrypt ? getChannelKey(epoch) : null

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
    // epoch was snapshotted above (before key derivation) so the key and stamp stay consistent

    // Extract mention tags from plaintext for relay-queryable p and M tags
    const { mentionPubkeys, mentionGroups } = extractMentionTags(text, hubDTag!)

    // Only a genuinely-facilitated (non-member) author tags a message with `facilitator`. Guard
    // against a stale `facilitator` pref leaking onto a member/creator's own posts (which would
    // wrongly show the "facilitated" pill). The roster keys members by real key R in BOTH versions,
    // so `pubkey (R) ∈ members` (or creator/owner) is the correct membership check for v1 and v2.
    let effectiveFacilitator = facilitator
    if (facilitator) {
      const members = useHubStore.getState().hubMembers[hubDTag!]
      const amMember = pubkey === hub.creatorPubkey || pubkey === hub.ownerRealPubkey
        || !!members?.some((m) => m.pubkey === pubkey)
      if (amMember) effectiveFacilitator = undefined
    }

    let unsigned = createMessageEvent(content, hubDTag, channelId, epoch, replyTo, undefined, rootRef, nsfw, isThread, effectiveFacilitator, !!forumFields, (isV2(hub) ? undefined : (mentionPubkeys.length > 0 ? mentionPubkeys : undefined)), mentionGroups.length > 0 ? mentionGroups : undefined)

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

    // Disappearing messages: stamp NIP-40 expiration BEFORE mining (the tag is
    // part of the id the PoW is mined over).
    stampHubExpiration(unsigned, hubDTag!)

    // Mine PoW + sign. v2 hubs author under the member pseudonym P with a
    // per-message identity attestation; v1 authors under the real key.
    if (minPow > 0) onPhase?.('mining')
    let signed: Event
    if (isV2(hub)) {
      if (!canUseV2({ privateKey, signer })) {
        throw new Error('This hub is private (v2) — use the DEN client or a NIP-SKD signer to post here.')
      }
      if (!key) throw new Error('v2 hub requires an encryption key (hub secret still loading)')
      // Author under P (real member) or Pf (facilitated non-member) — see myV2PostingSigner.
      const pSigner = await resolveV2PostingSigner(hub, pubkey!, privateKey, signer)
      const pPub = await pSigner.getPublicKey()
      // Author as P, then attach the per-message R attestation — BEFORE mining
      // (the digest excludes the identity + nonce tags, so it stays stable).
      unsigned = { ...unsigned, pubkey: pPub }
      const identityTag = await buildIdentityTag(unsigned, pubkey ?? '', signer, privateKey, key)
      unsigned = { ...unsigned, tags: [...unsigned.tags, identityTag] }
      signed = await mineAndSignAsSubkey(unsigned, minPow, pSigner)
    } else {
      signed = await mineAndSign(unsigned, minPow, pubkey, signer, privateKey)
    }

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
      facilitator: effectiveFacilitator,
      expiration: (() => { const e = signed.tags.find((t: string[]) => t[0] === 'expiration')?.[1]; return e ? (parseInt(e, 10) || undefined) : undefined })(),
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
      // On v2 the on-wire author is our pseudonym P; the real author is R (our own pubkey). Set realPubkey
      // now so the optimistic render resolves the same identity the echoed-back event will (parseMessage
      // recovers R from the attestation) — otherwise the avatar/name briefly shows P, then flips to R.
      realPubkey: isV2(hub) ? (pubkey ?? undefined) : undefined,
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
      facilitator: effectiveFacilitator,
      isForum: !!forumFields,
      title: forumFields?.title,
      featuredImage: forumFields?.featuredImage,
      forumTags: forumFields?.tags,
      expiration: ownMsg.expiration,
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
    const publishRelays = getPublishRelays(hubRelays, { hubOnly: !!hub && isV2(hub) })
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
          // All relays rejected — remove from local store AND the durable cache to avoid a phantom message.
          // ownMsg was written to IndexedDB before publishing (optimistic); without this delete it resurrects
          // as a "sent" message on the next reload even though no relay ever accepted it.
          useMessageStore.getState().removeMessage(hubDTag!, channelId!, ownMsg.dTag)
          selfDecryptedRef.current.delete(ownMsg.dTag)
          setDecryptedMessages((prev) => prev.filter((m) => !(m.dTag === ownMsg.dTag && m.pubkey === signed.pubkey)))
          import('@/lib/cache/messageCache').then(({ deleteCachedMessage }) => deleteCachedMessage(ownMsg.id).catch(() => {}))
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

    // Snapshot the epoch FIRST, derive the key for THAT epoch (see sendMessage): keeps the encryption key
    // and the stamped epoch consistent if a rotation lands mid-edit, else the edit is undecryptable/dropped.
    const editEpoch = getChannelEpoch()
    const key = getChannelKey(editEpoch)

    // Fail CLOSED on a missing key (mirror sendMessage's guard). On a v2 hub every channel is encrypted, so
    // a null key means the secret isn't loaded yet (e.g. mid-rotation) — NOT an unencrypted channel. Without
    // this, the edit body below stays plaintext (the `if (key)` at ~line 900 is skipped) and gets published
    // to the hub relays in the clear, AND signHubMemberEvent attaches no identity attestation (it needs the
    // channel key) so every reader drops the event: the plaintext leaks on-wire while the edit silently
    // vanishes for everyone. (v1 is left alone — its getChannelKey is legitimately null for public channels.)
    const hubForEdit = useHubStore.getState().hubs[hubDTag]
    if (!key && hubForEdit && isV2(hubForEdit)) {
      throw new Error('Encryption key not ready — hub secret is still loading')
    }

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
    const epoch = editEpoch // same snapshot the key was derived from (above)
    // v2: messages are stored + addressed by the member pseudonym P; edits key on it too.
    let authorKey = pubkey!
    if (hub && isV2(hub)) {
      authorKey = await (await resolveV2PostingSigner(hub, pubkey!, privateKey, signer)).getPublicKey()
    }
    // Re-publish with same d-tag — relay replaces the previous version
    // Extract mention tags from edited text for relay-queryable p and M tags
    const { mentionPubkeys, mentionGroups } = extractMentionTags(newText, hubDTag!)

    // Preserve nsfw + thread markers on edit — otherwise an edited thread-reply
    // loses its ['thread'] tag and re-renders as a normal reply in the main chat.
    // Also preserve the original `facilitator` tag: a facilitated author's edit must keep it, or the
    // edited message fails the facilitated-visibility check and is hidden for everyone.
    const origMsg = useMessageStore.getState().messages[hubDTag!]?.[channelId!]?.find((m) => m.dTag === dTag)
    const editFacilitator = origMsg?.facilitator
    let unsigned = createMessageEvent(content, hubDTag, channelId, epoch, replyToObj, dTag, rootRef, nsfw, isThread, editFacilitator, !!forumFields, (isV2(hub) ? undefined : (mentionPubkeys.length > 0 ? mentionPubkeys : undefined)), mentionGroups.length > 0 ? mentionGroups : undefined)

    // Carry forward published_at from the original message so the edited
    // version stays at its original position in the timeline for all clients.
    // Also set created_at to previous +1 so the relay accepts the replacement
    // but keeps the event in its original chronological bucket (prevents
    // edited old messages from stealing slots in limit-based fetches).
    const existingMessages = useMessageStore.getState().messages[hubDTag]?.[channelId] || []
    const originalMsg = existingMessages.find((m) => m.dTag === dTag && m.pubkey === authorKey)
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

      // Disappearing messages: preserve the ORIGINAL message's expiration so an
      // edit neither extends its life nor changes its policy (non-retroactive).
      // If the original had no expiration, editing must not introduce one.
      if (originalMsg.expiration) {
        unsigned = { ...unsigned, tags: [...unsigned.tags, ['expiration', originalMsg.expiration.toString()]] }
      }
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
    const signed = await (hub
      ? signHubMemberEvent({ hub, unsigned, pubkey: pubkey!, privateKey, signer, minPow, channelKey: key })
      : mineAndSign(unsigned, minPow, pubkey, signer, privateKey))
    const eventId = signed.id
    const hubRelays = useHubStore.getState().hubs[hubDTag!]?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays, { hubOnly: !!hub && isV2(hub) })

    // Optimistic local update — immediately reflect the edit in the UI
    // Uses the new event ID so RelayProgressIndicator can track publish progress
    const { setRelayProgress, clearRelayProgress, updateMessageContent } = useMessageStore.getState()
    updateMessageContent(
      hubDTag!, channelId!, dTag, authorKey,
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
      const existingDecrypted = prev.find((m) => m.dTag === dTag && m.pubkey === authorKey)
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
      return prev.map((m) => (m.dTag === dTag && m.pubkey === authorKey) ? selfEditedMsg : m)
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
    ;(hub ? signHubMemberEvent({ hub, unsigned: hintUnsigned, pubkey: pubkey!, privateKey, signer, minPow }) : mineAndSign(hintUnsigned, minPow, pubkey, signer, privateKey))
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

    // 1. Re-publish with same d-tag + deleted tag (primary — replaces original on relay)
    const hub = useHubStore.getState().hubs[hubDTag!]
    const epoch = getChannelEpoch()
    const key = getChannelKey()
    // v2: messages are stored + addressed by P; the tombstone + kind-5 must author as P too.
    let authorKey = pubkey!
    if (hub && isV2(hub)) {
      authorKey = await (await resolveV2PostingSigner(hub, pubkey!, privateKey, signer)).getPublicKey()
    }

    // Look up original message timestamp for created_at + 1 ordering
    const existingMessages = useMessageStore.getState().messages[hubDTag]?.[channelId] || []
    const originalMsg = existingMessages.find((m) => m.dTag === dTag && m.pubkey === authorKey)
    const originalCreatedAt = originalMsg?.eventCreatedAt || originalMsg?.createdAt

    const deletedEvent = createDeletedMessageEvent(dTag, hubDTag, channelId, epoch, originalCreatedAt)
    const signedDeleted = await (hub
      ? signHubMemberEvent({ hub, unsigned: deletedEvent, pubkey: pubkey!, privateKey, signer, channelKey: key })
      : signWithSigner(deletedEvent, signer, privateKey))
    const hubRelays = useHubStore.getState().hubs[hubDTag!]?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays, { hubOnly: !!hub && isV2(hub) })
    const deleteRelays = getDeletePublishRelays(hubRelays, { hubOnly: !!hub && isV2(hub) })
    await publishToSpecificRelays(deleteRelays, signedDeleted)

    // 2. NIP-09 deletion request as fallback (authored by P in v2 so relays honor it)
    const aRef = `${KINDS.MESSAGE}:${authorKey}:${dTag}`
    const deletionEvent = createDeletionEvent([], [aRef], 'User requested deletion')
    const signedDeletion = await (hub
      ? signHubMemberEvent({ hub, unsigned: deletionEvent, pubkey: pubkey!, privateKey, signer })
      : signWithSigner(deletionEvent, signer, privateKey))
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
    ;(hub ? signHubMemberEvent({ hub, unsigned: hintUnsigned, pubkey: pubkey!, privateKey, signer, minPow }) : mineAndSign(hintUnsigned, minPow, pubkey, signer, privateKey))
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
    const epoch = getChannelEpoch()

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

    // Disappearing messages: a reaction expires with the hub timer too.
    stampHubExpiration(unsigned, hubDTag!)

    const signed = await (hub
      ? signHubMemberEvent({ hub, unsigned, pubkey: pubkey!, privateKey, signer, channelKey: key })
      : signWithSigner(unsigned, signer, privateKey))
    const hubRelays = hub?.generalRelays || []
    const publishRelays = getPublishRelays(hubRelays, { hubOnly: !!hub && isV2(hub) })

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
    const publishRelays = getDeletePublishRelays(hubRelays, { hubOnly: !!hub && isV2(hub) })

    // Kind 5 deletion request for the reaction event (authored by P in v2)
    const deletionEvent = createDeletionEvent([reactionEventId], [], 'User removed reaction')
    const signedDeletion = await (hub
      ? signHubMemberEvent({ hub, unsigned: deletionEvent, pubkey: pubkey!, privateKey, signer })
      : signWithSigner(deletionEvent, signer, privateKey))
    await publishToSpecificRelays(publishRelays, signedDeletion)
  }, [hubDTag, channelId, signer, privateKey])

  return { messages: decryptedMessages, loading: false, sendMessage, editMessage, deleteMessage, publishReaction, unreactReaction, getChannelKey }
}
