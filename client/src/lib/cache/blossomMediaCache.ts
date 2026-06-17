/**
 * Persistent Blossom Media Cache
 *
 * Two-part storage:
 * 1. Cache API  — stores binary blobs efficiently (browser-managed, on-disk)
 * 2. IndexedDB  — stores lightweight metadata for LRU eviction tracking
 *
 * Content-addressed by SHA-256 hash (extracted from Blossom URLs), so the same
 * image served from different blossom servers shares a single cache entry.
 *
 * Budget: 100MB total. When exceeded, evicts least-recently-accessed entries
 * until under budget. Pruning runs in the background, never blocks rendering.
 */

// ─── Constants ───

const CACHE_NAME = 'den-blossom-media-v1'
const META_DB_NAME = 'den-blossom-meta'
const META_DB_VERSION = 1
const META_STORE = 'entries'
const CACHE_BUDGET_KEY = 'den-media-cache-mb'
const DEFAULT_BUDGET_MB = 500

function loadBudgetBytes(): number {
  try {
    const raw = localStorage.getItem(CACHE_BUDGET_KEY)
    if (raw !== null) {
      const mb = Number(raw)
      if (Number.isFinite(mb) && mb >= 0) return Math.round(mb) * 1024 * 1024
    }
  } catch { /* ignore */ }
  return DEFAULT_BUDGET_MB * 1024 * 1024
}

// Current cache budget in bytes (0 = caching disabled). Mutated via setCacheBudgetMB.
let cacheBudgetBytes = loadBudgetBytes()

// Synthetic base URL for Cache API keys (Cache API requires valid URLs)
const CACHE_KEY_PREFIX = 'https://blossom-local-cache/'

// ─── Types ───

interface CacheEntryMeta {
  hash: string         // SHA-256 hex (primary key)
  size: number         // blob size in bytes
  lastAccessed: number // Date.now() timestamp for LRU
}

// ─── Hash Extraction ───

/**
 * Extract SHA-256 hash from a Blossom URL.
 * Matches a 64-character hex string in the URL pathname, with an optional
 * file extension (e.g. `.jpg`, `.webp`).
 *
 * Examples:
 *   https://blossom.example.com/abc123…def456          → abc123…def456
 *   https://cdn.example.com/abc123…def456.jpg          → abc123…def456
 *   https://cdn.example.com/uploads/abc123…def456.webp → abc123…def456
 *   https://example.com/not-a-hash.jpg                 → null
 */
export function extractBlossomHash(url: string): string | null {
  try {
    const pathname = new URL(url).pathname
    const match = pathname.match(/\/?([a-f0-9]{64})(?:\.[a-zA-Z0-9]+)?$/)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

// ─── Cache API availability ───

let cacheApiAvailable: boolean | null = null

async function isCacheApiAvailable(): Promise<boolean> {
  if (cacheApiAvailable !== null) return cacheApiAvailable
  try {
    if (typeof caches === 'undefined') {
      cacheApiAvailable = false
      return false
    }
    // Probe: try opening a cache to confirm it works
    await caches.open(CACHE_NAME)
    cacheApiAvailable = true
    return true
  } catch {
    cacheApiAvailable = false
    return false
  }
}

// ─── IDB Metadata Store ───

let metaDb: IDBDatabase | null = null

function openMetaDB(): Promise<IDBDatabase> {
  if (metaDb) return Promise.resolve(metaDb)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB_NAME, META_DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'hash' })
      }
    }
    req.onsuccess = () => {
      metaDb = req.result
      resolve(metaDb)
    }
    req.onerror = () => reject(req.error)
  })
}

// ─── Read ───

/**
 * Look up a blob in the persistent cache by its SHA-256 hash.
 * Returns the Blob if found, or null on miss. Updates lastAccessed on hit.
 */
export async function getFromPersistentCache(hash: string): Promise<Blob | null> {
  try {
    if (cacheBudgetBytes <= 0) return null // caching disabled
    if (!(await isCacheApiAvailable())) return null

    const cache = await caches.open(CACHE_NAME)
    const response = await cache.match(CACHE_KEY_PREFIX + hash)
    if (!response) return null

    // Update lastAccessed in background (don't block the read)
    touchMeta(hash).catch(() => {})

    return await response.blob()
  } catch {
    return null
  }
}

// ─── Write ───

/**
 * Store a blob in the persistent cache, keyed by its SHA-256 hash.
 * Also writes metadata for LRU tracking and schedules a background prune.
 */
export async function putInPersistentCache(hash: string, blob: Blob): Promise<void> {
  try {
    if (cacheBudgetBytes <= 0) return // caching disabled
    if (!(await isCacheApiAvailable())) return

    // Store blob via Cache API
    const cache = await caches.open(CACHE_NAME)
    const response = new Response(blob, {
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        'X-Cached-At': Date.now().toString(),
      },
    })
    await cache.put(CACHE_KEY_PREFIX + hash, response)

    // Store metadata for LRU tracking
    try {
      const db = await openMetaDB()
      const tx = db.transaction(META_STORE, 'readwrite')
      const store = tx.objectStore(META_STORE)
      const meta: CacheEntryMeta = {
        hash,
        size: blob.size,
        lastAccessed: Date.now(),
      }
      store.put(meta)
    } catch { /* metadata is best-effort */ }

    // Schedule background prune (debounced)
    schedulePrune()
  } catch {
    // Cache API write failed — not critical, image still works from network
  }
}

// ─── LRU Metadata ───

/** Update lastAccessed timestamp for a cache entry */
async function touchMeta(hash: string): Promise<void> {
  try {
    const db = await openMetaDB()
    const tx = db.transaction(META_STORE, 'readwrite')
    const store = tx.objectStore(META_STORE)
    const req = store.get(hash)
    await new Promise<void>((resolve) => {
      req.onsuccess = () => {
        const existing = req.result as CacheEntryMeta | undefined
        if (existing) {
          store.put({ ...existing, lastAccessed: Date.now() })
        }
        resolve()
      }
      req.onerror = () => resolve()
    })
  } catch { /* best-effort */ }
}

// ─── Pruning ───

let pruneScheduled = false

function schedulePrune(): void {
  if (pruneScheduled) return
  pruneScheduled = true
  // Delay to batch multiple writes before pruning
  setTimeout(() => {
    pruneScheduled = false
    pruneCache().catch(() => {})
  }, 5000)
}

/**
 * Evict least-recently-accessed entries until total size is under cacheBudgetBytes.
 * Runs in the background, never blocks rendering.
 */
async function pruneCache(): Promise<void> {
  try {
    const db = await openMetaDB()
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const allReq = store.getAll()

    const entries: CacheEntryMeta[] = await new Promise((resolve, reject) => {
      allReq.onsuccess = () => resolve(allReq.result || [])
      allReq.onerror = () => reject(allReq.error)
    })

    const totalSize = entries.reduce((sum, e) => sum + e.size, 0)
    if (totalSize <= cacheBudgetBytes) return

    // Sort by lastAccessed ascending (oldest → evict first)
    entries.sort((a, b) => a.lastAccessed - b.lastAccessed)

    let currentSize = totalSize
    const toEvict: string[] = []

    for (const entry of entries) {
      if (currentSize <= cacheBudgetBytes) break
      toEvict.push(entry.hash)
      currentSize -= entry.size
    }

    if (toEvict.length === 0) return

    // Delete blobs from Cache API
    const cache = await caches.open(CACHE_NAME)
    for (const hash of toEvict) {
      await cache.delete(CACHE_KEY_PREFIX + hash)
    }

    // Delete metadata from IDB
    const txDel = db.transaction(META_STORE, 'readwrite')
    const storeDel = txDel.objectStore(META_STORE)
    for (const hash of toEvict) {
      storeDel.delete(hash)
    }

    const freedMB = ((totalSize - currentSize) / 1024 / 1024).toFixed(1)
    console.log(
      `[BlossomCache] Pruned ${toEvict.length} entries, freed ${freedMB}MB ` +
      `(${(currentSize / 1024 / 1024).toFixed(1)}MB / ${(cacheBudgetBytes / 1024 / 1024).toFixed(0)}MB used)`
    )
  } catch {
    // Pruning is best-effort
  }
}

// ─── Stats (for debugging / settings UI) ───

/**
 * Get cache statistics: total entries and total size.
 */
export async function getCacheStats(): Promise<{ entryCount: number; totalSizeMB: number }> {
  try {
    const db = await openMetaDB()
    const tx = db.transaction(META_STORE, 'readonly')
    const store = tx.objectStore(META_STORE)
    const allReq = store.getAll()

    const entries: CacheEntryMeta[] = await new Promise((resolve, reject) => {
      allReq.onsuccess = () => resolve(allReq.result || [])
      allReq.onerror = () => reject(allReq.error)
    })

    const totalBytes = entries.reduce((sum, e) => sum + e.size, 0)
    return {
      entryCount: entries.length,
      totalSizeMB: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
    }
  } catch {
    return { entryCount: 0, totalSizeMB: 0 }
  }
}

/**
 * Clear the entire persistent cache (both blobs and metadata).
 * Useful for a "clear cache" button in settings.
 */
export async function clearPersistentCache(): Promise<void> {
  try {
    await caches.delete(CACHE_NAME)
  } catch { /* ok */ }
  try {
    const db = await openMetaDB()
    const tx = db.transaction(META_STORE, 'readwrite')
    tx.objectStore(META_STORE).clear()
  } catch { /* ok */ }
  console.log('[BlossomCache] Cache cleared')
}

// ─── Budget config (Settings UI) ───

/** Current media-cache budget in MB (0 = caching off). */
export function getCacheBudgetMB(): number {
  return Math.round(cacheBudgetBytes / 1024 / 1024)
}

/**
 * Set the media-cache budget in MB (0 = off). Persists the choice; when lowered
 * it immediately evicts the now-excess media (or clears everything at 0).
 */
export async function setCacheBudgetMB(mb: number): Promise<void> {
  const clamped = Math.max(0, Math.round(mb))
  cacheBudgetBytes = clamped * 1024 * 1024
  try { localStorage.setItem(CACHE_BUDGET_KEY, String(clamped)) } catch { /* ignore */ }
  if (clamped === 0) {
    await clearPersistentCache()
  } else {
    await pruneCache()
  }
}
