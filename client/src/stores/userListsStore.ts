/**
 * userListsStore — Stores the user's published relay list (NIP-65) and blossom server list (kind 10063)
 *
 * Loaded once on login in useStartup. Can be refreshed manually from Settings.
 * Consumed by postingBehaviourStore to compute where to publish events.
 */

import { create } from 'zustand'
import { fetchReplaceable } from '@/lib/nostr/relay-pool'
import { STANDARD_KINDS } from '@/lib/crypto/constants'
import type { Event } from 'nostr-tools'

/**
 * Fetch a replaceable event, retrying up to `attempts` times. Guards against a cold
 * launch where relays haven't connected yet and the first fetch returns nothing —
 * otherwise the user's relay list stays empty until a later manual refresh.
 */
async function fetchReplaceableWithRetry(pubkey: string, kind: number, attempts = 3): Promise<Event | null> {
  for (let i = 0; i < attempts; i++) {
    const ev = await fetchReplaceable(pubkey, kind).catch(() => null)
    if (ev) return ev
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}

interface UserListsState {
  userRelays: string[]
  userBlossoms: string[]
  /**
   * The user's own NIP-17 DM inbox relays (kind 10050), if they've published one — typically via
   * ANOTHER client (Amethyst, 0xchat, …), since DEN doesn't publish its own. DEN reads its gift-wrap
   * inbox from these too (see getDMReadRelays), so a DM a spec-strict sender delivered to the user's
   * advertised 10050 mailbox is actually seen here. Empty when no 10050 exists → no effect.
   */
  userDMRelays: string[]
  loaded: boolean
  refreshingRelays: boolean
  refreshingBlossoms: boolean

  /** Load all three lists on login */
  loadUserLists: (pubkey: string) => Promise<void>
  /** Refresh just the user relay list */
  refreshUserRelays: (pubkey: string) => Promise<void>
  /** Refresh just the user blossom list */
  refreshUserBlossoms: (pubkey: string) => Promise<void>
  /** Refresh just the user's own DM (kind-10050) relay list */
  refreshUserDMRelays: (pubkey: string) => Promise<void>
}

/** Parse a kind-10050 event's `["relay", url]` tags into a URL list. */
function parseDMRelays(ev: Event | null): string[] {
  return ev ? ev.tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1]) : []
}

export const useUserListsStore = create<UserListsState>((set) => ({
  userRelays: [],
  userBlossoms: [],
  userDMRelays: [],
  loaded: false,
  refreshingRelays: false,
  refreshingBlossoms: false,

  loadUserLists: async (pubkey: string) => {
    // Retry on launch — a single cold-start fetch often misses before relays connect.
    const [relayEv, blossomEv, dmRelayEv] = await Promise.all([
      fetchReplaceableWithRetry(pubkey, STANDARD_KINDS.RELAY_LIST),
      fetchReplaceableWithRetry(pubkey, STANDARD_KINDS.BLOSSOM_SERVER_LIST),
      fetchReplaceableWithRetry(pubkey, STANDARD_KINDS.DM_RELAY_LIST),
    ])

    const userRelays = relayEv
      ? relayEv.tags.filter((t) => t[0] === 'r').map((t) => t[1])
      : []

    const userBlossoms = blossomEv
      ? blossomEv.tags.filter((t) => t[0] === 'server').map((t) => t[1])
      : []

    set({ userRelays, userBlossoms, userDMRelays: parseDMRelays(dmRelayEv), loaded: true })
  },

  refreshUserRelays: async (pubkey: string) => {
    set({ refreshingRelays: true })
    try {
      const ev = await fetchReplaceable(pubkey, STANDARD_KINDS.RELAY_LIST)
      const userRelays = ev
        ? ev.tags.filter((t) => t[0] === 'r').map((t) => t[1])
        : []
      set({ userRelays })
    } finally {
      set({ refreshingRelays: false })
    }
  },

  refreshUserBlossoms: async (pubkey: string) => {
    set({ refreshingBlossoms: true })
    try {
      const ev = await fetchReplaceable(pubkey, STANDARD_KINDS.BLOSSOM_SERVER_LIST)
      const userBlossoms = ev
        ? ev.tags.filter((t) => t[0] === 'server').map((t) => t[1])
        : []
      set({ userBlossoms })
    } finally {
      set({ refreshingBlossoms: false })
    }
  },

  refreshUserDMRelays: async (pubkey: string) => {
    const ev = await fetchReplaceable(pubkey, STANDARD_KINDS.DM_RELAY_LIST).catch(() => null)
    set({ userDMRelays: parseDMRelays(ev) })
  },
}))
