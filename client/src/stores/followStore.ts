import { create } from 'zustand'
import { fetchEvents, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { getPublishRelays } from '@/stores/postingBehaviourStore'
import { signWithSigner } from '@/lib/nostr/events'
import type { ISigner } from '@/stores/userStore'

/* ─── Follow List Store (kind 3) ─── */

export interface FollowState {
  followedPubkeys: Set<string>
  /** Preserved .content from kind:3 event (relay hints etc.) */
  followListContent: string
  loaded: boolean

  loadFollowList: (pubkey: string) => Promise<void>
  followUser: (pubkey: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  unfollowUser: (pubkey: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  isFollowing: (pubkey: string) => boolean
}

/** Publish a kind:3 follow list */
async function publishFollowList(
  follows: Set<string>,
  content: string,
  myPubkey: string,
  signer: ISigner | null,
  privateKey: string | null,
) {
  const tags = Array.from(follows).map((pk) => ['p', pk])

  const unsigned = {
    kind: 3,
    pubkey: myPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  }

  const signed = await signWithSigner(unsigned, signer, privateKey)
  await publishToSpecificRelays(getPublishRelays(), signed)
}

export const useFollowStore = create<FollowState>((set, get) => ({
  followedPubkeys: new Set(),
  followListContent: '',
  loaded: false,

  loadFollowList: async (pubkey) => {
    try {
      const events = await fetchEvents({
        kinds: [3],
        authors: [pubkey],
        limit: 1,
      })

      if (events.length === 0) {
        set({ loaded: true })
        return
      }

      const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
      const follows = new Set<string>()

      for (const tag of latest.tags) {
        if (tag[0] === 'p' && tag[1]) follows.add(tag[1])
      }

      set({
        followedPubkeys: follows,
        followListContent: latest.content || '',
        loaded: true,
      })
    } catch (err) {
      console.error('[followStore] Failed to load follow list:', err)
      set({ loaded: true })
    }
  },

  followUser: async (pubkey, myPubkey, signer, privateKey) => {
    const follows = new Set(get().followedPubkeys)
    follows.add(pubkey)
    set({ followedPubkeys: follows })

    try {
      await publishFollowList(follows, get().followListContent, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[followStore] Failed to publish follow:', err)
      // Revert on failure
      follows.delete(pubkey)
      set({ followedPubkeys: new Set(follows) })
    }
  },

  unfollowUser: async (pubkey, myPubkey, signer, privateKey) => {
    const follows = new Set(get().followedPubkeys)
    follows.delete(pubkey)
    set({ followedPubkeys: follows })

    try {
      await publishFollowList(follows, get().followListContent, myPubkey, signer, privateKey)
    } catch (err) {
      console.error('[followStore] Failed to publish unfollow:', err)
      // Revert on failure
      follows.add(pubkey)
      set({ followedPubkeys: new Set(follows) })
    }
  },

  isFollowing: (pubkey) => get().followedPubkeys.has(pubkey),
}))
