/**
 * useProfileCache — Fetches and caches kind:0 Nostr profiles
 *
 * Returns a function `getProfile(pubkey)` that:
 * - Returns cached profile immediately if available
 * - Triggers a background fetch if not cached
 * - Re-fetches stale profiles (>1 hour) in the background (stale-while-revalidate)
 * - Re-renders the component when the profile arrives or updates
 *
 * Uses a global in-memory cache shared across all components.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchEvents } from '@/lib/nostr/relay-pool'
import { useDnnStore } from '@/stores/dnnStore'
import { preCacheImage } from '@/lib/imageCache'

export interface NostrProfile {
  name?: string
  display_name?: string
  picture?: string
  about?: string
  nip05?: string
  banner?: string
  website?: string
  lud16?: string
}

interface CachedEntry {
  profile: NostrProfile
  fetchedAt: number // Date.now() timestamp
  empty?: boolean   // true = no profile found yet (likely a transient miss, still retrying)
}

/** Stale-while-revalidate TTL: 1 hour */
const PROFILE_TTL_MS = 60 * 60 * 1000

/** Global profile cache: pubkey → { profile, fetchedAt } */
const profileCache = new Map<string, CachedEntry>()

/** Pubkeys currently being fetched (avoid duplicate requests) */
const pendingFetches = new Set<string>()

/**
 * Bounded retry for profiles that come back empty/failed. A kind:0 miss is
 * usually a transient relay hiccup (slow relay, query window cutoff), not a
 * genuine "no profile" — so retry a few times with a delay before giving up,
 * instead of caching an empty profile for the full TTL and never trying again.
 */
const EMPTY_RETRY_DELAY_MS = 15_000
const MAX_EMPTY_RETRIES = 6
const emptyRetryCount = new Map<string, number>()

/** Schedule a delayed retry for `pubkey`; returns false once retries are exhausted. */
function scheduleEmptyRetry(pubkey: string): boolean {
  const retries = emptyRetryCount.get(pubkey) ?? 0
  if (retries >= MAX_EMPTY_RETRIES) return false
  emptyRetryCount.set(pubkey, retries + 1)
  setTimeout(() => {
    // Only retry if we still don't have a real profile.
    const c = profileCache.get(pubkey)
    if (!c || c.empty) scheduleFetchProfile(pubkey)
  }, EMPTY_RETRY_DELAY_MS)
  return true
}

/** Listeners: pubkey → Set<callback> to notify when profile arrives */
const listeners = new Map<string, Set<() => void>>()

function notifyListeners(pubkey: string) {
  const cbs = listeners.get(pubkey)
  if (cbs) {
    for (const cb of cbs) cb()
  }
}

/** Store a profile in the cache, notify listeners, and trigger side effects */
function setCachedEntry(pubkey: string, profile: NostrProfile) {
  profileCache.set(pubkey, { profile, fetchedAt: Date.now() })
  notifyListeners(pubkey)
  // Pre-cache avatar image as blob URL for instant rendering
  if (profile.picture) {
    preCacheImage(profile.picture)
  }
  // Trigger DNN verification if nip05 is present
  if (profile.nip05) {
    useDnnStore.getState().verifyPubkey(pubkey, profile.nip05)
  }
}

/** ── Batched profile fetching ──
 * Instead of firing one relay query per pubkey, collect requests over
 * a short window (BATCH_DELAY_MS) and fire one combined query.
 * Max batch size of 50 prevents oversized relay filters.
 */
const BATCH_DELAY_MS = 100
const MAX_BATCH_SIZE = 50
let batchQueue: string[] = []
let batchTimer: ReturnType<typeof setTimeout> | null = null

function flushProfileBatch() {
  batchTimer = null
  if (batchQueue.length === 0) return

  // Take current batch and reset queue
  const batch = batchQueue.splice(0, MAX_BATCH_SIZE)

  // If there are leftovers (queue > MAX_BATCH_SIZE), schedule another flush
  if (batchQueue.length > 0) {
    batchTimer = setTimeout(flushProfileBatch, BATCH_DELAY_MS)
  }

  // Mark all as pending
  for (const pk of batch) pendingFetches.add(pk)

  fetchEvents({
    kinds: [0],
    authors: batch,
  }, 6000) // give slow relays a bit longer than the default before deciding it's a miss
    .then((events) => {
      // Group by author, keep newest per author
      const latestByAuthor = new Map<string, typeof events[0]>()
      for (const event of events) {
        const existing = latestByAuthor.get(event.pubkey)
        if (!existing || event.created_at > existing.created_at) {
          latestByAuthor.set(event.pubkey, event)
        }
      }

      // Process results
      for (const pubkey of batch) {
        const event = latestByAuthor.get(pubkey)
        if (event) {
          try {
            const profile: NostrProfile = JSON.parse(event.content)
            emptyRetryCount.delete(pubkey) // got it — clear any retry state
            setCachedEntry(pubkey, profile)
          } catch { /* ignore parse errors */ }
        } else {
          // No event found within the query window — probably a transient relay
          // hiccup. Keep retrying a few times before giving up. Cache empty
          // meanwhile so rows render a placeholder instead of hanging.
          const willRetry = scheduleEmptyRetry(pubkey)
          if (!willRetry) emptyRetryCount.delete(pubkey)
          profileCache.set(pubkey, { profile: {}, fetchedAt: Date.now(), empty: willRetry })
          notifyListeners(pubkey)
        }
      }
    })
    .catch(() => {
      // Whole query failed (rare — querySync usually resolves with partial data).
      // Retry the batch a few times so members aren't left as placeholders.
      for (const pk of batch) {
        const c = profileCache.get(pk)
        if (!c || c.empty) scheduleEmptyRetry(pk)
      }
    })
    .finally(() => {
      for (const pk of batch) pendingFetches.delete(pk)
    })
}

function scheduleFetchProfile(pubkey: string) {
  if (pendingFetches.has(pubkey)) return
  if (batchQueue.includes(pubkey)) return

  batchQueue.push(pubkey)

  // Start or reset the batch timer
  if (!batchTimer) {
    batchTimer = setTimeout(flushProfileBatch, BATCH_DELAY_MS)
  }

  // If batch is full, flush immediately
  if (batchQueue.length >= MAX_BATCH_SIZE) {
    clearTimeout(batchTimer)
    batchTimer = null
    flushProfileBatch()
  }
}

/**
 * Hook that returns a profile lookup function.
 * Components using this will re-render when new profiles are fetched.
 */
export function useProfileCache() {
  const [, setTick] = useState(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const getProfile = useCallback((pubkey: string): NostrProfile | undefined => {
    const cached = profileCache.get(pubkey)

    if (!cached) {
      // Register listener so this component re-renders when profile arrives
      const cb = () => {
        if (mountedRef.current) setTick((t) => t + 1)
      }

      if (!listeners.has(pubkey)) listeners.set(pubkey, new Set())
      listeners.get(pubkey)!.add(cb)

      // Trigger batched background fetch if not already in progress
      if (!pendingFetches.has(pubkey)) {
        scheduleFetchProfile(pubkey)
      }

      return undefined
    }

    // Stale-while-revalidate: return cached data immediately, but kick off
    // a background re-fetch if the entry is older than the TTL
    if (Date.now() - cached.fetchedAt > PROFILE_TTL_MS && !pendingFetches.has(pubkey)) {
      // Register listener so this component re-renders if the profile changed
      const cb = () => {
        if (mountedRef.current) setTick((t) => t + 1)
      }
      if (!listeners.has(pubkey)) listeners.set(pubkey, new Set())
      listeners.get(pubkey)!.add(cb)

      scheduleFetchProfile(pubkey)
    }

    return cached.profile
  }, [])

  return { getProfile }
}

/**
 * Get the display name for a pubkey from cache (non-hook version for simple usage)
 */
export function getCachedProfile(pubkey: string): NostrProfile | undefined {
  return profileCache.get(pubkey)?.profile
}

/**
 * Update the global profile cache from external sources (e.g. UserProfileModal).
 * Pushes the profile into the cache and notifies all listening components,
 * causing them to re-render with the updated name/avatar.
 */
export function updateCachedProfile(pubkey: string, profile: NostrProfile) {
  setCachedEntry(pubkey, profile)
}
