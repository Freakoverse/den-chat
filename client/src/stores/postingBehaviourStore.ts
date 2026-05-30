/**
 * postingBehaviourStore — Controls WHERE events get published and WHERE media gets uploaded
 *
 * Provides computed relay and blossom server lists based on user toggles.
 * Consumed by all publishing paths (hub messages, social posts, DMs, profile edits, etc.)
 *
 * Persisted to localStorage so settings survive restarts.
 */

import { create } from 'zustand'
import { getRelays } from '@/lib/nostr/relay-pool'
import { useUserListsStore } from '@/stores/userListsStore'
import { blossomServers } from '@/lib/blossom'

const LS_KEY = 'denchat_posting_behaviour'

interface PostingBehaviourState {
  postToClientRelays: boolean
  postToUserRelays: boolean
  postToHubRelays: boolean
  limitRelaysPerList: boolean   // cap 3 per list
  limitBlossomsPerList: boolean // cap 3 per list

  setPostToClientRelays: (v: boolean) => void
  setPostToUserRelays: (v: boolean) => void
  setPostToHubRelays: (v: boolean) => void
  setLimitRelaysPerList: (v: boolean) => void
  setLimitBlossomsPerList: (v: boolean) => void
}

function loadDefaults(): Pick<PostingBehaviourState, 'postToClientRelays' | 'postToUserRelays' | 'postToHubRelays' | 'limitRelaysPerList' | 'limitBlossomsPerList'> {
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
  limitRelaysPerList: true,
  limitBlossomsPerList: true,
}

function persist(state: PostingBehaviourState) {
  const { postToClientRelays, postToUserRelays, postToHubRelays, limitRelaysPerList, limitBlossomsPerList } = state
  localStorage.setItem(LS_KEY, JSON.stringify({ postToClientRelays, postToUserRelays, postToHubRelays, limitRelaysPerList, limitBlossomsPerList }))
}

export const usePostingBehaviourStore = create<PostingBehaviourState>((set, get) => {
  const initial = loadDefaults()
  return {
    ...initial,

    setPostToClientRelays: (v) => { set({ postToClientRelays: v }); persist({ ...get(), postToClientRelays: v }) },
    setPostToUserRelays: (v) => { set({ postToUserRelays: v }); persist({ ...get(), postToUserRelays: v }) },
    setPostToHubRelays: (v) => { set({ postToHubRelays: v }); persist({ ...get(), postToHubRelays: v }) },
    setLimitRelaysPerList: (v) => { set({ limitRelaysPerList: v }); persist({ ...get(), limitRelaysPerList: v }) },
    setLimitBlossomsPerList: (v) => { set({ limitBlossomsPerList: v }); persist({ ...get(), limitBlossomsPerList: v }) },
  }
})

/** Pick up to `count` random items from an array */
function pickRandom<T>(arr: T[], count: number): T[] {
  if (arr.length <= count) return [...arr]
  const shuffled = [...arr].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, count)
}

/**
 * Compute the relay list to publish to, based on current toggles.
 *
 * @param hubRelays Optional hub-specific relay list (from hub event)
 * @returns Deduplicated array of relay URLs to publish to
 */
export function getPublishRelays(hubRelays?: string[]): string[] {
  const state = usePostingBehaviourStore.getState()
  const limit = state.limitRelaysPerList ? 3 : Infinity
  const result = new Set<string>()

  // Client relays (from relay-pool, which reads localStorage)
  if (state.postToClientRelays) {
    pickRandom(getRelays(), limit).forEach((r) => result.add(r))
  }

  // User relays (NIP-65)
  if (state.postToUserRelays) {
    const userRelays = useUserListsStore.getState().userRelays
    pickRandom(userRelays, limit).forEach((r) => result.add(r))
  }

  // Hub relays
  if (state.postToHubRelays && hubRelays && hubRelays.length > 0) {
    pickRandom(hubRelays, limit).forEach((r) => result.add(r))
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
  const limit = state.limitBlossomsPerList ? 3 : Infinity
  const result = new Set<string>()

  // Client blossom servers
  const clientServers = blossomServers.getServers()
  pickRandom(clientServers, limit).forEach((s) => result.add(s))

  // User blossom servers
  const userBlossoms = useUserListsStore.getState().userBlossoms
  if (userBlossoms.length > 0) {
    pickRandom(userBlossoms, limit).forEach((s) => result.add(s))
  }

  // Hub blossom servers
  if (hubBlossoms && hubBlossoms.length > 0) {
    pickRandom(hubBlossoms, limit).forEach((s) => result.add(s))
  }

  return Array.from(result)
}
