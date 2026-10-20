/**
 * recommendationStore: the user's own hub-recommendation list (published as a public NIP-78 event, see
 * lib/hub/hubRecommendations) plus the LOCAL (per-device) Discover config.
 *
 * The Discover feed is driven by three independent, per-device toggles: followRecs (hubs recommended by
 * people you follow), sourceRecs (hubs recommended by your trusted sources: DEN + added npubs), and
 * seeEverything (the uncurated "all discoverable" firehose). The app admin is always a trusted source
 * (can be toggled off but not removed).
 */

import { create } from 'zustand'
import { ADMIN_PUBKEY } from '@/lib/constants'
import type { ISigner } from '@/stores/userStore'
import {
  type HubRecRef,
  fetchMyRecommendations,
  publishHubRecommendations,
} from '@/lib/hub/hubRecommendations'

export interface TrustedSource { pubkey: string; enabled: boolean }

const TRUSTED_KEY = 'den_rec_trusted_sources'
const FOLLOWRECS_KEY = 'den_rec_follow_recs'
const SOURCERECS_KEY = 'den_rec_source_recs'
const SEEALL_KEY = 'den_rec_see_everything'

function loadTrusted(): TrustedSource[] {
  try {
    const raw = localStorage.getItem(TRUSTED_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        const list: TrustedSource[] = arr
          .filter((x) => x && typeof x.pubkey === 'string')
          .map((x) => ({ pubkey: x.pubkey as string, enabled: !!x.enabled }))
        // The admin source is always present (toggle-able, not removable).
        if (!list.some((s) => s.pubkey === ADMIN_PUBKEY)) list.unshift({ pubkey: ADMIN_PUBKEY, enabled: true })
        return list
      }
    }
  } catch { /* fall through to default */ }
  return [{ pubkey: ADMIN_PUBKEY, enabled: true }]
}

function saveTrusted(list: TrustedSource[]) {
  try { localStorage.setItem(TRUSTED_KEY, JSON.stringify(list)) } catch { /* non-fatal */ }
}
function loadBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v == null ? def : v === '1'
  } catch { return def }
}
function saveBool(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? '1' : '0') } catch { /* non-fatal */ }
}

// Serialize recommendation-list publishes so rapid add/remove don't race each other.
let publishQueue: Promise<void> = Promise.resolve()
function withMutex(fn: () => Promise<void>): Promise<void> {
  const next = publishQueue.then(fn, fn)
  publishQueue = next.catch(() => {})
  return next
}

interface RecState {
  /** The user's own recommended hubs, keyed by coordinate (retains relay hints). */
  myRecs: Map<string, HubRecRef>
  myRecsLoaded: boolean
  /** Trusted recommendation sources (local, per device). */
  trustedSources: TrustedSource[]
  /** Include recommendations from people you follow in the feed (local, per device, default on). */
  followRecs: boolean
  /** Include recommendations from your trusted sources (DEN + added npubs) in the feed (default on). */
  sourceRecs: boolean
  /** Firehose: show every discoverable hub with no curation (default off, independent of the above). */
  seeEverything: boolean

  loadMyRecs: (myPubkey: string) => Promise<void>
  hasRec: (coord: string) => boolean
  addRec: (ref: HubRecRef, signer: ISigner | null, privateKey: string | null) => Promise<void>
  removeRec: (coord: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  /** Replace the trusted-source list (persists). */
  setTrustedSources: (list: TrustedSource[]) => void
  /** Toggle folding your follows' recommendations into the feed (persists). */
  setFollowRecs: (v: boolean) => void
  /** Toggle folding your trusted sources' recommendations into the feed (persists). */
  setSourceRecs: (v: boolean) => void
  /** Toggle the uncurated firehose (persists). */
  setSeeEverything: (v: boolean) => void
}

export const useRecommendationStore = create<RecState>((set, get) => ({
  myRecs: new Map(),
  myRecsLoaded: false,
  trustedSources: loadTrusted(),
  followRecs: loadBool(FOLLOWRECS_KEY, true),
  sourceRecs: loadBool(SOURCERECS_KEY, true),
  seeEverything: loadBool(SEEALL_KEY, false),

  loadMyRecs: async (myPubkey) => {
    try {
      const refs = await fetchMyRecommendations(myPubkey)
      const map = new Map<string, HubRecRef>()
      for (const r of refs) map.set(r.coord, r)
      set({ myRecs: map, myRecsLoaded: true })
    } catch {
      set({ myRecsLoaded: true })
    }
  },

  hasRec: (coord) => get().myRecs.has(coord),

  addRec: (ref, signer, privateKey) => withMutex(async () => {
    if (get().myRecs.has(ref.coord)) return
    const prev = get().myRecs
    const next = new Map(prev)
    next.set(ref.coord, ref)
    set({ myRecs: next }) // optimistic
    try {
      await publishHubRecommendations([...next.values()], signer, privateKey)
    } catch (err) {
      set({ myRecs: prev }) // revert on publish failure
      throw err
    }
  }),

  removeRec: (coord, signer, privateKey) => withMutex(async () => {
    if (!get().myRecs.has(coord)) return
    const prev = get().myRecs
    const next = new Map(prev)
    next.delete(coord)
    set({ myRecs: next }) // optimistic
    try {
      await publishHubRecommendations([...next.values()], signer, privateKey)
    } catch (err) {
      set({ myRecs: prev }) // revert on publish failure
      throw err
    }
  }),

  setTrustedSources: (list) => {
    saveTrusted(list)
    set({ trustedSources: list })
  },

  setFollowRecs: (v) => {
    saveBool(FOLLOWRECS_KEY, v)
    set({ followRecs: v })
  },

  setSourceRecs: (v) => {
    saveBool(SOURCERECS_KEY, v)
    set({ sourceRecs: v })
  },

  setSeeEverything: (v) => {
    saveBool(SEEALL_KEY, v)
    set({ seeEverything: v })
  },
}))
