/**
 * Mod moderation store (Discover → Mods). Ported from DEG MODS' moderationStore.
 *
 * A moderation authority (an npub, by default DEG MODS' admin) publishes lists that discovery honors:
 *  - excluded tags (NIP-78, d: moderation-excluded-tags) — applied to the Mods filters' excluded tags.
 *  - blocked mods (NIP-78, d: blocked-mods) — hidden from the listing; optionally render-blocked.
 *  - blocked users (NIP-51 mute list, kind 10000) — their mods are hidden.
 *
 * Two opt-outs, both on by default: "soft" hides the flagged mods/users from discovery, "hard"
 * render-blocks mods the authority marked view-blocked. The authority itself is swappable, so a user can
 * follow a different curator (or none) at their own risk. Persisted so the last-known lists and the chosen
 * authority are available instantly on the next visit.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Event } from 'nostr-tools'
import { fetchEventsFromRelays } from '@/lib/nostr/relay-pool'
import { useModFiltersStore } from '@/stores/modFiltersStore'
import {
  MOD_ADMIN_PUBKEY, MOD_ADMIN_KIND, MODERATION_EXCLUDED_TAGS_DTAG,
  BLOCKED_MODS_DTAG, MOD_MUTE_LIST_KIND, getModRelays,
} from '@/lib/mods/modEvent'

export interface BlockedMod {
  /** Mod coordinate, e.g. 31142:<pubkey>:<dTag>. */
  coord: string
  /** When true, the mod is render-blocked even on direct open (hard moderation). */
  viewBlocked: boolean
}

interface ModModerationState {
  /** The authority whose lists are honored. Swappable; defaults to DEG MODS' admin. */
  adminPubkey: string
  /** Hide the authority's flagged mods/users from the listing. */
  softModeration: boolean
  /** Render-block mods the authority marked view-blocked, even when they would otherwise show. */
  hardModeration: boolean
  blockedMods: BlockedMod[]
  blockedUsers: string[]
  lastUpdated: number
  syncing: boolean
  setAdminPubkey: (hex: string) => void
  resetAdminPubkey: () => void
  setSoftModeration: (v: boolean) => void
  setHardModeration: (v: boolean) => void
  /** Fetch the authority's three lists from the mod relays and apply them. */
  syncModeration: () => Promise<void>
}

function parseBlockedMods(event: Event | null): BlockedMod[] {
  if (!event) return []
  return event.tags
    .filter((t) => t[0] === 'a' && t[1])
    .map((t) => ({ coord: t[1], viewBlocked: t[2] === 'block' }))
}

/** Newest-by-created_at of a batch (replaceable lists can arrive in any order across relays). */
function newest(events: Event[]): Event | null {
  if (events.length === 0) return null
  return events.reduce((a, b) => (b.created_at > a.created_at ? b : a))
}

export const useModModerationStore = create<ModModerationState>()(
  persist(
    (set, get) => ({
      adminPubkey: MOD_ADMIN_PUBKEY,
      softModeration: true,
      hardModeration: true,
      blockedMods: [],
      blockedUsers: [],
      lastUpdated: 0,
      syncing: false,

      setAdminPubkey: (hex) => {
        if (!hex || hex === get().adminPubkey) return
        // New authority → drop the previous authority's cached lists until the next sync resolves.
        set({ adminPubkey: hex, blockedMods: [], blockedUsers: [], lastUpdated: 0 })
        void get().syncModeration()
      },
      resetAdminPubkey: () => {
        if (get().adminPubkey === MOD_ADMIN_PUBKEY) return
        set({ adminPubkey: MOD_ADMIN_PUBKEY, blockedMods: [], blockedUsers: [], lastUpdated: 0 })
        void get().syncModeration()
      },
      setSoftModeration: (softModeration) => set({ softModeration }),
      setHardModeration: (hardModeration) => set({ hardModeration }),

      syncModeration: async () => {
        const relays = getModRelays()
        const admin = get().adminPubkey
        if (relays.length === 0 || !admin) return
        set({ syncing: true })
        try {
          const [tagEvents, blockedEvents, muteEvents] = await Promise.all([
            fetchEventsFromRelays(relays, { kinds: [MOD_ADMIN_KIND], authors: [admin], '#d': [MODERATION_EXCLUDED_TAGS_DTAG], limit: 1 }),
            fetchEventsFromRelays(relays, { kinds: [MOD_ADMIN_KIND], authors: [admin], '#d': [BLOCKED_MODS_DTAG], limit: 1 }),
            fetchEventsFromRelays(relays, { kinds: [MOD_MUTE_LIST_KIND], authors: [admin], limit: 1 }),
          ])
          const tagsEvent = newest(tagEvents)
          const blockedEvent = newest(blockedEvents)
          const muteEvent = newest(muteEvents)

          const next: Partial<ModModerationState> = { lastUpdated: Date.now() }
          if (tagsEvent) {
            const tags = tagsEvent.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase())
            // Only tracks the authority defaults until the user customizes their excluded tags.
            if (tags.length > 0) useModFiltersStore.getState().applyExcludedTagsDefaults(tags)
          }
          if (blockedEvent) next.blockedMods = parseBlockedMods(blockedEvent)
          if (muteEvent) next.blockedUsers = muteEvent.tags.filter((t) => t[0] === 'p' && t[1]).map((t) => t[1])
          set(next)
        } catch {
          // keep the last-known lists
        } finally {
          set({ syncing: false })
        }
      },
    }),
    {
      name: 'den-mods-moderation',
      // `syncing` is transient — never persist it.
      partialize: (s) => ({
        adminPubkey: s.adminPubkey,
        softModeration: s.softModeration,
        hardModeration: s.hardModeration,
        blockedMods: s.blockedMods,
        blockedUsers: s.blockedUsers,
        lastUpdated: s.lastUpdated,
      }),
    },
  ),
)
