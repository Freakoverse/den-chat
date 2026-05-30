/**
 * useProfileCache — Fetches and caches kind:0 Nostr profiles
 *
 * Returns a function `getProfile(pubkey)` that:
 * - Returns cached profile immediately if available
 * - Triggers a background fetch if not cached
 * - Re-renders the component when the profile arrives
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

/** Global profile cache: pubkey → profile */
const profileCache = new Map<string, NostrProfile>()

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

async function fetchProfile(pubkey: string) {
  if (profileCache.has(pubkey) || pendingFetches.has(pubkey)) return
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
        profileCache.set(pubkey, profile)
        notifyListeners(pubkey)
        // Pre-cache avatar image as blob URL for instant rendering
        if (profile.picture) {
          preCacheImage(profile.picture)
        }
        // Trigger DNN verification if nip05 is present
        if (profile.nip05) {
          useDnnStore.getState().verifyPubkey(pubkey, profile.nip05)
        }
      } catch { /* ignore parse errors */ }
    } else {
      // Mark as empty so we don't refetch
      profileCache.set(pubkey, {})
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
    }

    return cached
  }, [])

  return { getProfile }
}

/**
 * Get the display name for a pubkey from cache (non-hook version for simple usage)
 */
export function getCachedProfile(pubkey: string): NostrProfile | undefined {
  return profileCache.get(pubkey)
}
