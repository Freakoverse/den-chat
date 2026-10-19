/**
 * recommendationStore: the user's own hub-recommendation list (published as a public NIP-78 event, see
 * lib/hub/hubRecommendations) plus the LOCAL (per-device) config of which npubs the user trusts as
 * recommendation sources for the Discover "Perspective" tab.
 *
 * The app admin is always a trusted source (can be toggled off but not removed). Turning every source off
 * (and acknowledging the warning) is how the user opts into the raw "all discoverable" firehose.
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
const ALLOFF_KEY = 'den_rec_alloff_ack'

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
function loadAllOffAck(): boolean {
  try { return localStorage.getItem(ALLOFF_KEY) === '1' } catch { return false }
}
function saveAllOffAck(v: boolean) {
  try { localStorage.setItem(ALLOFF_KEY, v ? '1' : '0') } catch { /* non-fatal */ }
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
  /** Trusted recommendation sources for the Perspective tab (local, per device). */
  trustedSources: TrustedSource[]
  /** Set once the user has explicitly accepted the "no trusted sources" (firehose) warning. */
  allOffAck: boolean

  loadMyRecs: (myPubkey: string) => Promise<void>
  hasRec: (coord: string) => boolean
  addRec: (ref: HubRecRef, signer: ISigner | null, privateKey: string | null) => Promise<void>
  removeRec: (coord: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  /** Replace the trusted-source list (persists). Clears allOffAck when any source is enabled. */
  setTrustedSources: (list: TrustedSource[]) => void
  /** Explicitly set the firehose acknowledgement (the all-off confirm). */
  setAllOffAck: (v: boolean) => void
}

export const useRecommendationStore = create<RecState>((set, get) => ({
  myRecs: new Map(),
  myRecsLoaded: false,
  trustedSources: loadTrusted(),
  allOffAck: loadAllOffAck(),

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
    const anyEnabled = list.some((s) => s.enabled)
    const allOffAck = anyEnabled ? false : get().allOffAck
    if (anyEnabled) saveAllOffAck(false)
    set({ trustedSources: list, allOffAck })
  },

  setAllOffAck: (v) => {
    saveAllOffAck(v)
    set({ allOffAck: v })
  },
}))
