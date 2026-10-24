/**
 * Image Blob Cache — Two-layer architecture
 *
 * Layer 1: In-memory Map (URL → blob: URL) — instant, session-scoped
 * Layer 2: Persistent Blossom cache (hash → blob) — survives restart, 100MB budget
 * Layer 3: Network fetch (write-through to both layers)
 *
 * For Blossom/hash-based URLs: checks persistent cache before network fetch.
 * For non-Blossom URLs: in-memory only (no content-addressing guarantee).
 *
 * All existing callers (useCachedImageUrl, preCacheImage, getCachedImageUrl)
 * work unchanged — persistence is transparent.
 */

import {
  extractBlossomHash,
  getFromPersistentCache,
  putInPersistentCache,
} from '@/lib/cache/blossomMediaCache'

/** Remote URL → blob URL (or TOO_LARGE sentinel) */
const blobCache = new Map<string, string>()

/** Sentinel value indicating the image was too large */
export const IMAGE_TOO_LARGE = '__too_large__'

/** URLs currently being fetched (includes persistent cache lookups) */
const pendingFetches = new Set<string>()

/** Listeners waiting for a URL to be cached: url → Set<callback> */
const listeners = new Map<string, Set<() => void>>()

/** URLs that failed to fetch (CORS, network errors) — don't retry */
const failedUrls = new Set<string>()

/** url → persistent-cache key, memoized (hashing the URL isn't free). */
const keyCache = new Map<string, string>()

/**
 * Persistent-cache key for a URL. Content-addressed Blossom URLs key by their SHA-256 content hash
 * (so the same blob on different servers dedupes to one entry). Everything else — avatars/banners on
 * plain CDN or image-proxy URLs with no hash in the path — keys by a digest of the URL string, so it
 * persists across restarts too instead of being re-downloaded every launch. The `u_` prefix can't
 * collide with a 64-hex content hash.
 */
async function cacheKeyFor(url: string): Promise<string> {
  const hit = keyCache.get(url)
  if (hit) return hit
  let key = extractBlossomHash(url)
  if (!key) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
    key = 'u_' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  keyCache.set(url, key)
  return key
}

/**
 * Check if a URL should be cached (only remote HTTP/HTTPS URLs).
 */
function isCacheableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/**
 * Get the cached blob URL for a remote URL, or undefined if not cached.
 * Checks in-memory cache only (synchronous). For persistent cache hits,
 * the blob is loaded asynchronously and the caller is notified via listener.
 */
export function getCachedImageUrl(url: string): string | undefined {
  return blobCache.get(url)
}

/**
 * Pre-fetch and cache an image URL as a blob. Fire-and-forget.
 * Useful for pre-warming the cache (e.g. when a profile is fetched).
 * For Blossom URLs, checks persistent cache before hitting the network.
 */
export function preCacheImage(url: string, maxBytes?: number): void {
  if (!isCacheableUrl(url) || blobCache.has(url) || pendingFetches.has(url) || failedUrls.has(url)) return
  _doFetch(url, maxBytes)
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

/** Internal: perform the actual fetch and cache (persistent L2 layer, keyed by cacheKeyFor) */
function _doFetch(url: string, maxBytes?: number): void {
  pendingFetches.add(url)

  const doFetch = async () => {
    try {
      const cacheKey = await cacheKeyFor(url)

      // ── L2: Check the persistent on-disk cache before the network (survives restart). A hit lets
      // the caller render the local copy; the slow network <img> it may have started is superseded.
      const cachedBlob = await getFromPersistentCache(cacheKey)
      if (cachedBlob) {
        if (maxBytes && cachedBlob.size > maxBytes) {
          blobCache.set(url, IMAGE_TOO_LARGE)
          _notifyListeners(url)
          return
        }
        blobCache.set(url, URL.createObjectURL(cachedBlob))
        _notifyListeners(url)
        return
      }

      // ── L3: Network fetch (write-through to the persistent cache for ALL urls, not just hash
      // ones, so plain CDN/proxy avatars and banners also load locally on the next launch) ──
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
        blobCache.set(url, URL.createObjectURL(blob))
        _notifyListeners(url)
        putInPersistentCache(cacheKey, blob).catch(() => {})
        return
      }

      // No size limit or no ReadableStream support — standard path
      const blob = await res.blob()
      if (maxBytes && blob.size > maxBytes) {
        blobCache.set(url, IMAGE_TOO_LARGE)
        _notifyListeners(url)
        return
      }
      blobCache.set(url, URL.createObjectURL(blob))
      _notifyListeners(url)
      putInPersistentCache(cacheKey, blob).catch(() => {})
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
 * - If a blob URL is cached (in-memory) → returns it instantly (no network)
 * - Otherwise → returns the original URL while checking persistent cache / fetching
 * - Re-renders the component when the blob URL becomes available
 *
 * For Blossom URLs, persistent cache hits are near-instant (disk read, no network).
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
