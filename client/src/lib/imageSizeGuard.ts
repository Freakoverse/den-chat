/**
 * imageSizeGuard — Centralized image size limit enforcement
 *
 * Two-tier detection strategy:
 * 1. HEAD request → read Content-Length header (fast, no download)
 * 2. Streaming GET fallback → read body via ReadableStream, count bytes,
 *    abort with reader.cancel() if threshold exceeded
 *
 * If streaming completes within limit, the downloaded data is kept as a
 * blob URL (no wasted bandwidth).
 *
 * Used by useBlossomMedia, useCachedImageUrl, emoji/sticker stores, etc.
 */

// ── Render limit categories & localStorage keys ──

export type RenderLimitCategory = 'profile' | 'banner' | 'chat' | 'social'

const LIMIT_KEYS: Record<RenderLimitCategory, string> = {
  profile: 'den-chat-render-limit-profile-mb',
  banner:  'den-chat-render-limit-banner-mb',
  chat:    'den-chat-render-limit-chat-mb',
  social:  'den-chat-render-limit-social-mb',
}

const LIMIT_DEFAULTS: Record<RenderLimitCategory, number> = {
  profile: 5,
  banner:  5,
  chat:    25,
  social:  20,
}

export const LIMIT_MAX_SLIDER: Record<RenderLimitCategory, number> = {
  profile: 25,
  banner:  50,
  chat:    100,
  social:  100,
}

/** Get the render limit for a category in MB. */
export function getRenderLimit(category: RenderLimitCategory): number {
  try {
    const stored = localStorage.getItem(LIMIT_KEYS[category])
    if (stored != null) {
      const val = Number(stored)
      if (!isNaN(val) && val >= 0) return val
    }
  } catch { /* ignore */ }
  return LIMIT_DEFAULTS[category]
}

/** Set the render limit for a category in MB. */
export function setRenderLimit(category: RenderLimitCategory, valueMB: number): void {
  try {
    localStorage.setItem(LIMIT_KEYS[category], String(Math.max(0, valueMB)))
  } catch { /* ignore */ }
}

/** Reset all render limits to defaults. */
export function resetRenderLimits(): void {
  for (const cat of Object.keys(LIMIT_KEYS) as RenderLimitCategory[]) {
    try { localStorage.removeItem(LIMIT_KEYS[cat]) } catch { /* ignore */ }
  }
}

/** Get default value for a category. */
export function getRenderLimitDefault(category: RenderLimitCategory): number {
  return LIMIT_DEFAULTS[category]
}

// ── Session-only "Load anyway" override set ──

const overrideSet = new Set<string>()

/** Mark a URL as overridden for this session (bypass size limit). */
export function addSizeOverride(url: string): void {
  overrideSet.add(url)
}

/** Check if a URL has been overridden this session. */
export function hasSizeOverride(url: string): boolean {
  return overrideSet.has(url)
}

// ── Global size cache ──
// Maps URL → size in bytes, or 'unknown' if HEAD didn't return Content-Length

const sizeCache = new Map<string, number | 'unknown'>()

/** Get cached size for a URL (if already checked). */
export function getCachedSize(url: string): number | 'unknown' | undefined {
  return sizeCache.get(url)
}

/** Feed a known size into the cache (e.g. from a HEAD response in useBlossomMedia). */
export function setCachedSize(url: string, sizeBytes: number | 'unknown'): void {
  sizeCache.set(url, sizeBytes)
}

// ── Tier 1: HEAD request ──

/** Pending HEAD requests to avoid duplicates. */
const pendingHeadChecks = new Map<string, Promise<number | 'unknown'>>()

/**
 * Check image size via HEAD request.
 * Returns size in bytes if Content-Length is present, 'unknown' otherwise.
 * Results are cached globally per URL.
 */
export async function checkImageSize(url: string): Promise<number | 'unknown'> {
  // Check cache first
  const cached = sizeCache.get(url)
  if (cached !== undefined) return cached

  // Deduplicate concurrent checks for the same URL
  const pending = pendingHeadChecks.get(url)
  if (pending) return pending

  const promise = _doHeadCheck(url)
  pendingHeadChecks.set(url, promise)

  try {
    const result = await promise
    return result
  } finally {
    pendingHeadChecks.delete(url)
  }
}

async function _doHeadCheck(url: string): Promise<number | 'unknown'> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal })
    clearTimeout(timer)

    const cl = res.headers.get('content-length')
    if (cl) {
      const size = Number(cl)
      if (!isNaN(size) && size > 0) {
        sizeCache.set(url, size)
        return size
      }
    }

    sizeCache.set(url, 'unknown')
    return 'unknown'
  } catch {
    sizeCache.set(url, 'unknown')
    return 'unknown'
  }
}

// ── Tier 2: Streaming GET fallback ──

export type StreamGuardResult =
  | { ok: true; blobUrl: string; size: number }
  | { ok: false; size: number }

/**
 * Streaming size-guarded fetch.
 *
 * Downloads via ReadableStream, counting bytes. If the total exceeds limitBytes,
 * the stream is cancelled immediately and { ok: false, size } is returned.
 *
 * If the download completes within the limit, a blob URL is created from the
 * collected chunks so the data isn't wasted — { ok: true, blobUrl, size }.
 */
export async function streamGuardedFetch(
  url: string,
  limitBytes: number,
): Promise<StreamGuardResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000) // 60s timeout

  try {
    const res = await fetch(url, { signal: controller.signal, mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    // Check Content-Length one more time (some servers return it on GET but not HEAD)
    const cl = res.headers.get('content-length')
    if (cl) {
      const size = Number(cl)
      if (!isNaN(size) && size > 0) {
        sizeCache.set(url, size)
        if (size > limitBytes) {
          controller.abort()
          return { ok: false, size }
        }
      }
    }

    // If no body or no ReadableStream support, fall back to blob
    if (!res.body) {
      const blob = await res.blob()
      sizeCache.set(url, blob.size)
      if (blob.size > limitBytes) {
        return { ok: false, size: blob.size }
      }
      return { ok: true, blobUrl: URL.createObjectURL(blob), size: blob.size }
    }

    // Stream and count bytes
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      totalBytes += value.length
      if (totalBytes > limitBytes) {
        reader.cancel()
        sizeCache.set(url, totalBytes) // cache at least the size we know
        return { ok: false, size: totalBytes }
      }
      chunks.push(value)
    }

    // Within limit — build blob URL
    const blob = new Blob(chunks)
    sizeCache.set(url, totalBytes)
    return { ok: true, blobUrl: URL.createObjectURL(blob), size: totalBytes }
  } catch {
    // Network error — allow rendering (can't determine size)
    return { ok: true, blobUrl: '', size: 0 }
  } finally {
    clearTimeout(timer)
  }
}

// ── Convenience: synchronous check for React render (like isEmojiSizeOk) ──

/**
 * Synchronous size check for use in React render functions.
 *
 * Returns 'ok' | 'too-large' | 'checking' | 'unknown'.
 * - 'ok': cached size is within limit
 * - 'too-large': cached size exceeds limit
 * - 'checking': HEAD request in progress (optimistic — treat as ok)
 * - 'unknown': HEAD completed but no Content-Length (needs streaming fallback)
 *
 * Automatically fires a HEAD request if the URL hasn't been checked yet.
 */
export type SizeCheckStatus = 'ok' | 'too-large' | 'checking' | 'unknown'

const checkingSet = new Set<string>()

export function checkSizeSync(url: string, limitBytes: number): SizeCheckStatus {
  const cached = sizeCache.get(url)
  if (cached !== undefined) {
    if (cached === 'unknown') return 'unknown'
    return cached <= limitBytes ? 'ok' : 'too-large'
  }

  // Not yet checked — fire async HEAD
  if (!checkingSet.has(url)) {
    checkingSet.add(url)
    checkImageSize(url).finally(() => checkingSet.delete(url))
  }

  return 'checking'
}

// ── Utility: format bytes for display ──

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
