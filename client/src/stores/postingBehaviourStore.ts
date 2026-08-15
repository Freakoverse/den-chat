/**
 * postingBehaviourStore — Controls WHERE events get published and WHERE media gets uploaded
 *
 * Provides computed relay and blossom server lists based on user toggles.
 * Consumed by all publishing paths (hub messages, social posts, DMs, profile edits, etc.)
 *
 * Persisted to localStorage so settings survive restarts.
 */

import { create } from 'zustand'
import { getRelays, getRelayList } from '@/lib/nostr/relay-pool'
import { useUserListsStore } from '@/stores/userListsStore'
import { useUserStore } from '@/stores/userStore'
import { blossomServers } from '@/lib/blossom'

const LS_KEY = 'denchat_posting_behaviour'

interface PostingBehaviourState {
  postToClientRelays: boolean
  postToUserRelays: boolean
  postToHubRelays: boolean
  limitClientRelays: boolean // cap client relays to 3
  limitUserRelays: boolean   // cap user (NIP-65) relays to 3
  limitHubRelays: boolean    // cap hub relays to 3
  limitClientBlossoms: boolean // cap client blossom servers to 3
  limitUserBlossoms: boolean   // cap user (kind 10063) blossom servers to 3
  limitHubBlossoms: boolean    // cap hub blossom servers to 3
  parallelBlossomUploads: boolean // upload to all target servers at once instead of one-by-one

  setPostToClientRelays: (v: boolean) => void
  setPostToUserRelays: (v: boolean) => void
  setPostToHubRelays: (v: boolean) => void
  setLimitClientRelays: (v: boolean) => void
  setLimitUserRelays: (v: boolean) => void
  setLimitHubRelays: (v: boolean) => void
  setLimitClientBlossoms: (v: boolean) => void
  setLimitUserBlossoms: (v: boolean) => void
  setLimitHubBlossoms: (v: boolean) => void
  setParallelBlossomUploads: (v: boolean) => void
}

type PersistedKeys = 'postToClientRelays' | 'postToUserRelays' | 'postToHubRelays' | 'limitClientRelays' | 'limitUserRelays' | 'limitHubRelays' | 'limitClientBlossoms' | 'limitUserBlossoms' | 'limitHubBlossoms' | 'parallelBlossomUploads'

function loadDefaults(): Pick<PostingBehaviourState, PersistedKeys> {
  try {
    const stored = localStorage.getItem(LS_KEY)
    if (stored) return { ...defaultValues, ...JSON.parse(stored) }
  } catch { /* ignore */ }
  return { ...defaultValues }
}

const defaultValues = {
  postToClientRelays: true,
  postToUserRelays: true,
  postToHubRelays: true,
  limitClientRelays: true,
  limitUserRelays: true,
  limitHubRelays: true,
  limitClientBlossoms: true,
  limitUserBlossoms: true,
  limitHubBlossoms: true,
  parallelBlossomUploads: false,
}

function persist(state: PostingBehaviourState) {
  const { postToClientRelays, postToUserRelays, postToHubRelays, limitClientRelays, limitUserRelays, limitHubRelays, limitClientBlossoms, limitUserBlossoms, limitHubBlossoms, parallelBlossomUploads } = state
  localStorage.setItem(LS_KEY, JSON.stringify({ postToClientRelays, postToUserRelays, postToHubRelays, limitClientRelays, limitUserRelays, limitHubRelays, limitClientBlossoms, limitUserBlossoms, limitHubBlossoms, parallelBlossomUploads }))
}

export const usePostingBehaviourStore = create<PostingBehaviourState>((set, get) => {
  const initial = loadDefaults()
  return {
    ...initial,

    setPostToClientRelays: (v) => { set({ postToClientRelays: v }); persist({ ...get(), postToClientRelays: v }) },
    setPostToUserRelays: (v) => { set({ postToUserRelays: v }); persist({ ...get(), postToUserRelays: v }) },
    setPostToHubRelays: (v) => { set({ postToHubRelays: v }); persist({ ...get(), postToHubRelays: v }) },
    setLimitClientRelays: (v) => { set({ limitClientRelays: v }); persist({ ...get(), limitClientRelays: v }) },
    setLimitUserRelays: (v) => { set({ limitUserRelays: v }); persist({ ...get(), limitUserRelays: v }) },
    setLimitHubRelays: (v) => { set({ limitHubRelays: v }); persist({ ...get(), limitHubRelays: v }) },
    setLimitClientBlossoms: (v) => { set({ limitClientBlossoms: v }); persist({ ...get(), limitClientBlossoms: v }) },
    setLimitUserBlossoms: (v) => { set({ limitUserBlossoms: v }); persist({ ...get(), limitUserBlossoms: v }) },
    setLimitHubBlossoms: (v) => { set({ limitHubBlossoms: v }); persist({ ...get(), limitHubBlossoms: v }) },
    setParallelBlossomUploads: (v) => { set({ parallelBlossomUploads: v }); persist({ ...get(), parallelBlossomUploads: v }) },
  }
})

/**
 * Deterministic "ring" pick: same seed + same list → same subset, every time,
 * on every device. Sorting first gives a stable order everywhere; the start
 * offset is `hash(seed) mod len`, so different seeds land on different windows
 * (spreading load across the pool) while each seed is pinned to a fixed set.
 * Falls back to the first N if there's no seed.
 *
 * Seeding by the author's own pubkey means every one of the author's devices
 * computes the identical subset from the identical inputs — no syncing, no
 * NIP-65 required.
 */
function pickForPubkey<T>(arr: T[], count: number, seed: string): T[] {
  if (arr.length <= count) return [...arr]
  const sorted = [...arr].sort()
  // pubkeys are uniformly-random hex, so 32 bits of the prefix distributes fine
  const start = seed ? parseInt(seed.slice(0, 8), 16) % sorted.length : 0
  return Array.from({ length: count }, (_, i) => sorted[(start + i) % sorted.length])
}

/**
 * Compute the relay list to publish to, based on current toggles.
 *
 * @param hubRelays Optional hub-specific relay list (from hub event)
 * @returns Deduplicated array of relay URLs to publish to
 */
export function getPublishRelays(hubRelays?: string[]): string[] {
  const state = usePostingBehaviourStore.getState()
  const result = new Set<string>()

  // Seed the deterministic pick with the author's own pubkey, so every one of
  // their devices selects the same subset from the same relay list. Empty seed
  // (logged out) falls back to the first N — deterministic either way.
  const me = useUserStore.getState().pubkey ?? ''

  // Build exclusion set: relays the user explicitly disabled in client settings
  const disabledRelays = new Set(
    getRelayList().filter((r) => !r.enabled).map((r) => r.url.replace(/\/+$/, ''))
  )

  // Client relays (from relay-pool, which reads localStorage — already filtered to enabled)
  if (state.postToClientRelays) {
    const limit = state.limitClientRelays ? 3 : Infinity
    pickForPubkey(getRelays(), limit, me).forEach((r) => result.add(r))
  }

  // User relays (NIP-65) — exclude any the user disabled in client settings
  if (state.postToUserRelays) {
    const limit = state.limitUserRelays ? 3 : Infinity
    const userRelays = useUserListsStore.getState().userRelays
      .filter((r) => !disabledRelays.has(r.replace(/\/+$/, '')))
    pickForPubkey(userRelays, limit, me).forEach((r) => result.add(r))
  }

  // Hub relays — exclude any the user disabled in client settings
  if (state.postToHubRelays && hubRelays && hubRelays.length > 0) {
    const limit = state.limitHubRelays ? 3 : Infinity
    const filtered = hubRelays.filter((r) => !disabledRelays.has(r.replace(/\/+$/, '')))
    pickForPubkey(filtered, limit, me).forEach((r) => result.add(r))
  }

  return Array.from(result)
}

/**
 * Compute the blossom server list to upload to, based on current toggles.
 *
 * @param hubBlossoms Optional hub-specific blossom servers (from hub event)
 * @returns Deduplicated array of blossom server URLs
 */
export function getUploadBlossoms(hubBlossoms?: string[]): string[] {
  const state = usePostingBehaviourStore.getState()
  const result = new Set<string>()

  // Seed the deterministic pick with the author's own pubkey — same rationale as
  // getPublishRelays. The resulting order is meaningful: the upload path walks it
  // in sequence (skipping dead servers = failover), so a fixed order gives every
  // device the same failover ring instead of a fresh random one each upload.
  const me = useUserStore.getState().pubkey ?? ''

  // Build exclusion set: blossom servers the user explicitly disabled in client settings
  const disabledBlossoms = new Set(
    blossomServers.getList().filter((s) => !s.enabled).map((s) => s.url.replace(/\/+$/, ''))
  )

  // Client blossom servers — respects the same toggle as client relays (already filtered to enabled)
  if (state.postToClientRelays) {
    const limit = state.limitClientBlossoms ? 3 : Infinity
    const clientServers = blossomServers.getServers()
    pickForPubkey(clientServers, limit, me).forEach((s) => result.add(s))
  }

  // User blossom servers — respects the same toggle as user relays, exclude disabled client servers
  if (state.postToUserRelays) {
    const limit = state.limitUserBlossoms ? 3 : Infinity
    const userBlossoms = useUserListsStore.getState().userBlossoms
      .filter((s) => !disabledBlossoms.has(s.replace(/\/+$/, '')))
    if (userBlossoms.length > 0) {
      pickForPubkey(userBlossoms, limit, me).forEach((s) => result.add(s))
    }
  }

  // Hub blossom servers — respects the same toggle as hub relays, exclude disabled client servers
  if (state.postToHubRelays && hubBlossoms && hubBlossoms.length > 0) {
    const limit = state.limitHubBlossoms ? 3 : Infinity
    const filtered = hubBlossoms.filter((s) => !disabledBlossoms.has(s.replace(/\/+$/, '')))
    pickForPubkey(filtered, limit, me).forEach((s) => result.add(s))
  }

  return Array.from(result)
}
