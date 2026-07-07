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
  loaded: boolean
  refreshingRelays: boolean
  refreshingBlossoms: boolean

  /** Load both lists on login */
  loadUserLists: (pubkey: string) => Promise<void>
  /** Refresh just the user relay list */
  refreshUserRelays: (pubkey: string) => Promise<void>
  /** Refresh just the user blossom list */
  refreshUserBlossoms: (pubkey: string) => Promise<void>
}

export const useUserListsStore = create<UserListsState>((set) => ({
  userRelays: [],
  userBlossoms: [],
  loaded: false,
  refreshingRelays: false,
  refreshingBlossoms: false,

  loadUserLists: async (pubkey: string) => {
    // Retry on launch — a single cold-start fetch often misses before relays connect.
    const [relayEv, blossomEv] = await Promise.all([
      fetchReplaceableWithRetry(pubkey, STANDARD_KINDS.RELAY_LIST),
      fetchReplaceableWithRetry(pubkey, STANDARD_KINDS.BLOSSOM_SERVER_LIST),
    ])

    const userRelays = relayEv
      ? relayEv.tags.filter((t) => t[0] === 'r').map((t) => t[1])
      : []

    const userBlossoms = blossomEv
      ? blossomEv.tags.filter((t) => t[0] === 'server').map((t) => t[1])
      : []

    set({ userRelays, userBlossoms, loaded: true })
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
}))
