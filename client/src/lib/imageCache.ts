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

/** Remote URL → blob URL (or TOO_LARGE sentinel) */
const blobCache = new Map<string, string>()

/** Sentinel value indicating the image was too large */
export const IMAGE_TOO_LARGE = '__too_large__'

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
function _doFetch(url: string, maxBytes?: number): void {
  pendingFetches.add(url)

  const doFetch = async () => {
    try {
      const res = await fetch(url, { mode: 'cors' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      // Check Content-Length header first (cheap)
      if (maxBytes) {
        const cl = res.headers.get('content-length')
        if (cl) {
          const size = Number(cl)
          if (!isNaN(size) && size > maxBytes) {
            blobCache.set(url, IMAGE_TOO_LARGE)
            _notifyListeners(url)
            return
          }
        }
      }

      // If we have a size limit and the body supports streaming, count bytes
      if (maxBytes && res.body) {
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let totalBytes = 0

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          totalBytes += value.length
          if (totalBytes > maxBytes) {
            reader.cancel()
            blobCache.set(url, IMAGE_TOO_LARGE)
            _notifyListeners(url)
            return
          }
          chunks.push(value)
        }

        const blob = new Blob(chunks)
        const blobUrl = URL.createObjectURL(blob)
        blobCache.set(url, blobUrl)
        _notifyListeners(url)
        return
      }

      // No size limit or no ReadableStream support — standard path
      const blob = await res.blob()
      if (maxBytes && blob.size > maxBytes) {
        blobCache.set(url, IMAGE_TOO_LARGE)
        _notifyListeners(url)
        return
      }
      const blobUrl = URL.createObjectURL(blob)
      blobCache.set(url, blobUrl)
      _notifyListeners(url)
    } catch {
      failedUrls.add(url)
    } finally {
      pendingFetches.delete(url)
      listeners.delete(url)
    }
  }

  doFetch()
}

function _notifyListeners(url: string): void {
  const cbs = listeners.get(url)
  if (cbs) {
    for (const cb of cbs) cb()
  }
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
export function useCachedImageUrl(src: string | undefined, maxSizeMB?: number): string | undefined {
  const [, forceUpdate] = useState(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  if (!src) return undefined

  // Already cached — return blob URL instantly (or undefined if too large)
  const cached = getCachedImageUrl(src)
  if (cached === IMAGE_TOO_LARGE) return IMAGE_TOO_LARGE
  if (cached) return cached

  // Not cached — trigger background fetch with optional size limit, re-render when ready
  if (isCacheableUrl(src)) {
    const maxBytes = maxSizeMB != null && maxSizeMB > 0 ? maxSizeMB * 1024 * 1024 : undefined
    fetchAndCacheImage(src, () => {
      if (mountedRef.current) forceUpdate((t) => t + 1)
    })
    // If there's a size limit and the fetch hasn't started yet, start the size-aware fetch
    if (maxBytes && !pendingFetches.has(src) && !blobCache.has(src) && !failedUrls.has(src)) {
      _doFetch(src, maxBytes)
    }
  }

  // While fetching (or non-cacheable URL), use the original
  return src
}
