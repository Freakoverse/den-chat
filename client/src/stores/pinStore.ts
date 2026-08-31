/**
 * pinStore — Zustand store for hub channel message pins (kind 36945)
 *
 * Each user has one addressable replaceable event per hub containing all their
 * pins across channels. Pins reference messages via addressable `a`-style refs
 * (kind:pubkey:d-tag) which are stable across edits.
 */

import { create } from 'zustand'
import { KINDS } from '@/lib/crypto/constants'
import {
  createUnsignedEvent,
  signWithSigner,
} from '@/lib/nostr'
import {
  publishToSpecificRelays,
  subscribeToRelays,
} from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { useHubStore } from '@/stores/hubStore'
import { isV2 } from '@/lib/hub/version'
import type { Event, Filter } from 'nostr-tools'

/**
 * v2 fail-closed guard: a PIN_LIST is a hub-scoped event, so on a private hub it MUST be authored under
 * the member pseudonym `P` (via `authSigner`), never `R`. If `authSigner` is absent on a v2 hub —
 * because the async `hubMemberIdentity` derivation hasn't resolved yet (a race reachable by clicking pin
 * immediately), or the signer can't do SKD — refuse rather than fall back to `signWithSigner(R)`, which
 * would leak the real key onto the hub relays. Mirrors signHubMemberEvent's throw.
 */
function assertV2AuthReady(hubDTag: string, authSigner: unknown): void {
  const hub = useHubStore.getState().hubs[hubDTag]
  if (hub && isV2(hub) && !authSigner) {
    throw new Error('Pin unavailable — your private-hub identity is still loading. Please try again in a moment.')
  }
}

/* ─── Types ─── */

export interface PinRef {
  channelId: string
  /** Addressable reference: "36943:<author_pubkey>:<msg_d_tag>" */
  aRef: string
}

export interface PinEvent {
  pubkey: string
  pins: PinRef[]
  createdAt: number
}

interface PinState {
  /**
   * Map keyed by hub d-tag → array of PinEvents (one per pinner).
   * We keep the raw array so the UI can group by pubkey.
   */
  pinsByHub: Record<string, PinEvent[]>

  /** Active subscription close handles keyed by hub d-tag */
  _subs: Record<string, { close: () => void }>

  /** Subscribe to all pin list events for a hub */
  subscribePins: (hubDTag: string, relays: string[]) => void

  /** Unsubscribe from a hub's pin events */
  unsubscribePins: (hubDTag: string) => void

  /** Get pins for a specific channel from all pinners */
  getPinsForChannel: (hubDTag: string, channelId: string) => PinEvent[]

  /** Check if the current user has pinned a specific message */
  isMessagePinned: (hubDTag: string, channelId: string, aRef: string, myPubkey: string) => boolean

  /** Pin a message */
  pinMessage: (
    hubDTag: string,
    channelId: string,
    /** The author key the pin list is stored under: pseudonym `P` in a v2 hub, real key `R` in v1. */
    aRef: string,
    myPubkey: string,
    relays: string[],
    signer: any,
    privateKey: string | null,
    /** v2: signs the pin-list event as `P` (so it doesn't reveal `R`'s hub membership). */
    authSigner?: (unsigned: import('nostr-tools').UnsignedEvent) => Promise<import('nostr-tools').Event>,
  ) => Promise<void>

  /** Unpin a message */
  unpinMessage: (
    hubDTag: string,
    channelId: string,
    aRef: string,
    myPubkey: string,
    relays: string[],
    signer: any,
    privateKey: string | null,
    authSigner?: (unsigned: import('nostr-tools').UnsignedEvent) => Promise<import('nostr-tools').Event>,
  ) => Promise<void>
}

/* ─── Helpers ─── */

function parsePinEvent(event: Event): PinEvent {
  const pins: PinRef[] = []
  for (const tag of event.tags) {
    if (tag[0] === 'pin' && tag.length >= 3) {
      pins.push({ channelId: tag[1], aRef: tag[2] })
    }
  }
  return { pubkey: event.pubkey, pins, createdAt: event.created_at }
}

function buildPinTags(hubDTag: string, pins: PinRef[]): [string, ...string[]][] {
  const tags: [string, ...string[]][] = [['d', hubDTag]]
  for (const pin of pins) {
    tags.push(['pin', pin.channelId, pin.aRef])
  }
  return tags
}

/* ─── Store ─── */

export const usePinStore = create<PinState>((set, get) => ({
  pinsByHub: {},
  _subs: {},

  subscribePins: (hubDTag, relays) => {
    // Don't double-subscribe
    if (get()._subs[hubDTag]) return

    const filter: Filter = {
      kinds: [KINDS.PIN_LIST as number],
      '#d': [hubDTag],
    }

    const sub = subscribeToRelays(
      relays,
      filter,
      (event) => {
        const parsed = parsePinEvent(event)
        set((s) => {
          const existing = s.pinsByHub[hubDTag] || []
          // Replace if same pubkey (newer version), otherwise add
          const idx = existing.findIndex((p) => p.pubkey === parsed.pubkey)
          let updated: PinEvent[]
          if (idx >= 0) {
            // Only replace if newer
            if (parsed.createdAt > existing[idx].createdAt) {
              updated = [...existing]
              updated[idx] = parsed
            } else {
              return s // ignore older version
            }
          } else {
            updated = [...existing, parsed]
          }
          return { pinsByHub: { ...s.pinsByHub, [hubDTag]: updated } }
        })
      },
    )

    set((s) => ({ _subs: { ...s._subs, [hubDTag]: sub } }))
  },

  unsubscribePins: (hubDTag) => {
    const sub = get()._subs[hubDTag]
    if (sub) {
      sub.close()
      set((s) => {
        const { [hubDTag]: _, ...rest } = s._subs
        return { _subs: rest }
      })
    }
  },

  getPinsForChannel: (hubDTag, channelId) => {
    const all = get().pinsByHub[hubDTag] || []
    return all
      .map((pe) => ({
        ...pe,
        pins: pe.pins.filter((p) => p.channelId === channelId),
      }))
      .filter((pe) => pe.pins.length > 0)
  },

  isMessagePinned: (hubDTag, channelId, aRef, myPubkey) => {
    const all = get().pinsByHub[hubDTag] || []
    const mine = all.find((p) => p.pubkey === myPubkey)
    if (!mine) return false
    return mine.pins.some((p) => p.channelId === channelId && p.aRef === aRef)
  },

  pinMessage: async (hubDTag, channelId, aRef, myPubkey, relays, signer, privateKey, authSigner) => {
    if (!signer && !privateKey) return

    // Get current pins for this hub
    const all = get().pinsByHub[hubDTag] || []
    const mine = all.find((p) => p.pubkey === myPubkey)
    const currentPins = mine?.pins || []

    // Check if already pinned
    if (currentPins.some((p) => p.channelId === channelId && p.aRef === aRef)) return

    const newPins = [...currentPins, { channelId, aRef }]
    const tags = buildPinTags(hubDTag, newPins)
    const unsigned = createUnsignedEvent(KINDS.PIN_LIST, '', tags)
    assertV2AuthReady(hubDTag, authSigner)
    const signed = authSigner ? await authSigner(unsigned) : await signWithSigner(unsigned, signer, privateKey)

    // Optimistic local update
    const newPinEvent: PinEvent = { pubkey: myPubkey, pins: newPins, createdAt: signed.created_at }
    set((s) => {
      const existing = s.pinsByHub[hubDTag] || []
      const idx = existing.findIndex((p) => p.pubkey === myPubkey)
      const updated = idx >= 0
        ? existing.map((p, i) => i === idx ? newPinEvent : p)
        : [...existing, newPinEvent]
      return { pinsByHub: { ...s.pinsByHub, [hubDTag]: updated } }
    })

    // Publish — hub relays only on v2 (a P-authored PIN_LIST pushed to the pinner's personal NIP-65 relays
    // would let an observer link their pseudonym P → real key R by relay footprint).
    await publishToSpecificRelays(getPublishRelays(relays, { hubOnly: isV2(useHubStore.getState().hubs[hubDTag]) }), signed)
  },

  unpinMessage: async (hubDTag, channelId, aRef, myPubkey, relays, signer, privateKey, authSigner) => {
    if (!signer && !privateKey) return

    const all = get().pinsByHub[hubDTag] || []
    const mine = all.find((p) => p.pubkey === myPubkey)
    if (!mine) return

    const newPins = mine.pins.filter((p) => !(p.channelId === channelId && p.aRef === aRef))
    const tags = buildPinTags(hubDTag, newPins)
    const unsigned = createUnsignedEvent(KINDS.PIN_LIST, '', tags)
    assertV2AuthReady(hubDTag, authSigner)
    const signed = authSigner ? await authSigner(unsigned) : await signWithSigner(unsigned, signer, privateKey)

    // Optimistic local update
    const newPinEvent: PinEvent = { pubkey: myPubkey, pins: newPins, createdAt: signed.created_at }
    set((s) => {
      const existing = s.pinsByHub[hubDTag] || []
      const updated = existing.map((p) => p.pubkey === myPubkey ? newPinEvent : p)
      return { pinsByHub: { ...s.pinsByHub, [hubDTag]: updated } }
    })

    // Publish — hub relays only on v2 (see pinMessage).
    await publishToSpecificRelays(getPublishRelays(relays, { hubOnly: isV2(useHubStore.getState().hubs[hubDTag]) }), signed)
  },
}))
