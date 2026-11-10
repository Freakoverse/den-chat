/**
 * dmMdmStore — NIP-MDM (Masked Direct Messages) conversation store. See docs/NIP-MDM.md.
 *
 * Its own store (like the NIP-17 store), reusing dm04's message/reaction SHAPES so the MDM chat view can
 * render with the same components, but with MDM crypto inside: the sender authors under a per-recipient
 * masked key `M`, the recipient is addressed by their real key, and the sender recovers its own sent
 * history from a single **sent-contacts index** (docs §3.4), not per-message copies.
 *
 * Subscriptions (docs §3.2, §3.4):
 *   - received events     { kinds:[30092], "#p":[myRoot] }          messages, reactions and tombstones
 *   - sent-contacts index { kinds:[30092], authors:[C_from] }       my index (its payload = my recipients)
 *   - my sent threads      { kinds:[30092], authors:[M_1..M_k] }    rebuilt from the index's roots
 *
 * Relays (docs §5): real events → recipient relays + the sender's own relays + client defaults (reliability
 * first); the index → the sender's own relays + client (publishPersonal).
 */

import { create } from 'zustand'
import type { Event, Filter } from 'nostr-tools'
import { subscribeEventsWide } from '@/lib/nostr/readRelays'
import { getRelays, fetchEventsFromRelays } from '@/lib/nostr/relay-pool'
import { publishPersonal, usePostingBehaviourStore } from '@/stores/postingBehaviourStore'
import { dmSectionsStandard, publishDmSectioned, dmProgressTotal, dmProgressConfirmed, type DmRelayProgress } from '@/lib/nostr/dmRelayTargets'
import { discoverRecipientRelays } from '@/lib/nostr/relayDiscovery'
import { getExpirationFromTags } from '@/lib/hub/messageExpiration'
import { nowSeconds } from '@/lib/time/clockOffset'
import { useBlockStore } from '@/stores/blockStore'
import { useWotStore } from '@/stores/wotStore'
import { useFollowStore } from '@/stores/followStore'
import { useNotificationStore } from '@/stores/notificationStore'
import { playSoundEffect } from '@/lib/voice/soundEffects'
import type { ISigner } from '@/stores/userStore'
import type { Attachment } from '@/stores/messageStore'
import type { DM04Message, DM04Conversation, DM04Reaction } from '@/stores/dm04Store'
import {
  MDM_KIND,
  MDM_INDEX_CAP,
  mdmSupported,
  indexKeys,
  myMaskedPub,
  peerMaskedPub,
  buildMdmMessage,
  buildMdmReaction,
  buildSentContactsIndex,
  parseSentContactsIndex,
  decryptReceivedMdm,
  decryptOwnMdm,
  isTombstone,
  mdmCoordinate,
  type MdmKeys,
  type MdmBody,
  type MdmPayload,
} from '@/lib/nostr/nipMdm'

const MDM_LIMIT = 300
type Tuple4 = [string, string, string, string]

// ── module-level indices (not reactive) ──
const idToCoord = new Map<string, string>()   // real event id → "30092:<M>:<d>"
const coordToId = new Map<string, string>()   // coordinate → the real event id currently shown
const coordEventTime = new Map<string, number>() // coordinate → the event created_at of the shown version (edit newness)
const pendingReactions = new Map<string, { emoji: string; user: string; customUrl?: string }[]>() // coord → reactions whose target isn't loaded yet
const processedIds = new Set<string>()

// ── sent-contacts index state (docs §3.4), module-level (not reactive) ──
let indexRoots: string[] = []        // recipient roots, most-recent first
let indexD: string | null = null     // the index's addressable d (lowest, on the multi-device race)
let indexCreatedAt = 0               // highest created_at seen for the index

// ── per-conversation counterparty-relay fetch (docs §5): handlers + creds exposed from startSubscription,
//    so opening a chat can pull that partner's messages from the partner's OWN relays (once per session). ──
let _mdmReceived: ((e: Event) => Promise<void>) | null = null
let _mdmOwn: ((e: Event) => Promise<void>) | null = null
let _mdmKeys: MdmKeys | null = null
let _mdmMyPubkey: string | null = null
const _mdmCounterpartyFetched = new Set<string>()

/**
 * Clear every per-account cache. Called when the active account changes WITHOUT a page refresh (logout +
 * login, or a remote-signer account switch): otherwise the previous account's `conversations` stay in
 * memory keyed by THAT account's counterparties. In a two-account self-test the old counterparty is
 * literally the new account's own key, so opening that leftover thread and replying addresses the message
 * to yourself (`p` = self) and the conversation splits. A hard reset on the real change prevents it.
 */
function resetMdmAccountState(): void {
  idToCoord.clear()
  coordToId.clear()
  coordEventTime.clear()
  pendingReactions.clear()
  processedIds.clear()
  _mdmCounterpartyFetched.clear()
  indexRoots = []
  indexD = null
  indexCreatedAt = 0
}

const randomHex16 = () => {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

// Only real-time messages (received this session) play the DM sound; backfilled history never does.
const mdmSessionStartTime = nowSeconds()

// Per-conversation read marks live in the notification store (mdmUnreads, keyed on the counterparty's real
// key), so they persist locally AND sync across devices via the NIP-78 DM read-state event, exactly like
// NIP-04/17. Unread counts a message only if it is newer than that lastRead, so re-running the subscription
// never re-counts backfilled history.
const mdmLastRead = (counterparty: string) => useNotificationStore.getState().mdmUnreads[counterparty]?.lastRead ?? 0

interface ReactionEntry { users: Set<string>; customUrl?: string }

interface MdmState {
  conversations: Map<string, DM04Conversation>
  activeConversation: string | null
  pendingConversations: Set<string>
  loading: boolean
  loadingOlder: boolean
  /** MDM has no NIP-78 registry; present (empty) only so the shared chat UI can read it. */
  registryOnlyContacts: Set<string>
  reactions: Map<string, Map<string, ReactionEntry>>  // keyed by target real event id
  relayProgress: Record<string, DmRelayProgress>
  subscription: { close: () => void } | null

  setActiveConversation: (pubkey: string | null) => void
  addPendingConversation: (pubkey: string) => void
  removePendingConversation: (pubkey: string) => void
  startSubscription: (myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  stopSubscription: () => void
  sendMessage: (
    recipientPubkey: string, content: string, myPubkey: string, signer: ISigner | null, privateKey: string | null,
    replyTo?: string, rootRef?: string, isThread?: boolean,
    onPhase?: (phase: 'publishing', relayProgress?: { confirmed: number; total: number }) => void,
    emojiTags?: Tuple4[], stickerTags?: Tuple4[], gifTags?: Tuple4[], attachments?: Attachment[],
    expirationSeconds?: number,
  ) => Promise<void>
  deleteMessage: (eventId: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  addReaction: (
    targetEventId: string, targetPubkey: string, emoji: string, myPubkey: string, recipientPubkey: string,
    signer: ISigner | null, privateKey: string | null, customUrl?: string,
  ) => Promise<void>
  getReactions: (messageId: string, myPubkey: string) => DM04Reaction[]
  loadOlderMessages: (counterpartyPubkey?: string, myPubkey?: string, signer?: ISigner | null, privateKey?: string | null) => Promise<void>
  getFilteredConversations: (followList: Set<string>) => { following: DM04Conversation[]; other: DM04Conversation[] }
  setRelayProgress: (eventId: string, progress: DmRelayProgress) => void
  clearRelayProgress: (eventId: string) => void
}

const drop4 = (t?: Tuple4[]): [string, string, string?][] | undefined =>
  t && t.length ? t.map((x) => [x[0], x[1], x[2] || undefined] as [string, string, string?]) : undefined

/** Insert or replace a message in its conversation, keyed by addressable coordinate (edits replace). */
function upsertMessage(conversations: Map<string, DM04Conversation>, counterparty: string, real: Event, msg: DM04Message, active: string | null): void {
  const coord = mdmCoordinate(real)
  if (!coord) return
  // Edit newness is decided by the EVENT created_at (which drifts +1 per edit), not the displayed sort
  // time (published_at). An older/equal version is ignored.
  const prevTime = coordEventTime.get(coord)
  if (prevTime !== undefined && real.created_at <= prevTime) return
  coordEventTime.set(coord, real.created_at)

  const existing = conversations.get(counterparty)
  const conv: DM04Conversation = existing
    ? { ...existing, messages: [...existing.messages] }
    : { pubkey: counterparty, messages: [], lastMessageAt: 0, lastMessagePreview: '', unread: 0, oldestTimestamp: 0, hasMore: false }

  const prevId = coordToId.get(coord)
  const at = prevId ? conv.messages.findIndex((m) => m.id === prevId) : -1
  if (at >= 0) {
    if (prevId && prevId !== msg.id) idToCoord.delete(prevId)
    conv.messages[at] = msg
  } else {
    conv.messages.push(msg)
    if (!msg.isMine) {
      if (counterparty === active) {
        useNotificationStore.getState().markDmRead(counterparty, 'mdm')
      } else {
        const lastRead = mdmLastRead(counterparty)
        if (!(lastRead > 0 && msg.createdAt <= lastRead)) conv.unread += 1
      }
      if (msg.createdAt >= mdmSessionStartTime && useFollowStore.getState().followedPubkeys.has(counterparty)) {
        playSoundEffect('dm_message')
      }
    }
  }
  idToCoord.set(msg.id, coord)
  coordToId.set(coord, msg.id)

  conv.messages.sort((a, b) => a.createdAt - b.createdAt)
  const last = conv.messages[conv.messages.length - 1]
  conv.lastMessageAt = last.createdAt
  conv.lastMessagePreview = (last.deleted ? '' : last.content).slice(0, 120)
  conv.oldestTimestamp = conv.messages[0]?.createdAt ?? 0
  conversations.set(counterparty, conv)
}

export const useMdmStore = create<MdmState>((set, get) => ({
  conversations: new Map(),
  activeConversation: null,
  pendingConversations: new Set(),
  loading: false,
  loadingOlder: false,
  registryOnlyContacts: new Set(),
  reactions: new Map(),
  relayProgress: {},
  subscription: null,

  setActiveConversation: (pubkey) => {
    if (pubkey) useNotificationStore.getState().markDmRead(pubkey, 'mdm')
    set((s) => {
      if (pubkey && s.conversations.has(pubkey)) {
        const conversations = new Map(s.conversations)
        const conv = conversations.get(pubkey)!
        if (conv.unread > 0) conversations.set(pubkey, { ...conv, unread: 0 })
        return { activeConversation: pubkey, conversations }
      }
      return { activeConversation: pubkey }
    })
    // On open, also pull this partner's masked messages from THEIR own relays (docs §5), gated by the
    // "Fetch from recipient relays" Behaviour toggle, once per contact per session.
    if (pubkey && usePostingBehaviourStore.getState().fetchFromRecipientRelays && !_mdmCounterpartyFetched.has(pubkey)) {
      _mdmCounterpartyFetched.add(pubkey)
      fetchCounterpartyRelaysMdm(pubkey).catch(() => {})
    }
  },
  addPendingConversation: (pubkey) => set((s) => ({ pendingConversations: new Set(s.pendingConversations).add(pubkey) })),
  removePendingConversation: (pubkey) => set((s) => { const n = new Set(s.pendingConversations); n.delete(pubkey); return { pendingConversations: n } }),

  startSubscription: async (myPubkey, signer, privateKey) => {
    const keys: MdmKeys = { privateKey, signer }
    if (!mdmSupported(keys)) { set({ loading: false }); return }
    // Account switched without a page refresh: wipe the previous account's conversations + caches so a reply
    // in a leftover thread can't be addressed to the wrong recipient (see resetMdmAccountState). Same-account
    // restarts (relay-list reload, tab visibility) keep their state — `_mdmMyPubkey` is unchanged there.
    if (_mdmMyPubkey && _mdmMyPubkey !== myPubkey) {
      resetMdmAccountState()
      set({
        conversations: new Map(),
        activeConversation: null,
        pendingConversations: new Set(),
        reactions: new Map(),
        relayProgress: {},
        registryOnlyContacts: new Set(),
      })
    }
    get().subscription?.close()
    set({ loading: true })

    let cFrom: string
    try { ({ from: cFrom } = await indexKeys(keys)) }
    catch { set({ loading: false }); return }

    const applyReaction = (targetId: string, emoji: string, user: string, customUrl?: string) => set((s) => {
      const reactions = new Map(s.reactions)
      const byEmoji = new Map(reactions.get(targetId) ?? [])
      const entry: ReactionEntry = { users: new Set(byEmoji.get(emoji)?.users ?? []), customUrl: byEmoji.get(emoji)?.customUrl ?? customUrl }
      entry.users.add(user)
      byEmoji.set(emoji, entry)
      reactions.set(targetId, byEmoji)
      return { reactions }
    })

    const pushPending = (coord: string, emoji: string, user: string, customUrl?: string) => {
      const list = pendingReactions.get(coord) ?? []
      list.push({ emoji, user, customUrl })
      pendingReactions.set(coord, list)
    }
    const routeReaction = (ref: MdmPayload['reaction'], user: string) => {
      if (!ref) return
      const targetId = coordToId.get(ref.target)
      if (targetId) applyReaction(targetId, ref.emoji, user, ref.customUrl)
      else pushPending(ref.target, ref.emoji, user, ref.customUrl)
    }

    const commitMessage = (counterparty: string, real: Event, msg: DM04Message) => set((s) => {
      const conversations = new Map(s.conversations)
      upsertMessage(conversations, counterparty, real, msg, s.activeConversation)
      return { conversations }
    })

    const drainPending = (real: Event) => {
      const coord = mdmCoordinate(real)
      const id = coord ? coordToId.get(coord) : undefined
      const list = coord ? pendingReactions.get(coord) : undefined
      if (coord && id && list) { pendingReactions.delete(coord); for (const r of list) applyReaction(id, r.emoji, r.user, r.customUrl) }
    }

    // A decrypted payload for a KNOWN counterparty (received = sender; own = recipient). Routes to a
    // message/tombstone or a reaction.
    const applyPayload = (counterparty: string, real: Event, payload: MdmPayload, isMine: boolean, verified: boolean, reactionUser: string) => {
      if (payload.reaction) { routeReaction(payload.reaction, reactionUser); return }
      commitMessage(counterparty, real, toMessage(real, payload, counterparty, myPubkey, isMine, verified))
      drainPending(real)
    }

    const onReceived = async (event: Event) => {
      if (processedIds.has(event.id)) return
      processedIds.add(event.id)
      const dec = await decryptReceivedMdm(event, keys)
      if (!dec) return
      const counterparty = dec.senderRootPub
      if (useBlockStore.getState().blockedPubkeys.has(counterparty)) return
      // A received reaction must be verified before it is attributed (docs §6).
      if (dec.payload.reaction && !dec.verified) return
      applyPayload(counterparty, event, dec.payload, false, dec.verified, counterparty)
    }

    // Decrypt + route one of MY OWN sent events (I am `M`), for the own-threads sub and the counterparty fetch.
    const onOwn = async (event: Event) => {
      if (processedIds.has(event.id)) return
      processedIds.add(event.id)
      const recipient = event.tags.find((t) => t[0] === 'p')?.[1]
      if (!recipient) return
      const payload = await decryptOwnMdm(event, keys)
      if (!payload) return
      applyPayload(recipient, event, payload, true, true, myPubkey)
    }

    // ── my own sent threads, rebuilt from the index's roots (docs §3.4) ──
    const subscribedRoots = new Set<string>()
    let ownSub: { close: () => void } | null = null
    const refreshOwnThreads = async () => {
      const fresh = indexRoots.filter((r) => !subscribedRoots.has(r))
      if (!fresh.length) return
      fresh.forEach((r) => subscribedRoots.add(r))
      const masked = (await Promise.all([...subscribedRoots].map((r) => myMaskedPub(r, keys).catch(() => null)))).filter(Boolean) as string[]
      if (!masked.length) return
      ownSub?.close()
      ownSub = subscribeEventsWide({ kinds: [MDM_KIND], authors: masked, limit: MDM_LIMIT } as Filter, onOwn)
    }

    const onIndex = async (event: Event) => {
      if (event.pubkey !== cFrom) return
      const roots = await parseSentContactsIndex(event, keys)
      if (!roots) return
      const d = event.tags.find((t) => t[0] === 'd')?.[1]
      // Multi-device race (docs §3.4): union lists, converge to the lowest d.
      indexRoots = [...new Set([...roots, ...indexRoots])].slice(0, MDM_INDEX_CAP)
      if (d && (indexD === null || d < indexD)) indexD = d
      indexCreatedAt = Math.max(indexCreatedAt, event.created_at)
      await refreshOwnThreads()
    }

    // Expose the handlers + creds so opening a conversation can pull from the counterparty's own relays.
    _mdmReceived = onReceived; _mdmOwn = onOwn; _mdmKeys = keys; _mdmMyPubkey = myPubkey
    _mdmCounterpartyFetched.clear()

    const subReceived = subscribeEventsWide({ kinds: [MDM_KIND], '#p': [myPubkey], limit: MDM_LIMIT } as Filter, onReceived)
    const subIndex = subscribeEventsWide({ kinds: [MDM_KIND], authors: [cFrom], limit: 8 } as Filter, onIndex)
    set({ subscription: { close: () => { subReceived.close(); subIndex.close(); ownSub?.close() } }, loading: false })
  },

  stopSubscription: () => { get().subscription?.close(); set({ subscription: null }) },

  sendMessage: async (recipientPubkey, content, myPubkey, signer, privateKey, replyTo, rootRef, isThread, onPhase, emojiTags, stickerTags, gifTags, attachments, expirationSeconds) => {
    const keys: MdmKeys = { privateKey, signer }
    if (!mdmSupported(keys)) throw new Error('Masked DMs need a local key or a signer with NIP-SKD support.')
    const body: MdmBody = {
      text: content || undefined,
      reply: replyTo ? idToCoord.get(replyTo) : undefined,
      rootRef: rootRef ? idToCoord.get(rootRef) : undefined,
      isThread: isThread || undefined,
      emoji: drop4(emojiTags),
      sticker: drop4(stickerTags),
      gif: drop4(gifTags) as [string, string, string][] | undefined,
      attachments: attachments && attachments.length ? attachments : undefined,
    }
    const { real } = await buildMdmMessage({ recipientRootPub: recipientPubkey, myRootPub: myPubkey, body, keys, expirationSeconds })

    const payload: MdmPayload = { v: 1, from: myPubkey, published_at: real.created_at, ...body }
    set((s) => { const conversations = new Map(s.conversations); upsertMessage(conversations, recipientPubkey, real, toMessage(real, payload, recipientPubkey, myPubkey, true, true), s.activeConversation); return { conversations } })

    onPhase?.('publishing')
    await Promise.all([
      publishReal(recipientPubkey, real, (p) => { get().setRelayProgress(real.id, p); onPhase?.('publishing', { confirmed: dmProgressConfirmed(p), total: dmProgressTotal(p) }) }),
      noteSentTo(recipientPubkey, keys),
    ]).finally(() => setTimeout(() => get().clearRelayProgress(real.id), 4000))
  },

  deleteMessage: async (eventId, myPubkey, signer, privateKey) => {
    const keys: MdmKeys = { privateKey, signer }
    const coord = idToCoord.get(eventId)
    if (!coord) return
    const d = coord.split(':')[2]
    // Recover the recipient, the original d, created_at and published_at from the shown message.
    let recipient: string | undefined
    let createdAt = 0
    let publishedAt = 0
    for (const [cp, conv] of get().conversations) {
      const m = conv.messages.find((x) => x.id === eventId)
      if (m) { recipient = cp; publishedAt = m.createdAt; createdAt = coordEventTime.get(coord) ?? m.createdAt; break }
    }
    if (!recipient || !d) return
    // Tombstone = an edit with an empty body (docs §2.2, §6).
    const { real } = await buildMdmMessage({
      recipientRootPub: recipient, myRootPub: myPubkey, body: {}, keys,
      d, createdAt: createdAt + 1, publishedAt, updatedAt: nowSeconds(),
    })
    set((s) => {
      const conversations = new Map(s.conversations)
      const conv = conversations.get(recipient!)
      if (conv) {
        const msgs = conv.messages.map((m) => m.id === eventId ? { ...m, deleted: true, content: '' } : m)
        conversations.set(recipient!, { ...conv, messages: msgs })
      }
      return { conversations }
    })
    await publishReal(recipient, real).catch(() => {})
  },

  addReaction: async (targetEventId, _targetPubkey, emoji, myPubkey, recipientPubkey, signer, privateKey, customUrl) => {
    const keys: MdmKeys = { privateKey, signer }
    const coord = idToCoord.get(targetEventId)
    if (!coord) return
    set((s) => {
      const reactions = new Map(s.reactions)
      const byEmoji = new Map(reactions.get(targetEventId) ?? [])
      const entry: ReactionEntry = { users: new Set(byEmoji.get(emoji)?.users ?? []), customUrl: byEmoji.get(emoji)?.customUrl ?? customUrl }
      entry.users.add(myPubkey); byEmoji.set(emoji, entry); reactions.set(targetEventId, byEmoji)
      return { reactions }
    })
    const { real } = await buildMdmReaction({ targetCoordinate: coord, recipientRootPub: recipientPubkey, myRootPub: myPubkey, emoji, customUrl, keys })
    await publishReal(recipientPubkey, real).catch(() => {})
  },

  loadOlderMessages: async () => { /* MDM loads up to MDM_LIMIT at once; no pagination in v1 (hasMore=false) */ },

  getReactions: (messageId, myPubkey) => {
    const byEmoji = get().reactions.get(messageId)
    if (!byEmoji) return []
    const out: DM04Reaction[] = []
    for (const [emoji, entry] of byEmoji) out.push({ emoji, count: entry.users.size, reacted: entry.users.has(myPubkey), customUrl: entry.customUrl })
    return out
  },

  getFilteredConversations: (followList) => {
    const { conversations, pendingConversations } = get()
    const blocked = useBlockStore.getState().blockedPubkeys
    const following: DM04Conversation[] = []
    const other: DM04Conversation[] = []
    for (const [pubkey, conv] of conversations) {
      if (blocked.has(pubkey) || useWotStore.getState().shouldHide(pubkey, 'dms')) continue
      ;(followList.has(pubkey) ? following : other).push(conv)
    }
    for (const pk of pendingConversations) {
      if (blocked.has(pk) || conversations.has(pk)) continue
      const empty: DM04Conversation = { pubkey: pk, messages: [], lastMessageAt: nowSeconds(), lastMessagePreview: '', unread: 0, oldestTimestamp: nowSeconds(), hasMore: false }
      ;(followList.has(pk) ? following : other).push(empty)
    }
    const sortFn = (a: DM04Conversation, b: DM04Conversation) => b.lastMessageAt - a.lastMessageAt
    following.sort(sortFn); other.sort(sortFn)
    return { following, other }
  },

  setRelayProgress: (eventId, progress) => set((s) => ({ relayProgress: { ...s.relayProgress, [eventId]: progress } })),
  clearRelayProgress: (eventId) => set((s) => { const { [eventId]: _, ...rest } = s.relayProgress; return { relayProgress: rest } }),
}))

/**
 * Publish a real masked event (message, reaction or tombstone) to one unified relay set (docs §5,
 * reliability first): the sender's NIP-65 relays, the recipient's discovered relays, and the client
 * defaults, each a labelled section (dmSectionsStandard) that honours its Settings > Network toggle. One
 * failover over their union reports accepted relays into the shared DmRelayProgress shape, so the UI
 * counter reflects EVERY relay (not just the recipient leg).
 */
async function publishReal(recipientPubkey: string, real: Event, onProgress?: (p: DmRelayProgress) => void): Promise<void> {
  const recipientRelays = usePostingBehaviourStore.getState().postToRecipientRelays
    ? await discoverRecipientRelays(recipientPubkey, getRelays()).catch(() => [] as string[])
    : []
  const sections = dmSectionsStandard(recipientRelays)
  onProgress?.({ sections, acceptedRelays: [], settled: false })
  const accepted = await publishDmSectioned(real, sections, (acc) => onProgress?.({ sections, acceptedRelays: acc, settled: false }))
  onProgress?.({ sections, acceptedRelays: accepted, settled: true })
}

/**
 * Pull a conversation's masked messages from the COUNTERPARTY'S OWN relays on open (docs §5): a one-shot
 * fetch (no subscription, both directions) from the partner's advertised relays, deduped by the normal
 * handlers. Gated by the "Fetch from recipient relays" Behaviour toggle; run once per contact per session.
 */
async function fetchCounterpartyRelaysMdm(counterpartyRoot: string): Promise<void> {
  const keys = _mdmKeys, myPubkey = _mdmMyPubkey, onReceived = _mdmReceived, onOwn = _mdmOwn
  if (!keys || !myPubkey || !onReceived || !onOwn) return
  try {
    const relays = await discoverRecipientRelays(counterpartyRoot, getRelays()).catch(() => [] as string[])
    if (!relays.length) return
    const [theirM, myM] = await Promise.all([
      peerMaskedPub(counterpartyRoot, keys).catch(() => null),   // messages they sent me
      myMaskedPub(counterpartyRoot, keys).catch(() => null),     // messages I sent them
    ])
    const filters: Filter[] = []
    if (theirM) filters.push({ kinds: [MDM_KIND], authors: [theirM], '#p': [myPubkey], limit: MDM_LIMIT })
    if (myM) filters.push({ kinds: [MDM_KIND], authors: [myM], '#p': [counterpartyRoot], limit: MDM_LIMIT })
    if (!filters.length) return
    const events = await fetchEventsFromRelays(relays, filters)
    for (const ev of events) {
      if (theirM && ev.pubkey === theirM) await onReceived(ev)
      else if (myM && ev.pubkey === myM) await onOwn(ev)
    }
  } catch { /* best-effort */ }
}

/**
 * Record that the sender messaged `root`: move it to the front of the sent-contacts index and, when the SET
 * of contacts changed (a new contact), republish the index (docs §3.4). A repeat to an existing contact
 * only reorders in memory (debounced), so it puts no index event on the wire.
 */
async function noteSentTo(root: string, keys: MdmKeys): Promise<void> {
  const was = indexRoots.indexOf(root)
  if (was === 0) return
  indexRoots = [root, ...indexRoots.filter((r) => r !== root)].slice(0, MDM_INDEX_CAP)
  if (was !== -1) return // reorder-only: debounced, rides the next set-change republish
  if (!indexD) indexD = randomHex16()
  indexCreatedAt = indexCreatedAt > 0 ? indexCreatedAt + 1 : nowSeconds()
  try {
    const ev = await buildSentContactsIndex({ roots: indexRoots, keys, d: indexD, createdAt: indexCreatedAt })
    await publishPersonal(ev)
  } catch { /* index republish is best-effort; a later send retries */ }
}

/** Build a DM04Message-shaped record from a decrypted MDM payload. Ordering uses published_at (docs §2.2). */
function toMessage(
  real: Event,
  payload: MdmPayload,
  counterparty: string,
  myPubkey: string,
  isMine: boolean,
  verified: boolean,
): DM04Message & { verified?: boolean } {
  const tomb = isTombstone(payload)
  return {
    id: real.id,
    content: tomb ? '' : (payload.text ?? ''),
    senderPubkey: isMine ? myPubkey : counterparty,
    recipientPubkey: isMine ? counterparty : myPubkey,
    createdAt: payload.published_at || real.created_at,
    isMine,
    expiration: getExpirationFromTags(real.tags),
    deleted: tomb || undefined,
    replyTo: payload.reply ? coordToId.get(payload.reply) : undefined,
    rootRef: payload.rootRef ? coordToId.get(payload.rootRef) : undefined,
    isThread: payload.isThread,
    emojiTags: payload.emoji,
    stickerTags: payload.sticker,
    gifTags: payload.gif,
    attachments: tomb ? undefined : payload.attachments,
    rawEvent: JSON.stringify(real),
    decryptedRaw: tomb ? undefined : JSON.stringify(payload, null, 2),
    verified,
  }
}
