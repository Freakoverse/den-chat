/**
 * hubEventCache — local IndexedDB copy of hub definition events (kind 36942).
 *
 * Purpose: keep a durable local copy of hubs the user has seen, so the hub's raw
 * event can still be exported (and manually rebroadcast) even if it later gets
 * wiped from every relay. Newest-wins by created_at, so a deletion tombstone
 * (a newer event with ['deleted','true']) overwrites the live copy rather than
 * the other way around.
 *
 * The loader MAY read the cached copy to DISPLAY the newest version at load time
 * (recovering a version relays only hold a stale copy of). But we NEVER auto-
 * rebroadcast from this cache — the cooperative relay redundancy only ever pushes
 * copies it finds ON RELAYS. Pushing a locally-held copy could resurrect a hub
 * deleted while this client was offline (it would hold the pre-deletion live copy,
 * not the tombstone), so propagating a local-only/newer version is always a
 * deliberate, warned, file-based user action (Settings → My Hubs).
 *
 * Retention is scoped to the hubs you're actually in. On every hub-list load the
 * loader `touchHubEvents()` the listed d tags (bumping cachedAt = last time this hub
 * was in an active list), then `pruneHubEvents()` drops events not touched within
 * RETAIN_MS. So your hubs are kept indefinitely (re-touched each launch), while hubs
 * you left and Discover/invite previews age out. cachedAt is last-in-a-list, not
 * last-modified, so a hub whose event never changes still stays fresh while you're in
 * it. The window is deliberately long and account-agnostic: each account touches its
 * own hubs when active, so a second account's hubs survive as long as you open that
 * account within RETAIN_MS — nothing is pruned just because another account is signed
 * in. A high MAX_HUB_EVENTS backstop caps pathological growth; listed hubs, being the
 * freshest, always survive the backstop cull.
 */

import type { Event } from 'nostr-tools'

const DB_NAME = 'den-hub-events'
const DB_VERSION = 1
const STORE = 'events'

/** Keep a hub event this long after the last time its hub was seen in a hub list. */
const RETAIN_MS = 60 * 24 * 60 * 60 * 1000 // 60 days
/** Backstop cap on total cached hub events (far above any real membership count). */
const MAX_HUB_EVENTS = 500

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'addr' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

const addrOf = (kind: number, pubkey: string, dTag: string) => `${kind}:${pubkey}:${dTag}`

interface StoredHubEvent { addr: string; event: Event; cachedAt: number }

/** Cache a hub event locally (newest-wins). Fire-and-forget; never throws. */
export async function putHubEvent(event: Event): Promise<void> {
  try {
    const dTag = event.tags.find((t) => t[0] === 'd')?.[1]
    if (dTag === undefined) return
    const addr = addrOf(event.kind, event.pubkey, dTag)
    const db = await openDb()

    const existing = await new Promise<StoredHubEvent | undefined>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(addr)
      r.onsuccess = () => res(r.result as StoredHubEvent | undefined)
      r.onerror = () => res(undefined)
    })
    // Newest-wins — keep the most recent version (a deletion tombstone included).
    if (existing?.event && existing.event.created_at >= event.created_at) return

    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ addr, event, cachedAt: Date.now() } satisfies StoredHubEvent)
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
  } catch { /* IndexedDB unavailable (private mode, etc.) — ignore */ }
}

/** Read every stored record (addr + event + cachedAt). Returns [] on any failure. */
async function getAllStored(db: IDBDatabase): Promise<StoredHubEvent[]> {
  return await new Promise<StoredHubEvent[]>((res) => {
    const tx = db.transaction(STORE, 'readonly')
    const r = tx.objectStore(STORE).getAll()
    r.onsuccess = () => res((r.result as StoredHubEvent[] | undefined) ?? [])
    r.onerror = () => res([])
  })
}

const dTagOf = (event: Event) => event.tags.find((t) => t[0] === 'd')?.[1]

/**
 * Mark the hubs in `dTags` as still in use (bump cachedAt to now), so pruneHubEvents
 * keeps them. Call on every hub-list load with the listed d tags. Fire-and-forget.
 */
export async function touchHubEvents(dTags: string[]): Promise<void> {
  if (dTags.length === 0) return
  try {
    const keep = new Set(dTags)
    const now = Date.now()
    const db = await openDb()
    const all = await getAllStored(db)
    const stale = all.filter((s) => { const d = dTagOf(s.event); return d !== undefined && keep.has(d) && s.cachedAt < now })
    if (stale.length === 0) return
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      for (const s of stale) store.put({ ...s, cachedAt: now })
      tx.oncomplete = () => res()
      tx.onerror = () => res()
    })
  } catch { /* IndexedDB unavailable — ignore */ }
}

/**
 * Drop cached hub events not seen in a list within RETAIN_MS, and (backstop) the
 * oldest beyond MAX_HUB_EVENTS. Call right after touchHubEvents on a hub-list load.
 * Fire-and-forget; never throws.
 */
export async function pruneHubEvents(retainMs = RETAIN_MS, maxCount = MAX_HUB_EVENTS): Promise<void> {
  try {
    const db = await openDb()
    const all = await getAllStored(db)
    const cutoff = Date.now() - retainMs
    const toDelete = new Set(all.filter((s) => s.cachedAt < cutoff).map((s) => s.addr))
    // Backstop: if too many survive the age check, drop the oldest among them.
    const survivors = all.filter((s) => !toDelete.has(s.addr))
    if (survivors.length > maxCount) {
      survivors.sort((a, b) => a.cachedAt - b.cachedAt) // oldest first
      for (const s of survivors.slice(0, survivors.length - maxCount)) toDelete.add(s.addr)
    }
    if (toDelete.size === 0) return
    await new Promise<void>((res) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      for (const addr of toDelete) store.delete(addr)
      tx.oncomplete = () => res()
      tx.onerror = () => res()
    })
  } catch { /* IndexedDB unavailable — ignore */ }
}

/**
 * All cached hub events. Used at load time to recover the newest version of a hub
 * when relays only return a stale copy (or the fresh copy lives on an unreachable
 * relay) — matched by d tag, since the author pubkey isn't known up front. This is
 * a read for DISPLAY only; it never triggers a rebroadcast.
 */
export async function getAllHubEvents(): Promise<Event[]> {
  try {
    const db = await openDb()
    return await new Promise<Event[]>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).getAll()
      r.onsuccess = () => res(((r.result as StoredHubEvent[] | undefined) ?? []).map((s) => s.event))
      r.onerror = () => res([])
    })
  } catch { return [] }
}

/** Read a cached hub event, or null if not cached / unavailable. */
export async function getHubEvent(kind: number, pubkey: string, dTag: string): Promise<Event | null> {
  try {
    const db = await openDb()
    return await new Promise<Event | null>((res) => {
      const tx = db.transaction(STORE, 'readonly')
      const r = tx.objectStore(STORE).get(addrOf(kind, pubkey, dTag))
      r.onsuccess = () => res((r.result as StoredHubEvent | undefined)?.event ?? null)
      r.onerror = () => res(null)
    })
  } catch { return null }
}
