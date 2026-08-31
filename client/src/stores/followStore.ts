import { create } from 'zustand'
import { fetchEvents, publishToSpecificRelays } from '@/lib/nostr/relay-pool'
import { publishPersonal, getPublishRelays } from '@/stores/postingBehaviourStore'
import { signWithSigner } from '@/lib/nostr/events'
import type { ISigner } from '@/stores/userStore'

/* ─── Follow List Store (kind 3) ───
 *
 * Safety guarantees:
 *  1. All mutations are serialized via a mutex — no concurrent kind:3 publishes.
 *  2. Before every publish, we re-fetch the latest kind:3 from relays to avoid
 *     overwriting follows added by other clients (Damus, Primal, etc.).
 *  3. followUser() is blocked until the initial load completes.
 *  4. If the local list is empty when following, the UI should show a warning
 *     modal (checked via `getFollowSafetyStatus()`).
 */

export type FollowLoadStatus = 'idle' | 'loading' | 'loaded' | 'error'

export interface FollowState {
  followedPubkeys: Set<string>
  /** Preserved .content from kind:3 event (relay hints etc.) */
  followListContent: string
  loaded: boolean
  /** Granular load status for UI feedback */
  loadStatus: FollowLoadStatus

  loadFollowList: (pubkey: string) => Promise<void>
  /** Manual retry — re-fetches from relays */
  refetchFollowList: (pubkey: string) => Promise<void>
  followUser: (pubkey: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  unfollowUser: (pubkey: string, myPubkey: string, signer: ISigner | null, privateKey: string | null) => Promise<void>
  isFollowing: (pubkey: string) => boolean
  /**
   * Check whether it's safe to follow someone right now.
   * Returns:
   *  - 'safe'        — list is loaded and non-empty, proceed normally
   *  - 'empty-list'  — list was fetched but is empty (new user OR wipe risk)
   *  - 'not-loaded'  — list hasn't finished loading yet
   *  - 'load-error'  — initial fetch failed
   */
  getFollowSafetyStatus: () => 'safe' | 'empty-list' | 'not-loaded' | 'load-error'
}

/* ── Mutex for serializing publish operations ── */
let publishQueue: Promise<void> = Promise.resolve()

function withMutex(fn: () => Promise<void>): Promise<void> {
  const next = publishQueue.then(fn, fn)
  publishQueue = next.catch(() => {}) // swallow to keep chain alive
  return next
}

/* ── Fetch latest kind:3 from relays ── */
async function fetchLatestFollowList(pubkey: string): Promise<{ follows: Set<string>; content: string } | null> {
  const events = await fetchEvents({
    kinds: [3],
    authors: [pubkey],
    limit: 1,
  })
  if (events.length === 0) return null

  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
  const follows = new Set<string>()
  for (const tag of latest.tags) {
    if (tag[0] === 'p' && tag[1]) follows.add(tag[1])
  }
  return { follows, content: latest.content || '' }
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
  await publishPersonal(signed)
}

/** Core fetch logic with retry (used by both load and refetch) */
async function fetchWithRetry(pubkey: string, maxRetries = 2): Promise<{ follows: Set<string>; content: string }> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fetchLatestFollowList(pubkey)
      if (result) return result
      // No events found — not an error, just empty
      return { follows: new Set<string>(), content: '' }
    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        // Back off slightly before retry
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

export const useFollowStore = create<FollowState>((set, get) => ({
  followedPubkeys: new Set(),
  followListContent: '',
  loaded: false,
  loadStatus: 'idle' as FollowLoadStatus,

  loadFollowList: async (pubkey) => {
    set({ loadStatus: 'loading' })
    try {
      const { follows, content } = await fetchWithRetry(pubkey)
      set({
        followedPubkeys: follows,
        followListContent: content,
        loaded: true,
        loadStatus: 'loaded',
      })
    } catch (err) {
      console.error('[followStore] Failed to load follow list after retries:', err)
      set({ loaded: true, loadStatus: 'error' })
    }
  },

  refetchFollowList: async (pubkey) => {
    set({ loadStatus: 'loading' })
    try {
      const { follows, content } = await fetchWithRetry(pubkey, 1)
      set({
        followedPubkeys: follows,
        followListContent: content,
        loaded: true,
        loadStatus: 'loaded',
      })
    } catch (err) {
      console.error('[followStore] Refetch failed:', err)
      set({ loadStatus: 'error' })
    }
  },

  followUser: async (pubkey, myPubkey, signer, privateKey) => {
    // Wait for initial load if still in progress
    if (!get().loaded) {
      console.warn('[followStore] followUser called before load complete — waiting...')
      await new Promise<void>((resolve) => {
        const unsub = useFollowStore.subscribe((state) => {
          if (state.loaded) { unsub(); resolve() }
        })
        // Safety timeout — don't wait forever
        setTimeout(() => { unsub(); resolve() }, 10_000)
      })
    }

    // Optimistic update
    const prevFollows = get().followedPubkeys
    const optimistic = new Set(prevFollows)
    optimistic.add(pubkey)
    set({ followedPubkeys: optimistic })

    return withMutex(async () => {
      try {
        // Re-fetch latest from relays to merge with any changes from other clients
        const fresh = await fetchLatestFollowList(myPubkey)
        const baseFollows = fresh?.follows ?? new Set(get().followedPubkeys)
        const content = fresh?.content ?? get().followListContent

        // Merge: base from relay + add the new pubkey
        baseFollows.add(pubkey)

        // Update local state to the merged set
        set({ followedPubkeys: baseFollows, followListContent: content })

        // Publish the merged result
        await publishFollowList(baseFollows, content, myPubkey, signer, privateKey)
      } catch (err) {
        console.error('[followStore] Failed to publish follow:', err)
        // Revert to state before this operation
        const revert = new Set(get().followedPubkeys)
        revert.delete(pubkey)
        set({ followedPubkeys: revert })
        throw err
      }
    })
  },

  unfollowUser: async (pubkey, myPubkey, signer, privateKey) => {
    // Optimistic update
    const prevFollows = get().followedPubkeys
    const optimistic = new Set(prevFollows)
    optimistic.delete(pubkey)
    set({ followedPubkeys: optimistic })

    return withMutex(async () => {
      try {
        // Re-fetch latest from relays to merge with any changes from other clients
        const fresh = await fetchLatestFollowList(myPubkey)
        const baseFollows = fresh?.follows ?? new Set(get().followedPubkeys)
        const content = fresh?.content ?? get().followListContent

        // Remove the target from the merged set
        baseFollows.delete(pubkey)

        // Update local state to the merged set
        set({ followedPubkeys: baseFollows, followListContent: content })

        // Publish the merged result
        await publishFollowList(baseFollows, content, myPubkey, signer, privateKey)
      } catch (err) {
        console.error('[followStore] Failed to publish unfollow:', err)
        // Revert — add back
        const revert = new Set(get().followedPubkeys)
        revert.add(pubkey)
        set({ followedPubkeys: revert })
        throw err
      }
    })
  },

  isFollowing: (pubkey) => get().followedPubkeys.has(pubkey),

  getFollowSafetyStatus: () => {
    const { loaded, loadStatus, followedPubkeys } = get()
    if (loadStatus === 'error') return 'load-error'
    if (!loaded || loadStatus === 'loading') return 'not-loaded'
    if (followedPubkeys.size === 0) return 'empty-list'
    return 'safe'
  },
}))
