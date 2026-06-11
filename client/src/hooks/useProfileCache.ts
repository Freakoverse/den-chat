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
}

/** Stale-while-revalidate TTL: 1 hour */
const PROFILE_TTL_MS = 60 * 60 * 1000

/** Global profile cache: pubkey → { profile, fetchedAt } */
const profileCache = new Map<string, CachedEntry>()

/** Pubkeys currently being fetched (avoid duplicate requests) */
const pendingFetches = new Set<string>()

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

async function fetchProfile(pubkey: string) {
  if (pendingFetches.has(pubkey)) return
  pendingFetches.add(pubkey)

  try {
    const events = await fetchEvents({
      kinds: [0],
      authors: [pubkey],
      limit: 1,
    })

    if (events.length > 0) {
      // Use the most recent event
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
      try {
        const profile: NostrProfile = JSON.parse(latest.content)
        setCachedEntry(pubkey, profile)
      } catch { /* ignore parse errors */ }
    } else {
      // Mark as empty so we don't refetch constantly
      profileCache.set(pubkey, { profile: {}, fetchedAt: Date.now() })
      notifyListeners(pubkey)
    }
  } catch {
    // Failed to fetch, don't cache — allow retry
  } finally {
    pendingFetches.delete(pubkey)
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

      // Trigger background fetch if not already in progress
      if (!pendingFetches.has(pubkey)) {
        fetchProfile(pubkey)
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

      fetchProfile(pubkey)
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
