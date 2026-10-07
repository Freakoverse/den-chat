/**
 * dmMdmStore — NIP-MDM (Masked Direct Messages) conversation store. See docs/NIP-MDM.md.
 *
 * Simpler than dm04Store: there is no counterparty discovery to do, because the counterparty's real root
 * is inside the decrypted payload (received: the verified `from`; sent: the embedded real event's `p`).
 * Two subscriptions on the user's own read relays:
 *   - received  { kinds:[30092], "#p":[myRoot] }                      → others' messages to me (docs §3.2)
 *   - my copies { kinds:[30092], authors:[C_from], "#p":[C_to] }      → self-copies of what I sent (docs §3.4)
 *
 * Sending publishes two events with the §5 relay split: the real message to the recipient's relays (never
 * the sender's own NIP-65), the self-copy to the sender's own relays (never the recipient's).
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
import {
  MDM_KIND,
  mdmSupported,
  selfCopyKeys,
  buildMdmMessage,
  decryptReceivedMdm,
  decryptSelfCopy,
  decryptOwnMdm,
  mdmCoordinate,
  type MdmKeys,
} from '@/lib/nostr/nipMdm'

const MDM_LIMIT = 300
const norm = (u: string) => u.replace(/\/+$/, '')

export interface MdmMessage {
  id: string                 // the real event id
  coord: string              // addressable coordinate "30092:<M>:<d>" (stable across edits)
  content: string            // decrypted text
  senderPubkey: string       // real root of the sender
  recipientPubkey: string    // real root of the recipient
  createdAt: number
  isMine: boolean
  /** received: the `from` matched the masked author (docs §1.3); mine: always true */
  verified: boolean
}

export interface MdmConversation {
  pubkey: string             // counterparty real root
  messages: MdmMessage[]
  lastMessageAt: number
  lastMessagePreview: string
  unread: number
}

interface MdmState {
  conversations: Map<string, MdmConversation>
  activeConversation: string | null
  pendingConversations: Set<string>
  loading: boolean
  processedIds: Set<string>
  subs: { close: () => void }[]

  setActiveConversation: (pubkey: string | null) => void
  addPendingConversation: (pubkey: string) => void
  removePendingConversation: (pubkey: string) => void
  startSubscription: (myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  stopSubscription: () => void
  sendMessage: (recipientPubkey: string, content: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  getFilteredConversations: (followList: Set<string>) => { following: MdmConversation[]; other: MdmConversation[] }
}

/** Insert or replace a message in the counterparty's conversation (replace-by-coord, newest wins). */
function upsert(conversations: Map<string, MdmConversation>, counterparty: string, msg: MdmMessage, activeConv: string | null): void {
  const existing = conversations.get(counterparty)
  const conv: MdmConversation = existing
    ? { ...existing, messages: [...existing.messages] }
    : { pubkey: counterparty, messages: [], lastMessageAt: 0, lastMessagePreview: '', unread: 0 }

  const at = conv.messages.findIndex((m) => m.coord === msg.coord)
  if (at >= 0) {
    if (conv.messages[at].createdAt > msg.createdAt) { conversations.set(counterparty, conv); return } // keep newer
    conv.messages[at] = msg
  } else {
    conv.messages.push(msg)
    if (!msg.isMine && counterparty !== activeConv) conv.unread += 1
  }

  conv.messages.sort((a, b) => a.createdAt - b.createdAt)
  const last = conv.messages[conv.messages.length - 1]
  conv.lastMessageAt = last.createdAt
  conv.lastMessagePreview = last.content.slice(0, 120)
  conversations.set(counterparty, conv)
}

export const useMdmStore = create<MdmState>((set, get) => ({
  conversations: new Map(),
  activeConversation: null,
  pendingConversations: new Set(),
  loading: false,
  processedIds: new Set(),
  subs: [],

  setActiveConversation: (pubkey) => {
    set((s) => {
      if (pubkey && s.conversations.has(pubkey)) {
        const conversations = new Map(s.conversations)
        const conv = conversations.get(pubkey)!
        if (conv.unread > 0) conversations.set(pubkey, { ...conv, unread: 0 })
        return { activeConversation: pubkey, conversations }
      }
      return { activeConversation: pubkey }
    })
  },

  addPendingConversation: (pubkey) => set((s) => ({ pendingConversations: new Set(s.pendingConversations).add(pubkey) })),
  removePendingConversation: (pubkey) => set((s) => {
    const next = new Set(s.pendingConversations); next.delete(pubkey); return { pendingConversations: next }
  }),

  startSubscription: async (myPubkey, signer, privateKey) => {
    const keys: MdmKeys = { privateKey, signer }
    if (!mdmSupported(keys)) {
      console.warn('[MDM] masked DMs need a local key or a NIP-SKD signer; disabled')
      set({ loading: false })
      return
    }
    get().subs.forEach((s) => s.close())
    set({ loading: true, subs: [] })

    let cFrom: string, cTo: string
    try {
      ({ from: cFrom, to: cTo } = await selfCopyKeys(keys))
    } catch (err) {
      console.warn('[MDM] could not derive self-copy keys:', err)
      set({ loading: false })
      return
    }

    const onReceived = async (event: Event) => {
      if (get().processedIds.has(event.id)) return
      set((s) => ({ processedIds: new Set(s.processedIds).add(event.id) }))
      const dec = await decryptReceivedMdm(event, keys)
      if (!dec) return
      const counterparty = dec.senderRootPub
      if (useBlockStore.getState().blockedPubkeys.has(counterparty)) return // docs §4.1 (post-decrypt block)
      const coord = mdmCoordinate(event)
      if (!coord) return
      const msg: MdmMessage = {
        id: event.id, coord, content: dec.payload.t ?? '', senderPubkey: counterparty,
        recipientPubkey: myPubkey, createdAt: event.created_at, isMine: false, verified: dec.verified,
      }
      set((s) => { const conversations = new Map(s.conversations); upsert(conversations, counterparty, msg, s.activeConversation); return { conversations } })
    }

    const onMyCopy = async (event: Event) => {
      if (event.pubkey !== cFrom) return // docs §3.4: accept a self-copy only if authored by my C_from
      if (get().processedIds.has(event.id)) return
      set((s) => ({ processedIds: new Set(s.processedIds).add(event.id) }))
      const real = await decryptSelfCopy(event, keys)
      if (!real) return
      const recipient = real.tags.find((t) => t[0] === 'p')?.[1]
      const coord = mdmCoordinate(real)
      if (!recipient || !coord) return
      const payload = await decryptOwnMdm(real, keys)
      const msg: MdmMessage = {
        id: real.id, coord, content: payload?.t ?? '', senderPubkey: myPubkey,
        recipientPubkey: recipient, createdAt: real.created_at, isMine: true, verified: true,
      }
      set((s) => { const conversations = new Map(s.conversations); upsert(conversations, recipient, msg, s.activeConversation); return { conversations } })
    }

    const received = subscribeEventsWide({ kinds: [MDM_KIND], '#p': [myPubkey], limit: MDM_LIMIT } as Filter, onReceived)
    const mine = subscribeEventsWide({ kinds: [MDM_KIND], authors: [cFrom], '#p': [cTo], limit: MDM_LIMIT } as Filter, onMyCopy)
    set({ subs: [received, mine], loading: false })
  },

  stopSubscription: () => { get().subs.forEach((s) => s.close()); set({ subs: [] }) },

  sendMessage: async (recipientPubkey, content, myPubkey, signer, privateKey) => {
    const keys: MdmKeys = { privateKey, signer }
    if (!mdmSupported(keys)) throw new Error('Masked DMs need a local key or a NIP-SKD signer.')

    const { real, selfCopy } = await buildMdmMessage({
      recipientRootPub: recipientPubkey,
      myRootPub: myPubkey,
      body: { t: content },
      keys,
    })

    // Optimistic local echo (the self-copy sub will later replace this by coordinate).
    const coord = mdmCoordinate(real)!
    set((s) => {
      const conversations = new Map(s.conversations)
      upsert(conversations, recipientPubkey, {
        id: real.id, coord, content, senderPubkey: myPubkey, recipientPubkey,
        createdAt: real.created_at, isMine: true, verified: true,
      }, s.activeConversation)
      return { conversations }
    })

    // §5 relay split: real -> recipient's relays + client defaults (NEVER sender's own NIP-65);
    //                  self-copy -> sender's own relays + client (publishPersonal; NEVER recipient's).
    const recipientRelays = await discoverRecipientRelays(recipientPubkey, getRelays()).catch(() => [] as string[])
    const realPool = [...recipientRelays, ...getRelays()]
    const realSeed = recipientRelays.length > 0 ? recipientRelays : getRelays()
    const target = Math.min(new Set(realPool.map(norm)).size || 1, 4)
    await Promise.all([
      publishWithFailover(real, realSeed, { pool: realPool, target }),
      publishPersonal(selfCopy),
    ])
  },

  getFilteredConversations: (followList) => {
    const { conversations, pendingConversations } = get()
    const blocked = useBlockStore.getState().blockedPubkeys
    const following: MdmConversation[] = []
    const other: MdmConversation[] = []

    for (const [pubkey, conv] of conversations) {
      if (blocked.has(pubkey)) continue
      if (useWotStore.getState().shouldHide(pubkey, 'dms')) continue
      ;(followList.has(pubkey) ? following : other).push(conv)
    }
    for (const pk of pendingConversations) {
      if (blocked.has(pk) || conversations.has(pk)) continue
      const empty: MdmConversation = { pubkey: pk, messages: [], lastMessageAt: nowSeconds(), lastMessagePreview: '', unread: 0 }
      ;(followList.has(pk) ? following : other).push(empty)
    }
    const sortFn = (a: MdmConversation, b: MdmConversation) => b.lastMessageAt - a.lastMessageAt
    following.sort(sortFn); other.sort(sortFn)
    return { following, other }
  },
}))
