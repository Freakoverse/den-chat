/**
 * profileCacheDb — durable IndexedDB copy of kind-0 profiles, so names and avatars render instantly on
 * restart instead of flashing npub placeholders while relays are re-queried.
 *
 * The in-memory profile cache (hooks/useProfileCache) write-throughs here on every real fetch/update; on
 * launch the Map is hydrated from here (entries keep their original fetchedAt, so stale-while-revalidate
 * still refreshes anything past its TTL on next access). Newest-wins by the kind-0 `created_at`, so a stale
 * relay copy can never downgrade a newer one. Bounded at MAX_PROFILES, evicted LRU by fetchedAt.
 *
 * Only metadata (the parsed kind-0 JSON) is stored here. Avatar/banner IMAGES are handled separately by the
 * image cache + blossomMediaCache under the Settings render-size limits; this never downloads images.
 */

import type { NostrProfile } from '@/hooks/useProfileCache'

const DB_NAME = 'den-profiles'
const DB_VERSION = 1
const STORE = 'profiles'
const MAX_PROFILES = 5000
/** Run an eviction sweep once this many puts have happened in the session. */
const EVICT_EVERY = 200

export interface StoredProfile {
  pubkey: string
  profile: NostrProfile
  /** created_at of the kind-0 event (version guard). */
  createdAt?: number
  /** Date.now() when last fetched (drives SWR staleness + LRU eviction). */
  fetchedAt: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'pubkey' })
        store.createIndex('fetchedAt', 'fetchedAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

let putsSinceEvict = 0

/** Persist one profile (newest-wins by created_at). Fire-and-forget; never throws. */
export async function putProfileDb(entry: StoredProfile): Promise<void> {
  try {
    const db = await openDb()
    const existing = await new Promise<StoredProfile | undefined>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(entry.pubkey)
      r.onsuccess = () => res(r.result as StoredProfile | undefined)
      r.onerror = () => res(undefined)
    })
    // Version guard: keep the newer kind-0. When either side lacks a created_at, the fresh write wins
    // (an external update with no stamp, or first insert).
    if (existing && existing.createdAt != null && entry.createdAt != null && existing.createdAt > entry.createdAt) {
      return
    }
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry)
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
    if (++putsSinceEvict >= EVICT_EVERY) { putsSinceEvict = 0; evictOldest().catch(() => {}) }
  } catch { /* IndexedDB unavailable (private mode, etc.) — ignore */ }
}

/** Read one profile by pubkey, or undefined. Fast path for a visible profile on launch,
 *  so it resolves from disk in ms instead of waiting for the bulk getAllProfilesDb. */
export async function getProfileDb(pubkey: string): Promise<StoredProfile | undefined> {
  try {
    const db = await openDb()
    return await new Promise<StoredProfile | undefined>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(pubkey)
      r.onsuccess = () => res(r.result as StoredProfile | undefined)
      r.onerror = () => res(undefined)
    })
  } catch { return undefined }
}

/** Read every stored profile (for launch hydration). Returns [] on any failure. */
export async function getAllProfilesDb(): Promise<StoredProfile[]> {
  try {
    const db = await openDb()
    return await new Promise<StoredProfile[]>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).getAll()
      r.onsuccess = () => res((r.result as StoredProfile[]) || [])
      r.onerror = () => res([])
    })
  } catch { return [] }
}

/** Drop the least-recently-fetched profiles until at most MAX_PROFILES remain. */
export async function evictOldest(): Promise<void> {
  try {
    const db = await openDb()
    const count = await new Promise<number>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).count()
      r.onsuccess = () => res(r.result || 0)
      r.onerror = () => res(0)
    })
    if (count <= MAX_PROFILES) return
    let toDelete = count - MAX_PROFILES
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite')
      const cursorReq = tx.objectStore(STORE).index('fetchedAt').openCursor() // ascending = oldest first
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (cursor && toDelete > 0) { cursor.delete(); toDelete--; cursor.continue() }
      }
      tx.oncomplete = () => res()
      tx.onerror = () => res()
    })
  } catch { /* ignore */ }
}
