/**
 * dmMdmStore — NIP-MDM (Masked Direct Messages) conversation store. See docs/NIP-MDM.md.
 *
 * Its own store (like the NIP-17 store), reusing dm04's message/reaction SHAPES so the MDM chat view can
 * render with the same components, but with MDM crypto inside: the sender authors under a per-recipient
 * masked key `M`, the recipient is addressed by their real key, and every message/reaction also publishes
 * a self-copy to the sender's own relays so the sender recovers them (docs §3.4). Three subscriptions on
 * the user's read relays:
 *   - received messages   { kinds:[30092], "#p":[myRoot] }
 *   - my self-copies      { kinds:[30092], authors:[C_from], "#p":[C_to] }   (messages + reactions)
 *   - received reactions  { kinds:[7],     "#p":[myRoot] }
 *
 * Relay split (docs §5): real events → recipient relays + client defaults (NEVER the sender's own NIP-65);
 * self-copies → sender's own relays + client (publishPersonal; NEVER the recipient's).
 */

import { create } from 'zustand'
import type { Event, Filter } from 'nostr-tools'
import { subscribeEventsWide } from '@/lib/nostr/readRelays'
import { publishWithFailover, getRelays } from '@/lib/nostr/relay-pool'
import { publishPersonal } from '@/stores/postingBehaviourStore'
import { discoverRecipientRelays } from '@/lib/nostr/relayDiscovery'
import { nowSeconds } from '@/lib/time/clockOffset'
import { useBlockStore } from '@/stores/blockStore'
import { useWotStore } from '@/stores/wotStore'
import type { ISigner } from '@/stores/userStore'
import type { DM04Message, DM04Conversation, DM04Reaction } from '@/stores/dm04Store'
import {
  MDM_KIND,
  MDM_REACTION_KIND,
  mdmSupported,
  selfCopyKeys,
  buildMdmMessage,
  buildMdmReaction,
  decryptReceivedMdm,
  decryptSelfCopy,
  decryptOwnMdm,
  decryptReceivedReaction,
  decryptOwnReaction,
  mdmCoordinate,
  type MdmKeys,
  type MdmBody,
} from '@/lib/nostr/nipMdm'

const MDM_LIMIT = 300
const norm = (u: string) => u.replace(/\/+$/, '')
type Tuple4 = [string, string, string, string]

// ── module-level indices (not reactive) ──
const idToCoord = new Map<string, string>()   // real event id → "30092:<M>:<d>"
const coordToId = new Map<string, string>()   // coordinate → the real event id currently shown
const pendingReactions = new Map<string, { emoji: string; user: string; customUrl?: string }[]>() // coord → reactions whose target isn't loaded yet
const processedIds = new Set<string>()
const processedReactionIds = new Set<string>()

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
  relayProgress: Record<string, { confirmed: number; total: number; acceptedRelays: string[] }>
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
    emojiTags?: Tuple4[], stickerTags?: Tuple4[], gifTags?: Tuple4[],
  ) => Promise<void>
  deleteMessage: (eventId: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  addReaction: (
    targetEventId: string, targetPubkey: string, emoji: string, myPubkey: string, recipientPubkey: string,
    signer: ISigner | null, privateKey: string | null, customUrl?: string,
  ) => Promise<void>
  getReactions: (messageId: string, myPubkey: string) => DM04Reaction[]
  loadOlderMessages: (counterpartyPubkey?: string, myPubkey?: string, signer?: ISigner | null, privateKey?: string | null) => Promise<void>
  getFilteredConversations: (followList: Set<string>) => { following: DM04Conversation[]; other: DM04Conversation[] }
  setRelayProgress: (eventId: string, confirmed: number, total: number, acceptedRelays?: string[]) => void
  clearRelayProgress: (eventId: string) => void
}

const drop4 = (t?: Tuple4[]): [string, string, string?][] | undefined =>
  t && t.length ? t.map((x) => [x[0], x[1], x[2] || undefined] as [string, string, string?]) : undefined

/** Insert or replace a message in its conversation, keyed by addressable coordinate (edits replace). */
function upsertMessage(conversations: Map<string, DM04Conversation>, counterparty: string, real: Event, msg: DM04Message, active: string | null): void {
  const coord = mdmCoordinate(real)
  if (!coord) return
  const existing = conversations.get(counterparty)
  const conv: DM04Conversation = existing
    ? { ...existing, messages: [...existing.messages] }
    : { pubkey: counterparty, messages: [], lastMessageAt: 0, lastMessagePreview: '', unread: 0, oldestTimestamp: 0, hasMore: false }

  const prevId = coordToId.get(coord)
  const at = prevId ? conv.messages.findIndex((m) => m.id === prevId) : -1
  if (at >= 0) {
    if (conv.messages[at].createdAt > msg.createdAt) { conversations.set(counterparty, conv); return }
    if (prevId && prevId !== msg.id) idToCoord.delete(prevId)
    conv.messages[at] = msg
  } else {
    conv.messages.push(msg)
    if (!msg.isMine && counterparty !== active) conv.unread += 1
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

  setActiveConversation: (pubkey) => set((s) => {
    if (pubkey && s.conversations.has(pubkey)) {
      const conversations = new Map(s.conversations)
      const conv = conversations.get(pubkey)!
      if (conv.unread > 0) conversations.set(pubkey, { ...conv, unread: 0 })
      return { activeConversation: pubkey, conversations }
    }
    return { activeConversation: pubkey }
  }),
  addPendingConversation: (pubkey) => set((s) => ({ pendingConversations: new Set(s.pendingConversations).add(pubkey) })),
  removePendingConversation: (pubkey) => set((s) => { const n = new Set(s.pendingConversations); n.delete(pubkey); return { pendingConversations: n } }),

  startSubscription: async (myPubkey, signer, privateKey) => {
    const keys: MdmKeys = { privateKey, signer }
    if (!mdmSupported(keys)) { set({ loading: false }); return }
    get().subscription?.close()
    set({ loading: true })

    let cFrom: string, cTo: string
    try { ({ from: cFrom, to: cTo } = await selfCopyKeys(keys)) }
    catch { set({ loading: false }); return }

    // Apply reactions (merge) helper that also drains pendingReactions reconciled by upsert.
    const applyReaction = (targetId: string, emoji: string, user: string, customUrl?: string) => set((s) => {
      const reactions = new Map(s.reactions)
      const byEmoji = new Map(reactions.get(targetId) ?? [])
      const entry: ReactionEntry = { users: new Set(byEmoji.get(emoji)?.users ?? []), customUrl: byEmoji.get(emoji)?.customUrl ?? customUrl }
      entry.users.add(user)
      byEmoji.set(emoji, entry)
      reactions.set(targetId, byEmoji)
      return { reactions }
    })

    const commitMessage = (counterparty: string, real: Event, msg: DM04Message) => set((s) => {
      const conversations = new Map(s.conversations)
      upsertMessage(conversations, counterparty, real, msg, s.activeConversation)
      return { conversations }
    })

    const onReceivedMessage = async (event: Event) => {
      if (processedIds.has(event.id)) return
      processedIds.add(event.id)
      const dec = await decryptReceivedMdm(event, keys)
      if (!dec) return
      const counterparty = dec.senderRootPub
      if (useBlockStore.getState().blockedPubkeys.has(counterparty)) return
      commitMessage(counterparty, event, toMessage(event, dec.payload, counterparty, myPubkey, false, dec.verified))
      drainPending(event)
    }

    const onMyCopy = async (event: Event) => {
      if (event.pubkey !== cFrom || processedIds.has(event.id)) return
      processedIds.add(event.id)
      const embedded = await decryptSelfCopy(event, keys)
      if (!embedded) return
      if (embedded.kind === MDM_KIND) {
        const recipient = embedded.tags.find((t) => t[0] === 'p')?.[1]
        if (!recipient) return
        const payload = await decryptOwnMdm(embedded, keys)
        if (!payload) return
        commitMessage(recipient, embedded, toMessage(embedded, payload, recipient, myPubkey, true, true))
        drainPending(embedded)
      } else if (embedded.kind === MDM_REACTION_KIND) {
        const payload = await decryptOwnReaction(embedded, keys)
        const coord = embedded.tags.find((t) => t[0] === 'a')?.[1]
        if (!payload || !coord) return
        const targetId = coordToId.get(coord)
        if (targetId) applyReaction(targetId, payload.emoji, myPubkey, payload.customUrl)
        else pushPending(coord, payload.emoji, myPubkey, payload.customUrl)
      }
    }

    const onReceivedReaction = async (event: Event) => {
      if (processedReactionIds.has(event.id)) return
      processedReactionIds.add(event.id)
      const dec = await decryptReceivedReaction(event, keys)
      if (!dec || !dec.verified || !dec.targetCoordinate) return
      if (useBlockStore.getState().blockedPubkeys.has(dec.senderRootPub)) return
      const targetId = coordToId.get(dec.targetCoordinate)
      if (targetId) applyReaction(targetId, dec.payload.emoji, dec.senderRootPub, dec.payload.customUrl)
      else pushPending(dec.targetCoordinate, dec.payload.emoji, dec.senderRootPub, dec.payload.customUrl)
    }

    const pushPending = (coord: string, emoji: string, user: string, customUrl?: string) => {
      const list = pendingReactions.get(coord) ?? []
      list.push({ emoji, user, customUrl })
      pendingReactions.set(coord, list)
    }
    const drainPending = (real: Event) => {
      const coord = mdmCoordinate(real)
      const id = coord ? coordToId.get(coord) : undefined
      const list = coord ? pendingReactions.get(coord) : undefined
      if (coord && id && list) { pendingReactions.delete(coord); for (const r of list) applyReaction(id, r.emoji, r.user, r.customUrl) }
    }

    const subMsg = subscribeEventsWide({ kinds: [MDM_KIND], '#p': [myPubkey], limit: MDM_LIMIT } as Filter, onReceivedMessage)
    const subMine = subscribeEventsWide({ kinds: [MDM_KIND], authors: [cFrom], '#p': [cTo], limit: MDM_LIMIT } as Filter, onMyCopy)
    const subReact = subscribeEventsWide({ kinds: [MDM_REACTION_KIND], '#p': [myPubkey], limit: MDM_LIMIT } as Filter, onReceivedReaction)
    set({ subscription: { close: () => { subMsg.close(); subMine.close(); subReact.close() } }, loading: false })
  },

  stopSubscription: () => { get().subscription?.close(); set({ subscription: null }) },

  sendMessage: async (recipientPubkey, content, myPubkey, signer, privateKey, replyTo, rootRef, isThread, onPhase, emojiTags, stickerTags, gifTags) => {
    const keys: MdmKeys = { privateKey, signer }
    if (!mdmSupported(keys)) throw new Error('Masked DMs need a local key or a NIP-SKD signer.')
    const body: MdmBody = {
      t: content || undefined,
      reply: replyTo ? idToCoord.get(replyTo) : undefined,
      rootRef: rootRef ? idToCoord.get(rootRef) : undefined,
      isThread: isThread || undefined,
      emoji: drop4(emojiTags),
      sticker: drop4(stickerTags),
      gif: drop4(gifTags) as [string, string, string][] | undefined,
    }
    const { real, selfCopy } = await buildMdmMessage({ recipientRootPub: recipientPubkey, myRootPub: myPubkey, body, keys })

    const payload = { v: 1 as const, from: myPubkey, ...body }
    set((s) => { const conversations = new Map(s.conversations); upsertMessage(conversations, recipientPubkey, real, toMessage(real, payload, recipientPubkey, myPubkey, true, true), s.activeConversation); return { conversations } })

    onPhase?.('publishing')
    const recipientRelays = await discoverRecipientRelays(recipientPubkey, getRelays()).catch(() => [] as string[])
    const realPool = [...recipientRelays, ...getRelays()]
    const realSeed = recipientRelays.length > 0 ? recipientRelays : getRelays()
    const target = Math.min(new Set(realPool.map(norm)).size || 1, 4)
    try {
      await Promise.all([
        publishWithFailover(real, realSeed, { pool: realPool, target, onProgress: (c, t, accepted) => { get().setRelayProgress(real.id, c, t, accepted); onPhase?.('publishing', { confirmed: c, total: t }) } }),
        publishPersonal(selfCopy),
      ])
    } finally {
      setTimeout(() => get().clearRelayProgress(real.id), 4000)
    }
  },

  deleteMessage: async (eventId, myPubkey, signer, privateKey) => {
    const keys: MdmKeys = { privateKey, signer }
    const coord = idToCoord.get(eventId)
    if (!coord) return
    const d = coord.split(':')[2]
    // Find the message + its conversation to recover the recipient and original created_at.
    let recipient: string | undefined
    let createdAt = 0
    for (const [cp, conv] of get().conversations) {
      const m = conv.messages.find((x) => x.id === eventId)
      if (m) { recipient = cp; createdAt = m.createdAt; break }
    }
    if (!recipient || !d) return
    const { real, selfCopy } = await buildMdmMessage({ recipientRootPub: recipient, myRootPub: myPubkey, body: { deleted: true }, keys, d, createdAt: createdAt + 1 })
    // Local tombstone.
    set((s) => {
      const conversations = new Map(s.conversations)
      const conv = conversations.get(recipient!)
      if (conv) {
        const msgs = conv.messages.map((m) => m.id === eventId ? { ...m, deleted: true, content: '' } : m)
        conversations.set(recipient!, { ...conv, messages: msgs })
      }
      return { conversations }
    })
    const recipientRelays = await discoverRecipientRelays(recipient, getRelays()).catch(() => [] as string[])
    await Promise.all([
      publishWithFailover(real, recipientRelays.length ? recipientRelays : getRelays(), { pool: [...recipientRelays, ...getRelays()], target: 2 }),
      publishPersonal(selfCopy),
    ]).catch(() => {})
  },

  addReaction: async (targetEventId, _targetPubkey, emoji, myPubkey, recipientPubkey, signer, privateKey, customUrl) => {
    const keys: MdmKeys = { privateKey, signer }
    const coord = idToCoord.get(targetEventId)
    if (!coord) return
    // Optimistic local echo.
    set((s) => {
      const reactions = new Map(s.reactions)
      const byEmoji = new Map(reactions.get(targetEventId) ?? [])
      const entry: ReactionEntry = { users: new Set(byEmoji.get(emoji)?.users ?? []), customUrl: byEmoji.get(emoji)?.customUrl ?? customUrl }
      entry.users.add(myPubkey); byEmoji.set(emoji, entry); reactions.set(targetEventId, byEmoji)
      return { reactions }
    })
    const { real, selfCopy } = await buildMdmReaction({ targetCoordinate: coord, recipientRootPub: recipientPubkey, myRootPub: myPubkey, emoji, customUrl, keys })
    const recipientRelays = await discoverRecipientRelays(recipientPubkey, getRelays()).catch(() => [] as string[])
    await Promise.all([
      publishWithFailover(real, recipientRelays.length ? recipientRelays : getRelays(), { pool: [...recipientRelays, ...getRelays()], target: 2 }),
      publishPersonal(selfCopy),
    ]).catch(() => {})
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

  setRelayProgress: (eventId, confirmed, total, acceptedRelays) => set((s) => ({ relayProgress: { ...s.relayProgress, [eventId]: { confirmed, total, acceptedRelays: acceptedRelays || [] } } })),
  clearRelayProgress: (eventId) => set((s) => { const { [eventId]: _, ...rest } = s.relayProgress; return { relayProgress: rest } }),
}))

/** Build a DM04Message-shaped record from a decrypted MDM payload. */
function toMessage(
  real: Event,
  payload: { t?: string; deleted?: boolean; reply?: string; rootRef?: string; isThread?: boolean; emoji?: [string, string, string?][]; sticker?: [string, string, string?][]; gif?: [string, string, string][] },
  counterparty: string,
  myPubkey: string,
  isMine: boolean,
  verified: boolean,
): DM04Message & { verified?: boolean } {
  return {
    id: real.id,
    content: payload.deleted ? '' : (payload.t ?? ''),
    senderPubkey: isMine ? myPubkey : counterparty,
    recipientPubkey: isMine ? counterparty : myPubkey,
    createdAt: real.created_at,
    isMine,
    deleted: payload.deleted,
    replyTo: payload.reply ? coordToId.get(payload.reply) : undefined,
    rootRef: payload.rootRef ? coordToId.get(payload.rootRef) : undefined,
    isThread: payload.isThread,
    emojiTags: payload.emoji,
    stickerTags: payload.sticker,
    gifTags: payload.gif,
    rawEvent: JSON.stringify(real),
    verified,
  }
}
