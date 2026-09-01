/**
 * hubBlobStore — durable, non-evictable local retention for a hub's member-tree blobs.
 *
 * WHY THIS EXISTS
 * A v2 hub's member list lives ONLY as content-addressed Blossom blobs (index → spine,
 * leaf pages, history, ban pages). Those are uploaded under a throwaway per-hub owner
 * pseudonym `O` that has no standing on public Blossom servers, so the servers garbage-
 * collect them. The cooperative mirror in blossomRedundancy is server-to-server: once a
 * blob is gone from EVERY server it has nothing to copy from ("missing from all servers,
 * cannot mirror") and the hub is bricked — the encrypted hub secret (in the spine) and
 * the leaf keys (in the pages) are unrecoverable for everyone, owner included.
 *
 * This store is the missing "local source of truth": whenever we write or read a hub tree
 * blob we keep its exact bytes here, so we can re-upload it even after it has vanished from
 * all servers. Blobs are content-addressed (keyed by sha256) and already encrypted, so
 * retaining them locally leaks nothing beyond what this device already handled, and a
 * re-upload reproduces the identical hash.
 *
 * Unlike the media cache (blossomMediaCache), this store is NOT LRU-evictable and carries
 * no byte budget: tree blobs are tiny (a page/spine/index is a few KB) and losing one
 * loses the hub. We only prune blobs a hub no longer references (best-effort).
 *
 * Every operation is wrapped so a missing/blocked IndexedDB (private windows, SSR, quota)
 * degrades to a no-op / null rather than throwing — durability is best-effort, never a
 * hard dependency of the read/write paths that call it.
 */

const DB_NAME = 'den-hub-blobs'
const DB_VERSION = 1
const STORE = 'blobs'

interface HubBlobRecord {
  hash: string        // sha256 hex — primary key
  bytes: Uint8Array   // the blob's exact bytes
  dTag: string        // owning hub d-tag (for pruning); '' if unknown
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'hash' })
          store.createIndex('dTag', 'dTag', { unique: false })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function reqResult<T>(req: IDBRequest): Promise<T | undefined> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => resolve(undefined)
  })
}

/**
 * Retain a hub tree blob's bytes locally, keyed by its content hash. Idempotent.
 * Pass the owning hub `dTag` so it can be pruned when the hub advances or is left.
 */
export async function cacheHubBlob(hash: string, bytes: Uint8Array, dTag = ''): Promise<void> {
  if (!hash || !bytes || bytes.length === 0) return
  try {
    const db = await openDB()
    if (!db) return
    const rec: HubBlobRecord = { hash, bytes: bytes.slice(), dTag, updatedAt: Date.now() }
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(rec)
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch { /* best-effort */ }
}

/** Retrieve a locally-retained blob's bytes by hash, or null if we don't hold it. */
export async function getCachedHubBlob(hash: string): Promise<Uint8Array | null> {
  if (!hash) return null
  try {
    const db = await openDB()
    if (!db) return null
    const tx = db.transaction(STORE, 'readonly')
    const rec = await reqResult<HubBlobRecord>(tx.objectStore(STORE).get(hash))
    if (!rec?.bytes) return null
    return rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes as ArrayBuffer)
  } catch {
    return null
  }
}

/** Whether we hold a local copy of this blob. */
export async function hasCachedHubBlob(hash: string): Promise<boolean> {
  return (await getCachedHubBlob(hash)) !== null
}

/**
 * Retrieve the locally-retained bytes as UTF-8 text (tree files are text/plain).
 * Returns null if we don't hold the blob.
 */
export async function getCachedHubText(hash: string): Promise<string | null> {
  const bytes = await getCachedHubBlob(hash)
  return bytes ? new TextDecoder().decode(bytes) : null
}

/**
 * Best-effort prune: drop every locally-retained blob for `dTag` whose hash is NOT in
 * `keepHashes`. Called after a hub's index advances so superseded pages/spines don't
 * accumulate. Keeping a few extra costs nothing (blobs are tiny), so this never runs on
 * a hot path and failures are ignored.
 */
export async function pruneHubBlobs(dTag: string, keepHashes: string[]): Promise<void> {
  if (!dTag) return
  try {
    const db = await openDB()
    if (!db) return
    const keep = new Set(keepHashes.filter(Boolean))
    const tx = db.transaction(STORE, 'readwrite')
    const idx = tx.objectStore(STORE).index('dTag')
    const cursorReq = idx.openCursor(IDBKeyRange.only(dTag))
    await new Promise<void>((resolve) => {
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor) { resolve(); return }
        const rec = cursor.value as HubBlobRecord
        if (!keep.has(rec.hash)) cursor.delete()
        cursor.continue()
      }
      cursorReq.onerror = () => resolve()
    })
  } catch { /* best-effort */ }
}

/** Drop every locally-retained blob for a hub (called when the user leaves/deletes it). */
export async function dropHubBlobs(dTag: string): Promise<void> {
  await pruneHubBlobs(dTag, [])
}
