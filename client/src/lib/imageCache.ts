/**
 * In-memory Image Blob Cache
 *
 * Caches remote images as blob:// URLs to prevent re-downloading when
 * components remount. Keyed by remote URL — if the URL changes
 * (e.g. profile picture update via kind:0), the new image is fetched
 * automatically as a cache miss.
 *
 * Only HTTP/HTTPS URLs are cached. blob:, data:, and relative URLs
 * are passed through unchanged.
 */

/** Remote URL → blob URL */
const blobCache = new Map<string, string>()

/** URLs currently being fetched */
const pendingFetches = new Set<string>()

/** Listeners waiting for a URL to be cached: url → Set<callback> */
const listeners = new Map<string, Set<() => void>>()

/** URLs that failed to fetch (CORS, network errors) — don't retry */
const failedUrls = new Set<string>()

/**
 * Check if a URL should be cached (only remote HTTP/HTTPS URLs).
 */
function isCacheableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/**
 * Get the cached blob URL for a remote URL, or undefined if not cached.
 */
export function getCachedImageUrl(url: string): string | undefined {
  return blobCache.get(url)
}

/**
 * Pre-fetch and cache an image URL as a blob. Fire-and-forget.
 * Useful for pre-warming the cache (e.g. when a profile is fetched).
 */
export function preCacheImage(url: string): void {
  if (!isCacheableUrl(url) || blobCache.has(url) || pendingFetches.has(url) || failedUrls.has(url)) return
  _doFetch(url)
}

/**
 * Fetch and cache an image URL, calling onCached when the blob URL is ready.
 * If already cached, onCached is NOT called (the caller should check getCachedImageUrl first).
 */
export function fetchAndCacheImage(url: string, onCached: () => void): void {
  if (!isCacheableUrl(url) || blobCache.has(url) || failedUrls.has(url)) return

  // Register listener for this URL
  if (!listeners.has(url)) listeners.set(url, new Set())
  listeners.get(url)!.add(onCached)

  // Start fetch if not already in progress
  if (!pendingFetches.has(url)) {
    _doFetch(url)
  }
}

/** Internal: perform the actual fetch and cache */
function _doFetch(url: string): void {
  pendingFetches.add(url)

  fetch(url, { mode: 'cors' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.blob()
    })
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob)
      blobCache.set(url, blobUrl)

      // Notify all waiting listeners
      const cbs = listeners.get(url)
      if (cbs) {
        for (const cb of cbs) cb()
      }
    })
    .catch(() => {
      // CORS or network error — mark as failed so we don't retry
      failedUrls.add(url)
    })
    .finally(() => {
      pendingFetches.delete(url)
      listeners.delete(url)
    })
}

/* ─── React Hook ─── */

import { useState, useEffect, useRef } from 'react'

/**
 * React hook that returns the best available URL for an image:
 * - If a blob URL is cached → returns it instantly (no network)
 * - Otherwise → returns the original URL while fetching the blob in background
 * - Re-renders the component when the blob URL becomes available
 *
 * Safe for non-HTTP URLs (blob:, data:, relative) — passes them through unchanged.
 */
export function useCachedImageUrl(src: string | undefined): string | undefined {
  const [, forceUpdate] = useState(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  if (!src) return undefined

  // Already cached — return blob URL instantly
  const cached = getCachedImageUrl(src)
  if (cached) return cached

  // Not cached — trigger background fetch, re-render when ready
  if (isCacheableUrl(src)) {
    fetchAndCacheImage(src, () => {
      if (mountedRef.current) forceUpdate((t) => t + 1)
    })
  }

  // While fetching (or non-cacheable URL), use the original
  return src
}
